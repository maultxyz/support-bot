import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  type AnyThreadChannel,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type TextChannel,
  type NewsChannel,
} from "discord.js";
import { config } from "../config.js";
import { forums } from "../db.js";
import { compileFaq, faqEnabled, type FaqEntry, type Transcript } from "../faq.js";
import { SyncError } from "../sync.js";
import { Colors, isStaffMember, truncate } from "./util.js";

const DAY = 24 * 60 * 60_000;
/** Most recent posts sent to Claude per run. */
const MAX_POSTS = 150;
/** Characters kept from each message and each thread, so one long thread can't crowd out the rest. */
const MAX_MESSAGE_CHARS = 1500;
const MAX_THREAD_CHARS = 8000;
/** Discord limits for one message's embeds. */
const MAX_EMBEDS = 10;
const MAX_EMBED_CHARS = 6000;

/** `/faq generate`: compiles a FAQ from the support forums' history, as a draft or straight into a channel. */
export async function handleFaqCommand(interaction: ChatInputCommandInteraction<"cached">) {
  if (!faqEnabled()) throw new SyncError("FAQ generation is off. Set `ANTHROPIC_API_KEY` for the bot to turn it on.");

  const days = interaction.options.getInteger("days") ?? 90;
  const resolvedOnly = interaction.options.getBoolean("resolved_only") ?? true;
  const target = interaction.options.getChannel("channel", false, [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
  ]);

  if (target && forums.get(target.id)) {
    throw new SyncError("Pick a channel the bot doesn't manage; FAQ posts would be treated as new support posts.");
  }

  const supportForums = forums
    .list(interaction.guildId)
    .filter((forum) => forum.kind === "support")
    .map((forum) => interaction.guild.channels.cache.get(forum.channelId))
    .filter((channel): channel is ForumChannel => channel?.type === ChannelType.GuildForum);
  if (supportForums.length === 0) throw new SyncError("No support forums are set up. Add one with `/setup forum add`.");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await interaction.editReply("Searching the support forums' history…");
  const since = Date.now() - days * DAY;
  const threads: AnyThreadChannel[] = [];
  for (const forum of supportForums) threads.push(...(await threadsSince(forum, since, resolvedOnly)));
  threads.sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0));
  const picked = threads.slice(0, MAX_POSTS);
  const which = resolvedOnly ? "resolved posts" : "posts";
  if (picked.length === 0) throw new SyncError(`No ${which} found from the last ${days} days.`);

  await interaction.editReply(`Reading ${picked.length} ${which}…`);
  const transcripts = await readTranscripts(picked);
  if (transcripts.length === 0) throw new SyncError(`None of those ${which} had any replies to learn from.`);

  await interaction.editReply(`Asking Claude to compile a FAQ from ${transcripts.length} posts. This can take a minute or two…`);
  const entries = await compileFaq(transcripts);
  if (entries.length === 0) throw new SyncError("Claude didn't find any recurring questions in those posts.");

  const file = new AttachmentBuilder(Buffer.from(toMarkdown(entries)), { name: "FAQ.md" });
  const summary = `Compiled **${entries.length}** FAQ entries from ${transcripts.length} ${which}.`;

  if (!target) {
    await interaction.editReply({
      content: `${summary}\nHere's the draft. Review it, then run \`/faq generate\` with a \`channel\` to post it.`,
      files: [file],
    });
    return;
  }

  if (target.type === ChannelType.GuildForum) await postToForum(target, entries);
  else await postToChannel(target, entries);
  await interaction.editReply({ content: `${summary} Posted to ${target}.`, files: [file] });
}

/**
 * Posts in a forum that were active since `since`, read from Discord rather than the bot's own records,
 * so posts from before the bot was added count too.
 */
