import {
  EmbedBuilder,
  RESTJSONErrorCodes,
  time,
  TimestampStyles,
  type AnyThreadChannel,
  type Client,
  type Message,
  type User,
} from "discord.js";
import { config, type IssueKind } from "./config.js";
import { guildSettings, links, posts } from "./db.js";
import {
  Colors,
  ensureOpen,
  isStaffMember,
  KIND_LABEL,
  reactivateButton,
  truncate,
  updateThread,
} from "./discord/util.js";
import * as github from "./github.js";
import { logWarning } from "./sync.js";

/** Starts tracking a new post in a managed forum, for unanswered alerts and /stats. */
export function trackPost(thread: AnyThreadChannel, kind: IssueKind) {
  if (!thread.parentId || !thread.ownerId) return;
  posts.create({
    threadId: thread.id,
    guildId: thread.guildId,
    forumId: thread.parentId,
    kind,
    authorId: thread.ownerId,
    createdAt: thread.createdTimestamp ?? Date.now(),
    tagIds: thread.appliedTags.join(","),
  });
}

/** `close_reason` of posts the bot closed because their author stopped replying. */
export const INACTIVE_REASON = "inactive";

/**
 * Records replies in a tracked post from its author or from staff. An author writing in a post that
 * was closed for inactivity reopens it; Discord has already unarchived it by then.
 */
export async function recordReply(message: Message) {
  if (message.author.bot || message.system || !message.channel.isThread()) return;
  const post = posts.get(message.channelId);
  if (!post) return;

  if (message.author.id === post.authorId) {
    posts.markAuthorReply(post.threadId, message.createdTimestamp);
    if (post.closeReason === INACTIVE_REASON) await reactivatePost(message.channel, message.author);
  } else if (message.member && isStaffMember(message.member, message.channel)) {
    posts.markStaffReply(post.threadId, message.createdTimestamp);
  }
}

/** Reopens a post closed for inactivity and gives its author a fresh window to reply. */
export async function reactivatePost(thread: AnyThreadChannel, actor: User) {
  posts.markReopened(thread.id);
  posts.markAuthorReply(thread.id);
  await updateThread(thread, {
    removeTags: [config.RESOLVED_TAG_NAME],
    archived: false,
    reason: `Reactivated by ${actor.username}`,
  });
}

// --- Votes -------------------------------------------------------------------

/** Distinct members, other than the author and bots, who reacted to a post's starter message. */
async function countVotes(starter: Message) {
  const voters = new Set<string>();
  for (const reaction of starter.reactions.cache.values()) {
    let after: string | undefined;
    for (;;) {
      const users = await reaction.users.fetch({ limit: 100, after });
      for (const user of users.values()) {
        if (!user.bot && user.id !== starter.author.id) voters.add(user.id);
      }
      if (users.size < 100) break;
      after = users.lastKey();
    }
  }
  return voters.size;
}

async function syncVotes(client: Client, threadId: string) {
  const post = posts.get(threadId);
  const link = links.byThread(threadId);
  if ((link?.kind ?? post?.kind) !== "feature") return;

  const thread = await client.channels.fetch(threadId).catch(() => null);
  if (!thread?.isThread()) return;
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (!starter) return;

  const votes = await countVotes(starter);
  if (post) posts.setVotes(threadId, votes);
  if (link) await github.setIssueVotes(link.repo, link.issueNumber, votes);
}

const pendingVoteSyncs = new Map<string, NodeJS.Timeout>();

/**
 * Recounts a feature request's votes shortly after its starter message's reactions change.
 * Bursts of reactions are batched into one recount and at most one GitHub edit.
 */
export function scheduleVoteSync(client: Client, message: { id: string; channelId: string }) {
  // In forum posts the starter message shares the thread's ID.
  if (message.id !== message.channelId) return;
  const threadId = message.channelId;

  clearTimeout(pendingVoteSyncs.get(threadId));
  pendingVoteSyncs.set(
    threadId,
    setTimeout(() => {
      pendingVoteSyncs.delete(threadId);
      syncVotes(client, threadId).catch(logWarning("sync votes"));
    }, 15_000).unref(),
  );
}

// --- Scheduled checks ----------------------------------------------------------

const CHECK_INTERVAL = 5 * 60_000;

/** Runs unanswered-post alerts and inactive-post closing every few minutes. */
export function startScheduledChecks(client: Client<true>) {
  const run = async () => {
    await checkUnanswered(client).catch(logWarning("check for unanswered posts"));
    await closeInactivePosts(client).catch(logWarning("close inactive posts"));
  };
  setInterval(() => void run(), CHECK_INTERVAL).unref();
  void run();
}

