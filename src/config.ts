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
  PENDING_TAG_NAME: z.string().default("Pending"),
  ADDED_TAG_NAME: z.string().default("Added"),
  REJECTED_TAG_NAME: z.string().default("Rejected"),

  GITHUB_TOKEN: z.string().min(1),
  // Default repo for forums registered without one. Each forum can set its own with /setup forum add.
  GITHUB_OWNER: z.string().optional(),
  GITHUB_REPO: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  SUPPORT_LABELS: list("support"),
  FEATURE_LABELS: list("enhancement"),

  MIRROR_DISCORD_MESSAGES: z.stringbool().default(true),
  MIRROR_GITHUB_COMMENTS: z.stringbool().default(true),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

if (Boolean(parsed.data.GITHUB_OWNER) !== Boolean(parsed.data.GITHUB_REPO)) {
  console.error("Invalid configuration: set both GITHUB_OWNER and GITHUB_REPO, or neither.");
  process.exit(1);
}

export const config = parsed.data;

export type IssueKind = "support" | "feature";
