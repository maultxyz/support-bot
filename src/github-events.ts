import { EmbedBuilder, type AnyThreadChannel, type Client } from "discord.js";
import { config } from "./config.js";
import { links, type IssueLink } from "./db.js";
import { Colors, ensureOpen, issueStatus, truncate, updateThread } from "./discord/util.js";
import { repoSlug, SYNC_MARKER } from "./github.js";
import { consumeExpectedEvent } from "./sync.js";

// Only the fields this bot reads from GitHub's webhook payloads.
interface GithubUser {
  login: string;
  avatar_url: string;
  html_url: string;
}

interface IssuesPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    html_url: string;
    state_reason?: string | null;
    pull_request?: unknown;
  };
  comment?: { body: string; html_url: string; user: GithubUser };
  assignee?: GithubUser | null;
  repository: { full_name: string };
  sender: GithubUser;
}

export async function handleGithubEvent(client: Client, event: string, payload: IssuesPayload) {
  if (payload.repository?.full_name.toLowerCase() !== repoSlug) return;
  if (!payload.issue || payload.issue.pull_request) return;

  const link = links.byIssue(repoSlug, payload.issue.number);
  if (!link) {
    console.log(`No Discord post is linked to ${repoSlug}#${payload.issue.number}; ignoring`);
    return;
  }

  if (event === "issues" && payload.action === "deleted") {
    links.removeByIssue(repoSlug, payload.issue.number);
    return;
  }

  const handler =
    event === "issues" && payload.action === "closed" ? onIssueClosed
    : event === "issues" && payload.action === "reopened" ? onIssueReopened
    : event === "issues" && payload.action === "assigned" ? onIssueAssigned
    : event === "issue_comment" && payload.action === "created" ? onIssueComment
    : null;
  if (!handler) return;

  const channel = await client.channels.fetch(link.threadId).catch(() => null);
  if (!channel?.isThread()) {
    console.warn(`Linked thread ${link.threadId} for issue #${link.issueNumber} is no longer accessible`);
    return;
  }

  await handler(channel, link, payload);
}

type Handler = (thread: AnyThreadChannel, link: IssueLink, payload: IssuesPayload) => Promise<void>;

const CLOSE_LABEL: Record<string, string> = {
  completed: "completed",
  not_planned: "closed as not planned",
  duplicate: "closed as a duplicate",
};

const onIssueClosed: Handler = async (thread, link, { issue, sender }) => {
  // The bot closed it from /resolve; the post has already been handled.
  if (consumeExpectedEvent(`closed:${link.issueNumber}`)) return;

  const status = issueStatus({ state: "closed", state_reason: issue.state_reason });
  await ensureOpen(thread);
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(status === "ADDED" ? Colors.merged : Colors.muted)
        .setAuthor({ name: sender.login, iconURL: sender.avatar_url, url: sender.html_url })
        .setTitle(`Issue #${issue.number} ${CLOSE_LABEL[issue.state_reason ?? ""] ?? "closed"}`)
        .setURL(issue.html_url)
        .setDescription(`${truncate(issue.title, 3900)}\n\nThis post is now closed.`),
    ],
  });

  await updateThread(thread, {
    status,
    archived: true,
    reason: `GitHub issue #${issue.number} closed`,
  });
};

const onIssueReopened: Handler = async (thread, _link, { issue, sender }) => {
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
  if (!config.MIRROR_GITHUB_COMMENTS || !comment) return;
  if (comment.body.includes(SYNC_MARKER)) return; // written by this bot

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
