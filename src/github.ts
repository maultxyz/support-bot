import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

export const octokit = new Octokit({
  auth: config.GITHUB_TOKEN,
  userAgent: "discord-support-bot",
});

const repo = { owner: config.GITHUB_OWNER, repo: config.GITHUB_REPO };

/** Lowercased `owner/repo`, used as the key for stored links. */
export const repoSlug = `${config.GITHUB_OWNER}/${config.GITHUB_REPO}`.toLowerCase();

/**
 * Appended to every comment the bot writes on GitHub so the webhook handler
 * can skip it instead of echoing it back into Discord.
 */
export const SYNC_MARKER = "<!-- discord-sync -->";

export async function createIssue(params: { title: string; body: string; labels: string[] }) {
  const { data } = await octokit.rest.issues.create({ ...repo, ...params });
  return data;
}

/** Returns null if the issue does not exist. */
export async function getIssue(issueNumber: number) {
  try {
    const { data } = await octokit.rest.issues.get({ ...repo, issue_number: issueNumber });
    return data;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

export async function commentOnIssue(issueNumber: number, body: string) {
  await octokit.rest.issues.createComment({
    ...repo,
    issue_number: issueNumber,
    body: `${body}\n\n${SYNC_MARKER}`,
  });
}

export async function closeIssue(issueNumber: number, reason: "completed" | "not_planned" = "completed") {
  await octokit.rest.issues.update({
    ...repo,
    issue_number: issueNumber,
    state: "closed",
    state_reason: reason,
  });
}
