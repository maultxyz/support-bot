import { EmbedBuilder, type AnyThreadChannel, type Client } from "discord.js";
import { config } from "./config.js";
import { links, posts, type IssueLink } from "./db.js";
import { Colors, ensureOpen, issueStatus, truncate, updateThread } from "./discord/util.js";
import { getIssueCloser, repoKey, resolveShippedIssues, SYNC_MARKER, type IssueCloser } from "./github.js";
import { consumeExpectedEvent, logWarning } from "./sync.js";

// Only the fields this bot reads from GitHub's webhook payloads.
interface GithubUser {
  login: string;
  avatar_url: string;
  html_url: string;
}

interface WebhookPayload {
  action: string;
  issue?: {
    number: number;
    title: string;
    html_url: string;
    state_reason?: string | null;
    pull_request?: unknown;
  };
  comment?: { body: string; html_url: string; user: GithubUser };
  assignee?: GithubUser | null;
  release?: {
    tag_name: string;
    name: string | null;
    html_url: string;
    body: string | null;
    draft: boolean;
    prerelease: boolean;
  };
  repository: { full_name: string };
  sender: GithubUser;
}

type IssuePayload = WebhookPayload & { issue: NonNullable<WebhookPayload["issue"]> };

export async function handleGithubEvent(client: Client, event: string, payload: WebhookPayload) {
  const repo = payload.repository?.full_name;
  if (!repo) return;

  if (event === "release" && payload.action === "published") return onReleasePublished(client, repo, payload);

  const issue = payload.issue;
  if (!issue || issue.pull_request) return;

  const link = links.byIssue(repo, issue.number);
  if (!link) {
    console.log(`No Discord post is linked to ${repo}#${issue.number}; ignoring`);
    return;
  }

  if (event === "issues" && (payload.action === "deleted" || payload.action === "transferred")) {
    links.removeByIssue(repo, issue.number);
    return;
  }

  const handler =
    event === "issues" && payload.action === "closed" ? onIssueClosed
    : event === "issues" && payload.action === "reopened" ? onIssueReopened
    : event === "issues" && payload.action === "assigned" ? onIssueAssigned
    : event === "issue_comment" && payload.action === "created" ? onIssueComment
    : null;
  if (!handler) return;

  const thread = await fetchThread(client, link);
  if (thread) await handler(thread, link, { ...payload, issue });
}

async function fetchThread(client: Client, link: IssueLink) {
  const channel = await client.channels.fetch(link.threadId).catch(() => null);
  if (channel?.isThread()) return channel;
  console.warn(`Linked thread ${link.threadId} for issue #${link.issueNumber} is no longer accessible`);
  return null;
}

/** Mention for whoever opened the post, so they're notified about the outcome. */
function authorMention(thread: AnyThreadChannel) {
  const authorId = posts.get(thread.id)?.authorId ?? thread.ownerId;
  return authorId
    ? { content: `<@${authorId}>`, allowedMentions: { users: [authorId] } }
    : { allowedMentions: { parse: [] } };
}

function closerLine(closer: IssueCloser) {
  return closer.type === "pull_request"
    ? `Fixed by [#${closer.number}: ${truncate(closer.title, 200)}](${closer.url}).`
    : `Fixed by commit [\`${closer.sha}\`](${closer.url}).`;
}

type Handler = (thread: AnyThreadChannel, link: IssueLink, payload: IssuePayload) => Promise<void>;

const CLOSE_LABEL: Record<string, string> = {
  completed: "completed",
  not_planned: "closed as not planned",
  duplicate: "closed as a duplicate",
};

const onIssueClosed: Handler = async (thread, link, { issue, sender }) => {
  // The bot closed it from /resolve; the post has already been handled.
  if (consumeExpectedEvent(`closed:${link.repo}#${link.issueNumber}`)) return;

  const status = issueStatus({ state: "closed", state_reason: issue.state_reason });
  const completed = status === "ADDED";
  const closer = completed
    ? await getIssueCloser(link.repo, issue.number).catch((error) => {
        logWarning("look up what closed the issue")(error);
        return null;
      })
    : null;

  const lines = [truncate(issue.title, 3000)];
  if (closer) lines.push("", closerLine(closer));
  lines.push("", "This post is now closed.");

  await ensureOpen(thread);
  await thread.send({
    ...(completed ? authorMention(thread) : { allowedMentions: { parse: [] } }),
    embeds: [
      new EmbedBuilder()
        .setColor(completed ? Colors.merged : Colors.muted)
        .setAuthor({ name: sender.login, iconURL: sender.avatar_url, url: sender.html_url })
        .setTitle(`Issue #${issue.number} ${CLOSE_LABEL[issue.state_reason ?? ""] ?? "closed"}`)
        .setURL(issue.html_url)
        .setDescription(lines.join("\n")),
    ],
  });

  posts.markClosed(thread.id, completed ? "added" : "rejected");
  await updateThread(thread, {
    status,
    archived: true,
    reason: `GitHub issue #${issue.number} closed`,
  });
};

