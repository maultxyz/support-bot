import type { AnyThreadChannel, Message, User } from "discord.js";
import { config, type IssueKind } from "./config.js";
import { links, posts, type IssueLink } from "./db.js";
import {
  appliedTopicNames,
  issueStatus,
  KIND_LABEL,
  truncate,
  updateThread,
  type PostStatus,
} from "./discord/util.js";
import * as github from "./github.js";

/** An expected failure whose message is safe to show to the Discord user. */
export class SyncError extends Error {}

// GitHub sends webhooks for changes the bot makes itself. Remember those briefly
// so the webhook handler doesn't announce them in Discord a second time.
const expectedEvents = new Set<string>();

export function expectGithubEvent(key: string) {
  expectedEvents.add(key);
  setTimeout(() => expectedEvents.delete(key), 60_000).unref();
}

export function consumeExpectedEvent(key: string) {
  return expectedEvents.delete(key);
}

// Guards against two staff members creating an issue for the same thread at once.
const inFlight = new Set<string>();

async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(threadId)) throw new SyncError("This thread is already being synced, try again in a moment.");
  inFlight.add(threadId);
  try {
    return await fn();
  } finally {
    inFlight.delete(threadId);
  }
}

function assertUnlinked(threadId: string) {
  const existing = links.byThread(threadId);
  if (existing) {
    throw new SyncError(
      `This thread is already linked to [${existing.repo}#${existing.issueNumber}](${existing.issueUrl}).`,
    );
  }
}

function attachmentLines(message: Message) {
  return message.attachments.map((a) => `- [${a.name}](${a.url})`);
}

export async function createIssueForThread(
  thread: AnyThreadChannel,
  kind: IssueKind,
  repo: string,
  actor: User,
  title?: string,
): Promise<IssueLink> {
  return withThreadLock(thread.id, async () => {
    assertUnlinked(thread.id);

    const starter = await thread.fetchStarterMessage().catch(() => null);
    const body = [starter?.cleanContent.trim() || "_No description provided._"];

    if (starter?.attachments.size) {
      body.push("", "**Attachments**", ...attachmentLines(starter));
    }
    body.push(
      "",
      "---",
      `<sub>${KIND_LABEL[kind]} from Discord: [${thread.name}](${thread.url}) · ` +
        `opened by **${starter?.author.username ?? "unknown"}** · synced by **${actor.username}**</sub>`,
    );

    const votes = posts.get(thread.id)?.votes ?? 0;
    if (kind === "feature" && votes > 0) body.push("", github.votesSection(votes));

    const issue = await github.createIssue(repo, {
      title: title ?? thread.name,
      body: truncate(body.join("\n"), 60_000),
      labels: [
        ...new Set([
          ...(kind === "feature" ? config.FEATURE_LABELS : config.SUPPORT_LABELS),
          ...appliedTopicNames(thread),
        ]),
      ],
    });

    const link = links.create({
      threadId: thread.id,
      guildId: thread.guildId,
      repo,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      kind,
      createdBy: actor.id,
    });

    await updateThread(thread, { status: "PENDING" }).catch(
      logWarning("update post status"),
    );
    return link;
  });
}

export async function linkExistingIssue(
  thread: AnyThreadChannel,
  kind: IssueKind,
  repo: string,
  issueNumber: number,
  actor: User,
): Promise<IssueLink> {
  return withThreadLock(thread.id, async () => {
    assertUnlinked(thread.id);

    const other = links.byIssue(repo, issueNumber);
    if (other) throw new SyncError(`Issue #${issueNumber} is already linked to <#${other.threadId}>.`);

    const issue = await github.getIssue(repo, issueNumber);
    if (!issue) throw new SyncError(`Issue #${issueNumber} was not found in ${repo}.`);
    if (issue.pull_request) throw new SyncError(`#${issueNumber} is a pull request, not an issue.`);

    const link = links.create({
      threadId: thread.id,
      guildId: thread.guildId,
      repo,
      issueNumber,
      issueUrl: issue.html_url,
      kind,
      createdBy: actor.id,
    });

    await github.commentOnIssue(
      repo,
      issueNumber,
      `🔗 Linked to Discord ${KIND_LABEL[kind]} [${thread.name}](${thread.url}) by **${actor.username}**.`,
    );
    await github.addLabels(repo, issueNumber, appliedTopicNames(thread)).catch(logWarning("add topic labels"));
    if (kind === "feature") {
      const votes = posts.get(thread.id)?.votes ?? 0;
      if (votes > 0) await github.setIssueVotes(repo, issueNumber, votes).catch(logWarning("sync votes"));
    }
    await updateThread(thread, { status: issueStatus(issue) }).catch(
      logWarning("update post status"),
    );
    return link;
  });
}

