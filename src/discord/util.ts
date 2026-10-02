import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  type AnyThreadChannel,
  type BaseInteraction,
  type Channel,
  type GuildForumTag,
  type GuildMember,
  type Message,
  type ThreadEditOptions,
} from "discord.js";
import { config, type IssueKind } from "../config.js";
import { forums, links, staffRoles, type IssueLink } from "../db.js";
import { defaultRepo, type SimilarIssue } from "../github.js";

export const Colors = {
  brand: 0x5865f2,
  success: 0x2ea043,
  merged: 0x8250df,
  muted: 0x6e7781,
} as const;

export const ComponentIds = {
  createIssue: "support:create-issue",
  resolve: "support:resolve",
  topics: "support:topics",
  /** Prefix; followed by a ResolveReason. */
  resolveAs: "support:resolve-as:",
  reactivate: "support:reactivate",
} as const;

/** Names of the welcome message's embed fields that get swapped out later. */
export const WelcomeFields = {
  topicPrompt: "🏷️ What is this about?",
  taggedAs: "🏷️ Tagged as",
} as const;

export const KIND_LABEL: Record<IssueKind, string> = {
  support: "support request",
  feature: "feature request",
};

/**
 * Returns the thread, its request kind and its forum's GitHub repo if the channel is a post in a managed forum.
 * `repo` is null when neither the forum nor GITHUB_OWNER/GITHUB_REPO set one.
 */
export function asForumThread(channel: Channel | null) {
  if (!channel?.isThread() || !channel.parentId) return null;
  const forum = forums.get(channel.parentId);
  return forum ? { thread: channel, kind: forum.kind, repo: forum.repo ?? defaultRepo } : null;
}

function hasStaffRole(guildId: string, memberRoleIds: readonly string[]) {
  const staffRoleIds = staffRoles.list(guildId);
  return memberRoleIds.some((id) => staffRoleIds.includes(id));
}

/** Staff are members with Manage Threads, or with a role added via /setup staff add. */
export function isStaff(interaction: BaseInteraction): boolean {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads)) return true;
  const roles = interaction.member?.roles;
  if (!roles || !interaction.guildId) return false;
  return hasStaffRole(interaction.guildId, Array.isArray(roles) ? roles : [...roles.cache.keys()]);
}

/** Like `isStaff`, for the author of a message in a post. */
export function isStaffMember(member: GuildMember, thread: AnyThreadChannel): boolean {
  if (thread.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads)) return true;
  return hasStaffRole(member.guild.id, [...member.roles.cache.keys()]);
}

/** Status of the GitHub issue linked to a post, shown as a forum tag. */
export type PostStatus = "PENDING" | "ADDED" | "REJECTED";

export const STATUS_TAGS: Record<PostStatus, string> = {
  PENDING: config.PENDING_TAG_NAME,
  ADDED: config.ADDED_TAG_NAME,
  REJECTED: config.REJECTED_TAG_NAME,
};

export type ResolveReason = "resolved" | "added" | "rejected";

/** Why a post was closed. Each reason is shown as a tag and decides how a linked issue is closed. */
export const RESOLVE_REASONS: Record<
  ResolveReason,
  { label: string; description: string; emoji: string; color: number; status: PostStatus | null; closeAs: "completed" | "not_planned" }
> = {
  resolved: {
    label: "Resolved",
    description: "Question answered or problem solved",
    emoji: "✅",
    color: Colors.success,
    status: null, // uses the Resolved tag
    closeAs: "completed",
  },
  added: {
    label: "Added",
    description: "Fixed or implemented",
    emoji: "🚀",
    color: Colors.merged,
    status: "ADDED",
    closeAs: "completed",
  },
  rejected: {
    label: "Rejected",
    description: "Won't be done",
    emoji: "🚫",
    color: Colors.muted,
    status: "REJECTED",
    closeAs: "not_planned",
  },
};

/** Staff-only picker shown when staff press "Mark resolved". */
/** Shown on the message that closes an inactive post. */
export function reactivateButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(ComponentIds.reactivate)
      .setLabel("Reactivate")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Primary),
  );
}

