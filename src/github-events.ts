import { EmbedBuilder, type AnyThreadChannel, type Client } from "discord.js";
import { config } from "./config.js";
import { links, type IssueLink } from "./db.js";
import { Colors, ensureOpen, setTag, truncate } from "./discord/util.js";
import { repoSlug, SYNC_MARKER } from "./github.js";
import { consumeExpectedEvent, logWarning } from "./sync.js";

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
  repository: { full_name: string };
  sender: GithubUser;
}

export async function handleGithubEvent(client: Client, event: string, payload: IssuesPayload) {
  if (payload.repository?.full_name.toLowerCase() !== repoSlug) return;
  if (!payload.issue || payload.issue.pull_request) return;

  const link = links.byIssue(repoSlug, payload.issue.number);
  if (!link) return;

  if (event === "issues" && payload.action === "deleted") {
    links.removeByIssue(repoSlug, payload.issue.number);
    return;
  }

  const handler =
    event === "issues" && payload.action === "closed" ? onIssueClosed
    : event === "issues" && payload.action === "reopened" ? onIssueReopened
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

const onIssueClosed: Handler = async (thread, link, { issue, sender }) => {
  // The bot closed it from /resolve; the thread has already been handled.
  if (consumeExpectedEvent(`closed:${link.issueNumber}`)) return;

  const completed = issue.state_reason !== "not_planned";
  await ensureOpen(thread);
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(completed ? Colors.merged : Colors.muted)
        .setAuthor({ name: sender.login, iconURL: sender.avatar_url, url: sender.html_url })
        .setTitle(`Issue #${issue.number} closed${completed ? "" : " as not planned"}`)
        .setURL(issue.html_url)
        .setDescription(truncate(issue.title, 4096)),
    ],
  });

  if (config.ARCHIVE_ON_CLOSE) {
    if (completed) await setTag(thread, config.RESOLVED_TAG_NAME, true).catch(logWarning("apply resolved tag"));
    await thread.setArchived(true, `GitHub issue #${issue.number} closed`);
  }
};

const onIssueReopened: Handler = async (thread, _link, { issue, sender }) => {
  await ensureOpen(thread);
  await setTag(thread, config.RESOLVED_TAG_NAME, false).catch(logWarning("remove resolved tag"));
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
