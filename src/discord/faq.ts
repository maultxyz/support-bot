import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AnyThreadChannel,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type ModalSubmitInteraction,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import { config } from "../config.js";
import { faqRelevance, faqs, forums, posts, type FaqEntry, type FaqMerge } from "../db.js";
import { compileFaq, faqEnabled, mergeFaq, type Transcript } from "../faq.js";
import { keywords, stem } from "../github.js";
import { SyncError } from "../sync.js";
import { asForumThread, Colors, ComponentIds, isStaff, isStaffMember, truncate } from "./util.js";

const DAY = 24 * 60 * 60_000;
/** Most recent posts sent to Claude per run. */
const MAX_POSTS = 150;
/** Characters kept from each message and each thread, so one long thread can't crowd out the rest. */
const MAX_MESSAGE_CHARS = 1500;
const MAX_THREAD_CHARS = 8000;
/** Entry lengths, so an entry always fits the edit form and a single embed. */
const MAX_CATEGORY = 100;
const MAX_QUESTION = 256;
const MAX_ANSWER = 3500;
/** Source posts linked under an entry. */
const MAX_SOURCES = 5;
/** Discord limits for one message's embeds, and for autocomplete. */
const MAX_EMBEDS = 10;
const MAX_EMBED_CHARS = 6000;
const MAX_CHOICES = 25;
/** Entries Merge keeps unless told otherwise. */
export const DEFAULT_KEEP = 20;

/** Generate: has Claude add entries for questions the support forums keep getting. */
export async function generateFaq(interaction: ModalSubmitInteraction<"cached">, days: number, resolvedOnly: boolean) {
  if (!faqEnabled()) throw new SyncError("FAQ generation is off. Set `ANTHROPIC_API_KEY` for the bot to turn it on.");

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
  const { newEntries, alreadyCovered } = await compileFaq(transcripts, faqs.list(interaction.guildId));

  // Posts asking questions the FAQ already answers make those entries rank higher.
  let counted = 0;
  for (const match of alreadyCovered) counted += faqs.addSources(interaction.guildId, match.existingId, match.sourceThreadIds);
  const countedNote = counted
    ? `${counted} ${counted === 1 ? "post asked a question" : "posts asked questions"} the FAQ already answers, so those entries moved up.`
    : "";
  if (newEntries.length === 0) {
    await interaction.editReply(`No new questions in those posts. ${countedNote}`.trim());
    return;
  }

  const added = newEntries.map((entry) => {
    const content = {
      category: truncate(entry.category, MAX_CATEGORY),
      question: truncate(entry.question, MAX_QUESTION),
      answer: truncate(entry.answer, MAX_ANSWER),
      sourceThreadIds: entry.sourceThreadIds,
    };
    return faqs.get(interaction.guildId, faqs.add(interaction.guildId, content, interaction.user.id))!;
  });

  const lines = added.map((entry) => `\`#${entry.id}\` ${entry.question}`);
  await interaction.editReply({
    content: truncate(
      `Added **${added.length}** FAQ entries from ${transcripts.length} ${which}. The full text is in the file. ${countedNote}\n` +
        "To fix one, open `/faq` and pick it from the list. If any repeat each other, press **Merge** there.\n\n" +
        lines.join("\n"),
      2000,
    ),
    files: [markdownFile(added)],
  });
}

interface MergePlan {
  guildId: string;
  createdAt: number;
  /** Entries the plan was made from, so it isn't applied over changes made since. */
  entryIds: number[];
  merged: FaqMerge[];
}

/** Merge previews waiting for Apply or Cancel, by the ID of the interaction that asked for them. */
const mergePlans = new Map<string, MergePlan>();
const MERGE_PLAN_TTL = 15 * 60_000;

