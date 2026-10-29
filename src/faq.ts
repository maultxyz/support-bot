import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";

export interface Transcript {
  threadId: string;
  title: string;
  /** Lines like `Staff: ...`, oldest first. */
  messages: string[];
}

const FaqSchema = z.object({
  entries: z.array(
    z.object({
      category: z.string().describe("Short topic heading, e.g. 'Installation' or 'Billing'"),
      question: z.string().describe("The question as a user would ask it"),
      answer: z.string().describe("A self-contained answer in Discord markdown"),
      sourceThreadIds: z.array(z.string()).describe("IDs of the threads this entry is based on"),
    }),
  ),
});

export type FaqEntry = z.infer<typeof FaqSchema>["entries"][number];

const SYSTEM = `You compile a FAQ from resolved support threads in a Discord server.

Each thread is a question from a user ("Asker") and the replies that resolved it. Replies from the support team are
marked "Staff"; other community members are "Member".

Group threads that ask the same thing and write one FAQ entry per recurring question. Only include a question if a
thread actually resolved it, and base every answer on what was said in the threads: don't add steps, links or
version numbers that aren't there. Prefer the Staff answer when replies disagree. Skip one-off problems that are
unlikely to help anyone else, and leave out names, usernames, emails, keys and anything else personal.

Write answers that make sense on their own, without the thread: plain, direct, and short enough to read at a glance.
Use Discord markdown (bold, lists, \`code\`) where it helps. Order entries by category, most common questions first.`;

let client: Anthropic | undefined;

export function faqEnabled() {
  return Boolean(config.ANTHROPIC_API_KEY);
}

/** Asks Claude to turn resolved support threads into FAQ entries. */
export async function compileFaq(transcripts: Transcript[]): Promise<FaqEntry[]> {
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const threads = transcripts
    .map((t) => `<thread id="${t.threadId}" title="${escapeAttr(t.title)}">\n${t.messages.join("\n")}\n</thread>`)
    .join("\n\n");

  const response = await client.beta.messages.parse({
    model: config.FAQ_MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: betaZodOutputFormat(FaqSchema) },
    // If the model declines, the API retries on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: `${threads}\n\nCompile the FAQ from these ${transcripts.length} threads.` }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined to compile the FAQ.");
  if (response.stop_reason === "max_tokens") throw new Error("The FAQ was too long; try fewer days.");
  if (!response.parsed_output) throw new Error("Claude's reply didn't match the FAQ format.");

  const known = new Set(transcripts.map((t) => t.threadId));
  return response.parsed_output.entries.map((entry) => ({
    ...entry,
    sourceThreadIds: entry.sourceThreadIds.filter((id) => known.has(id)),
  }));
}

function escapeAttr(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