async function threadsSince(forum: ForumChannel, since: number, resolvedOnly: boolean) {
  const resolvedName = config.RESOLVED_TAG_NAME.toLowerCase();
  const resolvedTag = forum.availableTags.find((tag) => tag.name.toLowerCase() === resolvedName);
  if (resolvedOnly && !resolvedTag) return [];

  const found: AnyThreadChannel[] = [];
  const active = await forum.threads.fetchActive();
  for (const thread of active.threads.values()) {
    if (thread.parentId === forum.id && (thread.createdTimestamp ?? 0) >= since) found.push(thread);
  }

  // Archived posts come newest-archived first, 100 per page.
  let before: Date | undefined;
  while (true) {
    const page = await forum.threads.fetchArchived({ before, limit: 100 });
    const list = [...page.threads.values()];
    found.push(...list.filter((thread) => (thread.archiveTimestamp ?? 0) >= since));
    const oldest = list.at(-1)?.archiveTimestamp;
    if (!page.hasMore || !oldest || oldest < since) break;
    before = new Date(oldest);
  }

  return resolvedTag && resolvedOnly ? found.filter((thread) => thread.appliedTags.includes(resolvedTag.id)) : found;
}

async function readTranscripts(threads: AnyThreadChannel[]) {
  const transcripts: Transcript[] = [];
  // A few at a time; discord.js queues requests under the rate limit.
  for (let i = 0; i < threads.length; i += 5) {
    const batch = await Promise.all(threads.slice(i, i + 5).map((thread) => readTranscript(thread).catch(() => null)));
    transcripts.push(...batch.filter((t): t is Transcript => t !== null));
  }
  return transcripts;
}

async function readTranscript(thread: AnyThreadChannel): Promise<Transcript | null> {
  const messages = [...(await thread.messages.fetch({ limit: 100 })).values()].reverse();
  const lines: string[] = [];
  let length = 0;
  for (const message of messages) {
    if (message.author.bot || !message.content.trim()) continue;
    const role =
      message.author.id === thread.ownerId
        ? "Asker"
        : message.member && isStaffMember(message.member, thread)
          ? "Staff"
          : "Member";
    const line = `${role}: ${truncate(message.content.trim(), MAX_MESSAGE_CHARS)}`;
    if (length + line.length > MAX_THREAD_CHARS) break;
    lines.push(line);
    length += line.length;
  }

  // A thread with only the question has no answer to learn from.
  if (!lines.some((line) => !line.startsWith("Asker:"))) return null;
  return { threadId: thread.id, title: thread.name, messages: lines };
}

function sources(entry: FaqEntry) {
  return entry.sourceThreadIds.length ? `-# From ${entry.sourceThreadIds.map((id) => `<#${id}>`).join(" ")}` : "";
}

function entryEmbed(entry: FaqEntry) {
  const footer = sources(entry);
  return new EmbedBuilder()
    .setColor(Colors.brand)
    .setAuthor({ name: truncate(entry.category, 256) })
    .setTitle(truncate(entry.question, 256))
    .setDescription(truncate(entry.answer, 4096 - footer.length - 2) + (footer ? `\n\n${footer}` : ""));
}

/** Posts the entries as embeds, packed into as few messages as Discord allows. */
async function postToChannel(channel: TextChannel | NewsChannel, entries: FaqEntry[]) {
  await channel.send("## Frequently asked questions");
  let batch: EmbedBuilder[] = [];
  let size = 0;
  for (const embed of entries.map(entryEmbed)) {
    const embedSize = embed.length;
    if (batch.length === MAX_EMBEDS || size + embedSize > MAX_EMBED_CHARS) {
      await channel.send({ embeds: batch });
      batch = [];
      size = 0;
    }
    batch.push(embed);
    size += embedSize;
  }
  if (batch.length) await channel.send({ embeds: batch });
}

/** Creates one forum post per entry, so each question can be searched and linked on its own. */
async function postToForum(forum: ForumChannel, entries: FaqEntry[]) {
  for (const entry of entries) {
    const tag = forum.availableTags.find((t) => t.name.toLowerCase() === entry.category.toLowerCase());
    const footer = sources(entry);
    await forum.threads.create({
      name: truncate(entry.question, 100),
      message: { content: truncate(entry.answer, 2000 - footer.length - 2) + (footer ? `\n\n${footer}` : "") },
      appliedTags: tag ? [tag.id] : [],
    });
  }
}

function toMarkdown(entries: FaqEntry[]) {
  const byCategory = new Map<string, FaqEntry[]>();
  for (const entry of entries) byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry]);
  const sections = [...byCategory].map(
    ([category, list]) => `## ${category}\n\n${list.map((e) => `### ${e.question}\n\n${e.answer}`).join("\n\n")}`,
  );
  return `# Frequently asked questions\n\n${sections.join("\n\n")}\n`;
}