/** Merge: has Claude combine duplicates and keep the most asked entries, then shows the result to approve. */
export async function mergeFaqPreview(interaction: ModalSubmitInteraction<"cached">, keep: number) {
  if (!faqEnabled()) throw new SyncError("FAQ merging is off. Set `ANTHROPIC_API_KEY` for the bot to turn it on.");
  const entries = faqs.list(interaction.guildId);
  if (entries.length < 2) throw new SyncError("The FAQ needs at least two entries to merge.");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(`Asking Claude to merge ${entries.length} entries down to at most ${keep}…`);
  const merged = await mergeFaq(entries, keep);
  if (merged.length === 0) throw new SyncError("Claude didn't return any entries. Nothing was changed.");

  for (const [key, plan] of mergePlans) if (Date.now() - plan.createdAt > MERGE_PLAN_TTL) mergePlans.delete(key);
  mergePlans.set(interaction.id, {
    guildId: interaction.guildId,
    createdAt: Date.now(),
    entryIds: entries.map((entry) => entry.id),
    merged,
  });

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const kept = new Set(merged.flatMap((item) => item.ids));
  const dropped = entries.filter((entry) => !kept.has(entry.id));
  const asked = (item: FaqMerge) => item.ids.reduce((sum, id) => sum + faqRelevance(byId.get(id)!), 0);

  const lines = merged.map((item, index) => {
    const others = item.ids.slice(1).map((id) => `#${id}`);
    const note = others.length ? ` · merges #${item.ids[0]} with ${others.join(", ")}` : ` · #${item.ids[0]}`;
    return `${index + 1}. **${item.question}** · asked ${asked(item)}×${note}`;
  });
  const removed = dropped.length
    ? `\n\n**Removed (${dropped.length}):** ${dropped.map((e) => `#${e.id} ${e.question}`).join(" · ")}`
    : "";

  await interaction.editReply({
    content: `Here's the merged FAQ: **${entries.length}** entries become **${merged.length}**, most asked first. ` +
      "The full text is in the file. Nothing changes until you press **Apply**; this preview expires in 15 minutes.",
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.warning)
        .setTitle("Merged FAQ preview")
        .setDescription(truncate(lines.join("\n") + removed, 4096)),
    ],
    files: [
      markdownFile(
        merged.map((item, index) => ({ ...byId.get(item.ids[0]!)!, ...item, id: item.ids[0]!, position: index + 1 })),
        "FAQ-merged.md",
      ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${ComponentIds.faqMerge}apply:${interaction.id}`)
          .setLabel("Apply")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${ComponentIds.faqMerge}cancel:${interaction.id}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

/** Apply or Cancel on a merge preview. */
export async function handleFaqMergeButton(interaction: ButtonInteraction<"cached">) {
  if (!isStaff(interaction)) throw new SyncError("Only staff can merge the FAQ.");
  const [action, key] = interaction.customId.slice(ComponentIds.faqMerge.length).split(":");
  const plan = mergePlans.get(key!);
  mergePlans.delete(key!);

  if (action === "cancel") {
    await interaction.update({ content: "Merge cancelled. The FAQ wasn't changed.", embeds: [], attachments: [], components: [] });
    return;
  }
  if (!plan || plan.guildId !== interaction.guildId || Date.now() - plan.createdAt > MERGE_PLAN_TTL) {
    throw new SyncError("This preview expired. Open `/faq` and press **Merge** again.");
  }

  // Don't throw away edits, new entries or deletions made after the preview was built.
  const current = faqs.list(interaction.guildId);
  const changed =
    current.length !== plan.entryIds.length ||
    current.some((entry) => !plan.entryIds.includes(entry.id) || entry.updatedAt > plan.createdAt);
  if (changed) throw new SyncError("The FAQ changed after this preview was made. Open `/faq` and press **Merge** again.");

  faqs.merge(interaction.guildId, plan.merged, interaction.user.id);
  await interaction.update({
    content: `Merged. The FAQ now has **${plan.merged.length}** entries, most asked first. Open \`/faq\` to see them.`,
    embeds: [],
    attachments: [],
    components: [],
  });
}

/** Publish: posts the whole FAQ for people to browse. */
export async function publishFaq(
  interaction: ModalSubmitInteraction<"cached">,
  target: TextChannel | NewsChannel | ForumChannel,
) {
  if (forums.get(target.id)) {
    throw new SyncError("Pick a channel the bot doesn't manage; FAQ posts would be treated as new support posts.");
  }
  const entries = faqs.list(interaction.guildId);
  if (entries.length === 0) throw new SyncError("The FAQ is empty. Add entries first.");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (target.type === ChannelType.GuildForum) await postToForum(target, entries);
  else await postToChannel(target, entries);
  await interaction.editReply(`Posted ${entries.length} FAQ entries to ${target}.`);
}

/** `/faq entry:…`: answers the current post (or any channel) with an entry. */
export async function sendFaqEntry(interaction: ChatInputCommandInteraction<"cached">, entryOption: string) {
  const entry = faqs.get(interaction.guildId, Number(entryOption));
  if (!entry) throw new SyncError("No FAQ entry found. Pick one from the suggestions as you type.");
  if (!interaction.channel?.isSendable()) throw new SyncError("I can't post in this channel.");

  // In a support post, ping whoever asked unless someone else was picked.
  const post = asForumThread(interaction.channel);
  const user = interaction.options.getUser("user") ?? (post?.thread.ownerId ? { id: post.thread.ownerId } : null);
  const mention = user && user.id !== interaction.user.id ? user.id : null;

  await interaction.reply({
    content: mention ? `<@${mention}>, this should help:` : undefined,
    embeds: [entryEmbed(entry)],
    allowedMentions: { users: mention ? [mention] : [] },
  });

  faqs.markUsed(entry.id);
  // Counts as a staff answer for unanswered alerts, auto-close and /stats.
  if (post && posts.get(post.thread.id)) posts.markStaffReply(post.thread.id);
}

