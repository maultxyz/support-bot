import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type AnyThreadChannel,
  type BaseInteraction,
  type Channel,
} from "discord.js";
import type { IssueKind } from "../config.js";
import { forums, staffRoles, type IssueLink } from "../db.js";

export const Colors = {
  brand: 0x5865f2,
  success: 0x2ea043,
  merged: 0x8250df,
  muted: 0x6e7781,
} as const;

export const ButtonIds = {
  createIssue: "support:create-issue",
  resolve: "support:resolve",
} as const;

export const KIND_LABEL: Record<IssueKind, string> = {
  support: "support request",
  feature: "feature request",
};

/** Returns the thread and its request kind if the channel is a post in a managed forum. */
export function asForumThread(channel: Channel | null) {
  if (!channel?.isThread() || !channel.parentId) return null;
  const forum = forums.get(channel.parentId);
  return forum ? { thread: channel, kind: forum.kind } : null;
}

/** Staff are members with Manage Threads, or with a role added via /setup staff add. */
export function isStaff(interaction: BaseInteraction): boolean {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads)) return true;
  const roles = interaction.member?.roles;
  if (!roles || !interaction.guildId) return false;
  const memberRoleIds = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  const staffRoleIds = staffRoles.list(interaction.guildId);
  return memberRoleIds.some((id) => staffRoleIds.includes(id));
}

/** Adds or removes a forum tag by name. Silently does nothing if the forum has no such tag. */
export async function setTag(thread: AnyThreadChannel, tagName: string, enabled: boolean) {
  const parent = thread.parent;
  if (!parent || !("availableTags" in parent)) return;

  const tag = parent.availableTags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
  if (!tag) return;

  const applied = thread.appliedTags;
  if (applied.includes(tag.id) === enabled) return;
  // Discord allows at most 5 tags per post; don't drop the author's own tags to make room.
  if (enabled && applied.length >= 5) return;

  await thread.setAppliedTags(
    enabled ? [...applied, tag.id] : applied.filter((id) => id !== tag.id),
  );
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

export function welcomeMessage(kind: IssueKind) {
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

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(ButtonIds.createIssue)
      .setLabel("Track on GitHub")
      .setStyle(ButtonStyle.Secondary),
    resolveButton(),
  );

  return { embeds: [embed], components: [row] };
}

function resolveButton() {
  return new ButtonBuilder().setCustomId(ButtonIds.resolve).setLabel("Mark resolved").setStyle(ButtonStyle.Success);
}

export function resolveOnlyRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(resolveButton());
}
