import { z } from "zod";

/** Comma-separated list -> string[] */
const list = (fallback = "") =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default("./data/bot.db"),

  DISCORD_TOKEN: z.string().min(1),
  RESOLVED_TAG_NAME: z.string().default("Resolved"),
  TRACKED_TAG_NAME: z.string().default("Tracked"),

  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  SUPPORT_LABELS: list("support"),
  FEATURE_LABELS: list("enhancement"),

  MIRROR_DISCORD_MESSAGES: z.stringbool().default(true),
  MIRROR_GITHUB_COMMENTS: z.stringbool().default(true),
  ARCHIVE_ON_CLOSE: z.stringbool().default(true),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;

export type IssueKind = "support" | "feature";
