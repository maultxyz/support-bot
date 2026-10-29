import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";
import { faqRelevance, type FaqEntry, type FaqMerge } from "./db.js";

export interface Transcript {
  threadId: string;
  title: string;
  /** Lines like `Staff: ...`, oldest first. */
  messages: string[];
}

const threadIds = z.array(z.string()).describe("IDs of the threads that ask this question");

const CompileSchema = z.object({
  newEntries: z.array(
    z.object({
      category: z.string().describe("Short topic heading, e.g. 'Installation' or 'Billing'"),
      question: z.string().describe("The question as a user would ask it"),
      answer: z.string().describe("A self-contained answer in Discord markdown"),
      sourceThreadIds: threadIds,
    }),
  ),
  alreadyCovered: z.array(
    z.object({
      existingId: z.number().int().describe("ID of the existing FAQ entry that answers these threads"),
      sourceThreadIds: threadIds,
    }),
  ),
});

export type CompiledFaq = z.infer<typeof CompileSchema>["newEntries"][number];

const COMPILE_SYSTEM = `You compile a FAQ from resolved support threads in a Discord server.

Each thread is a question from a user ("Asker") and the replies that resolved it. Replies from the support team are
marked "Staff"; other community members are "Member".

Group threads that ask the same thing and write one FAQ entry per recurring question. Only include a question if a
thread actually resolved it, and base every answer on what was said in the threads: don't add steps, links or
version numbers that aren't there. Prefer the Staff answer when replies disagree. Skip one-off problems that are
unlikely to help anyone else, and leave out names, usernames, emails, keys and anything else personal.

Write answers that make sense on their own, without the thread: plain, direct, and short enough to read at a glance.
Use Discord markdown (bold, lists, \`code\`) where it helps.

The server may already have a FAQ, listed in <existing_faq> with each entry's ID. When threads ask a question an
existing entry already answers, list them under alreadyCovered with that entry's ID instead of writing a new entry:
this is how the FAQ learns which questions come up most. Put only genuinely new questions in newEntries, reusing the
existing category names where they fit. List every thread that asks each question, so the counts are right.`;

const MergeSchema = z.object({
  entries: z
    .array(
      z.object({
        ids: z.array(z.number().int()).describe("IDs of the existing entries this one replaces, most asked first"),
        category: z.string(),
        question: z.string(),
        answer: z.string().describe("Discord markdown"),
      }),
    )
    .describe("The new FAQ, most important first"),
});

const MERGE_SYSTEM = `You tidy up a Discord server's support FAQ.

Each entry in <faq> has an ID and an "asked" count: how many support posts asked that question, plus how many times
staff answered a post with it. Higher counts matter more.

1. Merge entries that ask the same thing, or are close enough that one answer covers both, into one entry. Write
   one question that covers them and combine their answers without losing any steps or details that are still
   correct. List every ID you merged.
2. Squash the FAQ down to at most the requested number of entries, keeping the questions people ask most and the
   ones that matter most when they come up (data loss, security, setup blockers). Drop rare one-offs and entries
   that are out of date because another entry contradicts them with newer information.
3. Order the result most important first. Rank mainly by the combined asked count of the merged entries; use
   importance only to break near-ties.

Staff may have edited these entries by hand. Keep an entry's wording as it is unless merging requires changing it,
and never add facts that aren't in the entries. Keep category names consistent and short.`;

let client: Anthropic | undefined;

export function faqEnabled() {
  return Boolean(config.ANTHROPIC_API_KEY);
}

/** Sends one request with structured output; the API retries on a fallback model if the first one declines. */
async function ask<T extends z.ZodType>(schema: T, system: string, content: string, task: string): Promise<z.infer<T>> {
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.parse({
    model: config.FAQ_MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") throw new Error(`Claude declined to ${task}.`);
  if (response.stop_reason === "max_tokens") throw new Error(`Claude ran out of room to ${task}.`);
  if (!response.parsed_output) throw new Error("Claude's reply didn't match the expected format.");
  return response.parsed_output;
}

/**
 * Asks Claude to turn resolved support threads into new FAQ entries, and which existing entries
 * (by ID) the other threads asked about.
 */
export async function compileFaq(transcripts: Transcript[], existing: FaqEntry[]) {
  const threads = transcripts
    .map((t) => `<thread id="${t.threadId}" title="${escapeAttr(t.title)}">\n${t.messages.join("\n")}\n</thread>`)
    .join("\n\n");
  const existingFaq = existing.map((entry) => `- #${entry.id} [${entry.category}] ${entry.question}`).join("\n");

  const result = await ask(
    CompileSchema,
    COMPILE_SYSTEM,
    `<existing_faq>\n${existingFaq || "(none yet)"}\n</existing_faq>\n\n${threads}\n\n` +
      `Compile the FAQ from these ${transcripts.length} threads.`,
    "compile the FAQ",
  );

  const known = new Set(transcripts.map((t) => t.threadId));
  const existingIds = new Set(existing.map((entry) => entry.id));
  const onlyKnown = (ids: string[]) => ids.filter((id) => known.has(id));
  return {
    newEntries: result.newEntries.map((entry) => ({ ...entry, sourceThreadIds: onlyKnown(entry.sourceThreadIds) })),
    alreadyCovered: result.alreadyCovered
      .filter((match) => existingIds.has(match.existingId))
      .map((match) => ({ ...match, sourceThreadIds: onlyKnown(match.sourceThreadIds) })),
  };
}

/** Asks Claude to merge duplicate entries and keep at most `keep`, most important first. */
export async function mergeFaq(entries: FaqEntry[], keep: number): Promise<FaqMerge[]> {
  const faq = entries
    .map(
      (entry) =>
        `<entry id="${entry.id}" asked="${faqRelevance(entry)}" category="${escapeAttr(entry.category)}">\n` +
        `Q: ${entry.question}\nA: ${entry.answer}\n</entry>`,
    )
    .join("\n\n");

  const result = await ask(
    MergeSchema,
    MERGE_SYSTEM,
    `<faq>\n${faq}\n</faq>\n\nMerge and squash this FAQ of ${entries.length} entries down to at most ${keep}.`,
    "merge the FAQ",
  );

  // Keep only real IDs, each in one entry at most, so a bad reply can't merge or delete the wrong thing.
  const remaining = new Set(entries.map((entry) => entry.id));
  const merged: FaqMerge[] = [];
  for (const item of result.entries) {
    const ids = item.ids.filter((id) => remaining.delete(id));
    if (ids.length) merged.push({ ...item, ids });
  }
  return merged.slice(0, keep);
}

function escapeAttr(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