export async function unlinkThread(thread: AnyThreadChannel): Promise<IssueLink> {
  const link = links.byThread(thread.id);
  if (!link) throw new SyncError("This thread isn't linked to a GitHub issue.");
  links.removeByThread(thread.id);
  await updateThread(thread, { status: null }).catch(
    logWarning("clear post status"),
  );
  return link;
}

export type CloseReason = "completed" | "not_planned";

/**
 * Optionally closes the linked issue and works out the post's resulting status.
 * Closing the post itself is left to the caller so it can reply to the interaction first.
 */
export async function resolveThread(
  thread: AnyThreadChannel,
  actor: User,
  options: { closeIssue: boolean; reason: CloseReason; label: string },
) {
  const link = links.byThread(thread.id);
  let closedIssue = false;
  let status: PostStatus | undefined;

  if (link) {
    const issue = await github.getIssue(link.repo, link.issueNumber);
    if (issue?.state === "open" && options.closeIssue) {
      const rejected = options.reason === "not_planned";
      await github.commentOnIssue(
        link.repo,
        link.issueNumber,
        `${rejected ? "🚫" : "✅"} Closed as **${options.label}** on Discord by **${actor.username}**.`,
      );
      expectGithubEvent(`closed:${link.repo}#${link.issueNumber}`);
      await github.closeIssue(link.repo, link.issueNumber, options.reason);
      closedIssue = true;
      status = rejected ? "REJECTED" : "ADDED";
    } else if (issue) {
      status = issueStatus(issue);
    }
  }

  return { link, closedIssue, status };
}

/**
 * Adds GitHub labels for topic tags newly applied to a linked post, whether picked from the
 * welcome menu or edited by hand. Removing a tag leaves the label alone so GitHub-side triage isn't undone.
 */
export async function syncTopicLabels(oldThread: AnyThreadChannel, newThread: AnyThreadChannel) {
  const link = links.byThread(newThread.id);
  if (!link) return;

  const before = appliedTopicNames(newThread, oldThread.appliedTags);
  const added = appliedTopicNames(newThread).filter((name) => !before.includes(name));
  await github.addLabels(link.repo, link.issueNumber, added);
}

/** Mirrors a Discord reply in a linked thread as a GitHub issue comment. */
export async function mirrorMessageToIssue(message: Message) {
  if (!config.MIRROR_DISCORD_MESSAGES) return;
  if (message.author.bot || message.system || !message.channel.isThread()) return;
  // In forum posts the starter message shares the thread's ID; it's already the issue body.
  if (message.id === message.channelId) return;

  const link = links.byThread(message.channelId);
  if (!link) return;

  const content = message.cleanContent.trim();
  const attachments = attachmentLines(message);
  if (!content && attachments.length === 0) return;

  const author = message.member?.displayName ?? message.author.username;
  const body = [`**${author}** [replied on Discord](${message.url}):`, ""];
  if (content) body.push(content.split("\n").map((line) => `> ${line}`).join("\n"));
  if (attachments.length) body.push("", ...attachments);

  await github.commentOnIssue(link.repo, link.issueNumber, truncate(body.join("\n"), 60_000));
}

export function logWarning(action: string) {
  return (error: unknown) => console.warn(`Failed to ${action}:`, error);
}