const onIssueReopened: Handler = async (thread, _link, { issue, sender }) => {
  posts.markReopened(thread.id);
  await updateThread(thread, {
    status: "PENDING",
    removeTags: [config.RESOLVED_TAG_NAME],
    archived: false,
    reason: `GitHub issue #${issue.number} reopened`,
  });
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.success)
        .setAuthor({ name: sender.login, iconURL: sender.avatar_url, url: sender.html_url })
        .setTitle(`Issue #${issue.number} reopened`)
        .setURL(issue.html_url)
        .setDescription(truncate(issue.title, 4096)),
    ],
  });
};

const onIssueAssigned: Handler = async (thread, _link, { issue, assignee, sender }) => {
  if (!assignee) return;

  const selfAssigned = assignee.login === sender.login;
  await ensureOpen(thread);
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.brand)
        .setAuthor({ name: assignee.login, iconURL: assignee.avatar_url, url: assignee.html_url })
        .setTitle(`${assignee.login} is working on this`)
        .setURL(issue.html_url)
        .setDescription(
          selfAssigned
            ? `Assigned to issue #${issue.number}.`
            : `Assigned to issue #${issue.number} by ${sender.login}.`,
        ),
    ],
  });
};

const onIssueComment: Handler = async (thread, _link, { issue, comment }) => {
  if (!comment || comment.body.includes(SYNC_MARKER)) return; // written by this bot

  // A maintainer commenting on the issue counts as a staff response to the post.
  posts.markStaffReply(thread.id);
  if (!config.MIRROR_GITHUB_COMMENTS) return;

  const body = comment.body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!body) return;

  await ensureOpen(thread);
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.brand)
        .setAuthor({ name: comment.user.login, iconURL: comment.user.avatar_url, url: comment.user.html_url })
        .setTitle(`New comment on #${issue.number}`)
        .setURL(comment.html_url)
        .setDescription(truncate(body, 4096)),
    ],
  });
};

/** Most issues and pull requests looked up per release. */
const MAX_RELEASE_REFERENCES = 50;

/** Issue and pull request numbers in this repo that release notes mention, as `#12` or a full URL. */
export function referencedNumbers(repo: string, notes: string) {
  const numbers = new Set<number>();
  for (const match of notes.matchAll(/(?<![\w/&])#(\d+)\b/g)) numbers.add(Number(match[1]));

  const urlPattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/g;
  for (const match of notes.matchAll(urlPattern)) {
    if (repoKey(match[1]!) === repoKey(repo)) numbers.add(Number(match[2]));
  }
  return [...numbers].slice(0, MAX_RELEASE_REFERENCES);
}

/** Tells linked posts that a release shipped their fix, via the issues and PRs its notes mention. */
async function onReleasePublished(client: Client, repo: string, { release }: WebhookPayload) {
  if (!release || release.draft) return;

  const numbers = referencedNumbers(repo, release.body ?? "");
  const shipped = await resolveShippedIssues(repo, numbers);
  const name = release.name || release.tag_name;

  for (const issue of shipped) {
    const link = links.byIssue(issue.repo, issue.number);
    if (!link) continue;
    const thread = await fetchThread(client, link);
    if (!thread) continue;

    const wasArchived = thread.archived ?? false;
    await ensureOpen(thread);
    await thread.send({
      ...authorMention(thread),
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.merged)
          .setTitle(`🚀 ${release.prerelease ? "Available in pre-release" : "Shipped in"} ${truncate(name, 200)}`)
          .setURL(release.html_url)
          .setDescription(`[#${issue.number}](${link.issueUrl}) is included in this release.`),
      ],
    });
    // Leave a closed post closed.
    if (wasArchived) await thread.setArchived(true).catch(logWarning("re-close post"));
  }
}
