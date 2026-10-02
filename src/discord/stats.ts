import { ChannelType, EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { posts, type Post } from "../db.js";
import { formatDuration, INACTIVE_REASON } from "../tracking.js";
import { Colors, isTopicTag, RESOLVE_REASONS, type ResolveReason } from "./util.js";

const DAY = 24 * 60 * 60_000;

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function durationSummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  if (median === null || p90 === null) return "No data yet";
  return `Median **${formatDuration(median)}** · 90% within **${formatDuration(p90)}**`;
}

/** `/stats [days]`: activity in this server's managed forums. */
export async function handleStatsCommand(interaction: ChatInputCommandInteraction<"cached">) {
  const days = interaction.options.getInteger("days") ?? 30;
  const since = Date.now() - days * DAY;
  const all = posts.activeSince(interaction.guildId, since);

  const created = all.filter((post) => post.createdAt >= since);
  const closed = all.filter((post): post is Post & { closedAt: number } => post.closedAt !== null && post.closedAt >= since);
  const open = all.filter((post) => post.closedAt === null);
  const answered = created.filter((post): post is Post & { firstResponseAt: number } => post.firstResponseAt !== null);

  const byKind = (list: Post[], kind: Post["kind"]) => list.filter((post) => post.kind === kind).length;
  const reasonLines = Object.entries(RESOLVE_REASONS)
    .map(([reason, info]) => {
      const count = closed.filter((post) => post.closeReason === (reason as ResolveReason)).length;
      return count ? `${info.emoji} ${info.label}: **${count}**` : null;
    })
    .filter(Boolean);
  const inactive = closed.filter((post) => post.closeReason === INACTIVE_REASON).length;
  if (inactive) reasonLines.push(`💤 Inactive: **${inactive}**`);

  const answeredShare = created.length ? Math.round((answered.length / created.length) * 100) : 0;
  const unanswered = open.filter((post) => post.firstResponseAt === null).length;

  const embed = new EmbedBuilder()
    .setColor(Colors.brand)
    .setTitle(`Support stats: last ${days} ${days === 1 ? "day" : "days"}`)
    .addFields(
      {
        name: "New posts",
        value: `**${created.length}** (${byKind(created, "support")} support, ${byKind(created, "feature")} feature)`,
        inline: true,
      },
      { name: "Closed", value: `**${closed.length}**\n${reasonLines.join("\n")}`.trim(), inline: true },
      {
        name: "Still open",
        value: `**${open.length}** (${unanswered} without a staff reply)`,
        inline: true,
      },
      {
        name: "First staff response",
        value: `${durationSummary(answered.map((post) => post.firstResponseAt - post.createdAt))}\n` +
          `${answeredShare}% of new posts have had a staff reply`,
      },
      {
        name: "Time to close",
        value: durationSummary(closed.map((post) => post.closedAt - post.createdAt)),
      },
    );

  const topics = topTopics(interaction, created);
  if (topics.length) embed.addFields({ name: "Top topics", value: topics.join("\n"), inline: true });

  const wanted = open
    .filter((post) => post.kind === "feature" && post.votes > 0)
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 5)
    .map((post) => `<#${post.threadId}>: **${post.votes}** ${post.votes === 1 ? "vote" : "votes"}`);
  if (wanted.length) embed.addFields({ name: "Most wanted", value: wanted.join("\n"), inline: true });

  embed.setFooter({ text: "Counts posts created since the bot started tracking them." });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/** The most common topic tags on the given posts, by name. */
function topTopics(interaction: ChatInputCommandInteraction<"cached">, list: Post[]) {
  const counts = new Map<string, number>();
  for (const post of list) {
    const forum = interaction.guild.channels.cache.get(post.forumId);
    if (forum?.type !== ChannelType.GuildForum) continue;
    const tagIds = post.tagIds.split(",");
    for (const tag of forum.availableTags) {
      if (isTopicTag(tag) && tagIds.includes(tag.id)) counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name}: **${count}**`);
}