/** Suggests entries for the `entry` option: matches for what's typed, or for the current post if nothing is. */
export async function handleFaqAutocomplete(interaction: AutocompleteInteraction<"cached">) {
  const typed = interaction.options.getFocused().trim();
  let query = typed;
  let fromPost = false;
  if (!query && interaction.channel?.isThread()) {
    const thread = interaction.channel;
    // The starter message shares the thread's ID; it's usually cached since the bot saw it posted.
    query = `${thread.name} ${thread.messages.cache.get(thread.id)?.content ?? ""}`;
    fromPost = true;
  }

  // Most asked first; with nothing to match, or nothing in the post matching, that's the order shown.
  const entries = faqs.list(interaction.guildId);
  let ranked = query ? rank(entries, query) : entries;
  if (fromPost && ranked.length === 0) ranked = entries;

  await interaction.respond(
    ranked.slice(0, MAX_CHOICES).map((entry) => ({
      name: truncate(`#${entry.id} ${entry.question}`, 100),
      value: String(entry.id),
    })),
  );
}

/**
 * Entries that share words with `query`, best match first, then most asked (the order `entries` comes in).
 * Partial words count, so results update while typing.
 */
function rank(entries: FaqEntry[], query: string) {
  const terms = keywords(query).map(stem);
  const lowered = query.toLowerCase();
  const id = /^#?(\d+)$/.exec(query.trim())?.[1];

  const words = (text: string) => keywords(text).map(stem);
  const hits = (fieldWords: string[]) => terms.filter((t) => fieldWords.some((w) => w.startsWith(t) || t.startsWith(w))).length;

  return entries
    .map((entry) => {
      let score = hits(words(entry.question)) * 3 + hits(words(entry.category)) * 2 + hits(words(entry.answer));
      if (lowered && entry.question.toLowerCase().includes(lowered)) score += 5;
      if (id && entry.id === Number(id)) score += 100;
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry);
}

/** The add/edit form. */
export function faqModal(entry?: FaqEntry) {
  const field = (id: string, label: string, style: TextInputStyle, max: number, value?: string) => {
    const input = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(true);
    if (value) input.setValue(value);
    return new LabelBuilder().setLabel(label).setTextInputComponent(input);
  };
  return new ModalBuilder()
    .setCustomId(`${ComponentIds.faqForm}${entry?.id ?? "new"}`)
    .setTitle(entry ? `Edit FAQ #${entry.id}` : "New FAQ entry")
    .addLabelComponents(
      field("question", "Question", TextInputStyle.Short, MAX_QUESTION, entry?.question),
      field("answer", "Answer (markdown works)", TextInputStyle.Paragraph, MAX_ANSWER, entry?.answer),
      field("category", "Category", TextInputStyle.Short, MAX_CATEGORY, entry?.category),
    );
}

/** Saves the submitted add/edit form and returns the saved entry. */
export function saveFaqForm(interaction: ModalSubmitInteraction<"cached">) {
  const content = {
    question: interaction.fields.getTextInputValue("question").trim(),
    answer: interaction.fields.getTextInputValue("answer").trim(),
    category: interaction.fields.getTextInputValue("category").trim(),
  };

  const target = interaction.customId.slice(ComponentIds.faqForm.length);
  let id: number;
  if (target === "new") {
    id = faqs.add(interaction.guildId, content, interaction.user.id);
  } else {
    id = Number(target);
    if (!faqs.update(interaction.guildId, id, content, interaction.user.id)) {
      throw new SyncError("That entry was deleted while you were editing it. Press **Add entry** in `/faq` to save it again.");
    }
  }
  return faqs.get(interaction.guildId, id)!;
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
  const ids = entry.sourceThreadIds.slice(0, MAX_SOURCES);
  return ids.length ? `-# Similar posts: ${ids.map((id) => `<#${id}>`).join(" ")}` : "";
}

export function entryEmbed(entry: FaqEntry) {
  const footer = sources(entry);
  return new EmbedBuilder()
    .setColor(Colors.brand)
    .setAuthor({ name: `FAQ · ${entry.category}` })
    .setTitle(entry.question)
    .setDescription(entry.answer + (footer ? `\n\n${footer}` : ""))
    .setFooter({ text: `#${entry.id}` });
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

/**
 * Creates one forum post per entry, so each question can be searched and linked on its own. The most asked
 * entry is created last, so it's on top when the forum is sorted by recent activity.
 */
async function postToForum(forum: ForumChannel, entries: FaqEntry[]) {
  for (const entry of [...entries].reverse()) {
    const tag = forum.availableTags.find((t) => t.name.toLowerCase() === entry.category.toLowerCase());
    await forum.threads.create({
      name: truncate(entry.question, 100),
      message: { embeds: [entryEmbed(entry)] },
      appliedTags: tag ? [tag.id] : [],
    });
  }
}

/** The entries in the order given (most asked first), as a markdown file. */
export function markdownFile(entries: FaqEntry[], name = "FAQ.md") {
  const sections = entries.map(
    (e, index) => `## ${index + 1}. ${e.question}\n\n-# ${e.category} · #${e.id}\n\n${e.answer}`,
  );
  return new AttachmentBuilder(Buffer.from(`# Frequently asked questions\n\n${sections.join("\n\n")}\n`), { name });
}