export function resolveReasonPicker() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    Object.entries(RESOLVE_REASONS).map(([reason, info]) =>
      new ButtonBuilder()
        .setCustomId(`${ComponentIds.resolveAs}${reason}`)
        .setLabel(`${info.label}: ${info.description}`)
        .setEmoji(info.emoji)
        .setStyle(reason === "rejected" ? ButtonStyle.Danger : reason === "added" ? ButtonStyle.Primary : ButtonStyle.Success),
    ),
  );
}

/** Maps a GitHub issue's state to the post status. */
export function issueStatus(issue: { state: string; state_reason?: string | null }): PostStatus {
  if (issue.state === "open") return "PENDING";
  return issue.state_reason === "not_planned" || issue.state_reason === "duplicate" ? "REJECTED" : "ADDED";
}

function tagIds(thread: AnyThreadChannel, names: string[]) {
  const parent = thread.parent;
  if (!parent || !("availableTags" in parent)) return [];
  const wanted = names.map((name) => name.toLowerCase());
  return parent.availableTags.filter((tag) => wanted.includes(tag.name.toLowerCase())).map((tag) => tag.id);
}

export interface ThreadUpdate {
  /** Status tag to apply (replacing any other status tag); `null` removes them all. */
  status?: PostStatus | null;
  /** Forum tag names to add/remove. Tags the forum doesn't have are skipped. */
  addTags?: string[];
  removeTags?: string[];
  /** `true` closes the post, `false` reopens it. */
  archived?: boolean;
  reason?: string;
}

/** Applies tag and open/closed changes to a post in as few requests as possible. */
export async function updateThread(thread: AnyThreadChannel, update: ThreadUpdate) {
  const edit: ThreadEditOptions = {};

  const addNames = [...(update.addTags ?? [])];
  const removeNames = [...(update.removeTags ?? [])];
  if (update.status !== undefined) {
    for (const [status, name] of Object.entries(STATUS_TAGS)) {
      (status === update.status ? addNames : removeNames).push(name);
    }
  }

  const add = tagIds(thread, addNames);
  const remove = tagIds(thread, removeNames);
  const current = thread.appliedTags;
  // Discord allows at most 5 tags per post; never drop the author's own tags to make room.
  const next = [...current.filter((id) => !remove.includes(id))];
  for (const id of add) if (!next.includes(id) && next.length < 5) next.push(id);
  if (next.length !== current.length || next.some((id) => !current.includes(id))) edit.appliedTags = next;

  let archived = thread.archived ?? false;
  // An archived post can only be edited by a request that also reopens it.
  if (archived && edit.appliedTags && update.archived !== false) {
    await thread.setArchived(false, update.reason);
    archived = false;
  }
  if (update.archived !== undefined && update.archived !== archived) edit.archived = update.archived;

  if (Object.keys(edit).length) await thread.edit({ ...edit, reason: update.reason });
}

/** Unarchives a thread so the bot can post in it and edit its tags. */
export async function ensureOpen(thread: AnyThreadChannel) {
  if (thread.archived) await thread.setArchived(false);
}

export function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function linkEmbed(link: IssueLink, title: string) {
  return new EmbedBuilder()
    .setColor(Colors.success)
    .setTitle(title)
    .setURL(link.issueUrl)
    .setDescription(
      `This ${KIND_LABEL[link.kind]} is tracked as **[${link.repo}#${link.issueNumber}](${link.issueUrl})**.\n` +
        "Updates from GitHub will be posted in this thread.",
    );
}

/** Tags the bot manages itself; everything else non-moderated in a forum is a topic tag. */
const BOT_TAG_NAMES = [...Object.values(STATUS_TAGS), config.RESOLVED_TAG_NAME].map((name) => name.toLowerCase());

/** Discord allows 5 tags per post; leave one slot for the status/resolved tag. */
const MAX_TOPICS = 4;

export function isTopicTag(tag: GuildForumTag) {
  return !tag.moderated && !BOT_TAG_NAMES.includes(tag.name.toLowerCase());
}

/** Forum tags members can pick to say what a post is about (e.g. 3D Model, Web, Server). */
export function topicTags(thread: AnyThreadChannel): GuildForumTag[] {
  const parent = thread.parent;
  if (!parent || !("availableTags" in parent)) return [];
  return parent.availableTags.filter(isTopicTag);
}