/** Fetches a tracked post's thread, forgetting the post if Discord says it's gone. */
async function fetchTrackedThread(client: Client<true>, threadId: string) {
  const channel = await client.channels.fetch(threadId).catch((error: { code?: number }) => {
    if (error.code === RESTJSONErrorCodes.UnknownChannel) posts.remove(threadId);
    return null;
  });
  return channel?.isThread() ? channel : null;
}

// --- Inactive posts ------------------------------------------------------------

/** Most posts closed per server per check, to stay well clear of rate limits. */
const MAX_CLOSES_PER_CHECK = 25;

async function closeInactivePosts(client: Client<true>) {
  const now = Date.now();
  for (const settings of guildSettings.withAutoClose()) {
    if (!settings.autoCloseAfterMins || !client.guilds.cache.has(settings.guildId)) continue;

    const due = posts.awaitingAuthor(settings.guildId, now - settings.autoCloseAfterMins * 60_000);
    for (const post of due.slice(0, MAX_CLOSES_PER_CHECK)) {
      const thread = await fetchTrackedThread(client, post.threadId);
      if (!thread || thread.locked) continue;

      await closeInactivePost(thread, settings.autoCloseAfterMins).catch(logWarning(`close inactive post ${thread.id}`));
    }
  }
}

async function closeInactivePost(thread: AnyThreadChannel, afterMins: number) {
  await ensureOpen(thread);
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.muted)
        .setTitle("💤 Closed for inactivity")
        .setDescription(
          `There's been no reply here for ${formatDuration(afterMins * 60_000)} since the team last answered, ` +
            "so this post has been closed.\n\nStill need help? Press **Reactivate** or send a message here.",
        ),
    ],
    components: [reactivateButton()],
  });

  posts.markClosed(thread.id, INACTIVE_REASON);
  await updateThread(thread, {
    addTags: [config.RESOLVED_TAG_NAME],
    archived: true,
    reason: "No reply from the author",
  });
}

// --- Unanswered alerts ---------------------------------------------------------

/** Posts older than this are never alerted about, so turning alerts on doesn't flood the channel with old posts. */
const ALERT_MAX_AGE = 7 * 24 * 60 * 60_000;
const MAX_POSTS_PER_ALERT = 10;

async function checkUnanswered(client: Client<true>) {
  const now = Date.now();
  for (const settings of guildSettings.withAlerts()) {
    const guild = client.guilds.cache.get(settings.guildId);
    if (!guild || !settings.alertChannelId || !settings.alertAfterMins) continue;

    const due = posts
      .unanswered(guild.id, now - settings.alertAfterMins * 60_000)
      .filter((post) => post.createdAt >= now - ALERT_MAX_AGE);
    if (due.length === 0) continue;

    const channel = await guild.channels.fetch(settings.alertChannelId).catch(() => null);
    if (!channel?.isSendable()) {
      console.warn(`Alert channel ${settings.alertChannelId} in ${guild.name} is missing or not sendable`);
      continue;
    }

    const lines: string[] = [];
    for (const post of due.slice(0, MAX_POSTS_PER_ALERT)) {
      const thread = await fetchTrackedThread(client, post.threadId);
      if (!thread) continue;

      posts.markAlerted(post.threadId, now);
      lines.push(
        `**${truncate(thread.name, 90)}** ${thread} · ${KIND_LABEL[post.kind]} by <@${post.authorId}> · ` +
          `opened ${time(Math.floor(post.createdAt / 1000), TimestampStyles.RelativeTime)}`,
      );
    }
    if (lines.length === 0) continue;

    const role = settings.alertRoleId;
    const remaining = due.length - lines.length;
    await channel.send({
      content: role ? `<@&${role}>` : undefined,
      allowedMentions: { roles: role ? [role] : [], users: [] },
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.muted)
          .setTitle(lines.length === 1 ? "A post is waiting for a reply" : `${lines.length} posts are waiting for a reply`)
          .setDescription(
            lines.join("\n") + (remaining > 0 ? `\n\n…and ${remaining} more, listed in the next check.` : ""),
          )
          .setFooter({ text: `No staff reply after ${formatDuration(settings.alertAfterMins * 60_000)}` }),
      ],
    });
  }
}

/** e.g. 45m, 3h 20m, 2d 4h. */
export function formatDuration(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