/** Names of the topic tags applied to a post, used as GitHub labels. */
export function appliedTopicNames(thread: AnyThreadChannel, appliedTags = thread.appliedTags) {
  return topicTags(thread)
    .filter((tag) => appliedTags.includes(tag.id))
    .map((tag) => tag.name);
}

/** Replaces the post's topic tags with `tagIds`, keeping status and other tags. */
export async function setTopicTags(thread: AnyThreadChannel, tagIds: string[]) {
  const topicIds = topicTags(thread).map((tag) => tag.id);
  const kept = thread.appliedTags.filter((id) => !topicIds.includes(id));
  const chosen = tagIds.filter((id) => topicIds.includes(id)).slice(0, MAX_TOPICS);
  await thread.setAppliedTags([...kept, ...chosen].slice(0, 5));
  return topicTags(thread).filter((tag) => chosen.includes(tag.id));
}

function topicMenu(tags: GuildForumTag[]) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(ComponentIds.topics)
      .setPlaceholder("What is this about? Pick the tags that fit")
      .setMinValues(1)
      .setMaxValues(Math.min(tags.length, MAX_TOPICS))
      .addOptions(
        tags.slice(0, 25).map((tag) => ({
          label: tag.name,
          value: tag.id,
          emoji: tag.emoji?.id ? { id: tag.emoji.id } : tag.emoji?.name ? { name: tag.emoji.name } : undefined,
        })),
      ),
  );
}

/** Removes one component (by custom ID) from a message, dropping rows that end up empty. */
export function withoutComponent(message: Message, customId: string) {
  return message.components
    .map((row) => row.toJSON())
    .map((row) =>
      row.type === ComponentType.ActionRow
        ? { ...row, components: row.components.filter((c) => !("custom_id" in c) || c.custom_id !== customId) }
        : row,
    )
    .filter((row) => row.type !== ComponentType.ActionRow || row.components.length > 0);
}

/** One line per similar issue, linking the Discord post it's tracked in when that's in the same server. */
function similarIssueLines(thread: AnyThreadChannel, repo: string, similar: SimilarIssue[]) {
  return similar.map((issue) => {
    const link = links.byIssue(repo, issue.number);
    const post = link && link.guildId === thread.guildId && link.threadId !== thread.id ? ` · <#${link.threadId}>` : "";
    const state = issue.open ? "open" : "closed";
    return `[#${issue.number}](${issue.url}) ${truncate(issue.title, 80)} (${state})${post}`;
  });
}

export function welcomeMessage(
  kind: IssueKind,
  thread: AnyThreadChannel,
  related?: { repo: string; similar: SimilarIssue[] },
) {
  const topics = topicTags(thread);
  const topicIds = topics.map((tag) => tag.id);
  // Only ask for topics if the forum has some and the author didn't already pick one.
  const askForTopics = topics.length > 0 && !thread.appliedTags.some((id) => topicIds.includes(id));

  const embed = new EmbedBuilder()
    .setColor(Colors.brand)
    .setTitle(kind === "support" ? "Thanks for reaching out!" : "Thanks for the suggestion!")
    .setDescription(
      kind === "support"
        ? "A team member will be with you soon. Please include any error messages, screenshots, " +
            "and steps to reproduce if you haven't already.\n\n" +
            "Once your problem is solved, press **Mark resolved** or use `/resolve`."
        : "The team will review your request. Other members can show support by reacting to the post.\n\n" +
            "If you no longer need this, press **Mark resolved** or use `/resolve`.",
    );
  if (related?.similar.length) {
    embed.addFields({
      name: "🔎 Possibly related",
      value: similarIssueLines(thread, related.repo, related.similar).join("\n"),
    });
  }
  if (askForTopics) {
    embed.addFields({
      name: WelcomeFields.topicPrompt,
      value: "Pick the tags that fit from the menu below so the right people see your post.",
    });
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(ComponentIds.createIssue)
      .setLabel("Track on GitHub")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ComponentIds.resolve).setLabel("Mark resolved").setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: askForTopics ? [topicMenu(topics), buttons] : [buttons] };
}
