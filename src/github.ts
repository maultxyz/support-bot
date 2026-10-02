import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

export const octokit = new Octokit({
  auth: config.GITHUB_TOKEN,
  userAgent: "discord-support-bot",
});

/** `owner/repo` used by forums registered without their own repo, if GITHUB_OWNER/GITHUB_REPO are set. */
export const defaultRepo = config.GITHUB_OWNER && config.GITHUB_REPO ? `${config.GITHUB_OWNER}/${config.GITHUB_REPO}` : null;

/** Lowercased `owner/repo`, used as the key for stored links. */
export function repoKey(repo: string) {
  return repo.toLowerCase();
}

function split(repo: string) {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, repo: name };
}

/**
 * Appended to every comment the bot writes on GitHub so the webhook handler
 * can skip it instead of echoing it back into Discord.
 */
export const SYNC_MARKER = "<!-- discord-sync -->";

const VOTES_START = "<!-- discord-votes -->";
const VOTES_END = "<!-- /discord-votes -->";

function isNotFound(error: unknown) {
  return (error as { status?: number }).status === 404;
}

/** Returns the repo's canonical `owner/repo`, or null if it doesn't exist or the token can't see it. */
export async function getRepository(repo: string) {
  try {
    const { data } = await octokit.rest.repos.get(split(repo));
    return data.full_name;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function createIssue(repo: string, params: { title: string; body: string; labels: string[] }) {
  const { data } = await octokit.rest.issues.create({ ...split(repo), ...params });
  return data;
}

/** Returns null if the issue does not exist. */
export async function getIssue(repo: string, issueNumber: number) {
  try {
    const { data } = await octokit.rest.issues.get({ ...split(repo), issue_number: issueNumber });
    return data;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function commentOnIssue(repo: string, issueNumber: number, body: string) {
  await octokit.rest.issues.createComment({
    ...split(repo),
    issue_number: issueNumber,
    body: `${body}\n\n${SYNC_MARKER}`,
  });
}

/** Adds labels without touching existing ones. GitHub creates any label that doesn't exist yet. */
export async function addLabels(repo: string, issueNumber: number, labels: string[]) {
  if (labels.length === 0) return;
  await octokit.rest.issues.addLabels({ ...split(repo), issue_number: issueNumber, labels });
}

export async function closeIssue(repo: string, issueNumber: number, reason: "completed" | "not_planned" = "completed") {
  await octokit.rest.issues.update({
    ...split(repo),
    issue_number: issueNumber,
    state: "closed",
    state_reason: reason,
  });
}

/** The vote line kept at the end of an issue body; empty when there are no votes. */
export function votesSection(votes: number) {
  if (votes <= 0) return "";
  return `${VOTES_START}\n👍 **${votes}** ${votes === 1 ? "vote" : "votes"} on Discord\n${VOTES_END}`;
}

/** Replaces (or appends, or removes) the vote section in an issue body. */
export function withVotes(body: string, votes: number) {
  const pattern = new RegExp(`\\n*${VOTES_START}[\\s\\S]*?${VOTES_END}`);
  const section = votesSection(votes);
  if (pattern.test(body)) return body.replace(pattern, section ? `\n\n${section}` : "");
  return section ? `${body.trimEnd()}\n\n${section}` : body;
}

/** Writes the Discord vote count into the issue body, editing only if it changed. */
export async function setIssueVotes(repo: string, issueNumber: number, votes: number) {
  const issue = await getIssue(repo, issueNumber);
  if (!issue) return;

  const body = issue.body ?? "";
  const next = withVotes(body, votes);
  if (next !== body) await octokit.rest.issues.update({ ...split(repo), issue_number: issueNumber, body: next });
}

// Words too common in post titles to say anything about whether two posts match.
const STOP_WORDS = new Set(
  (
    "the and for with that this from when what why how can cant not but are was were you your have has had does doesnt " +
    "dont isnt wont into there their about after before would could should please help issue issues problem error " +
    "bug feature request add adding support working work works make using use get just like need want any all some " +
    "way able new still only also its it's they them then than been being will one more other"
  ).split(" "),
);

function keywords(text: string) {
  const words = text.toLowerCase().replaceAll("'", "").match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function stem(word: string) {
  const stemmed = word.replace(/(?:ing|ed|es|s)$/, "");
  return stemmed.length >= 3 ? stemmed : word;
}

export interface SimilarIssue {
  number: number;
  title: string;
  url: string;
  open: boolean;
}

/** Finds existing issues whose titles share at least two keywords with `title` (or all of them, if fewer). */
export async function findSimilarIssues(repo: string, title: string, limit = 3): Promise<SimilarIssue[]> {
  // GitHub search allows at most five AND/OR/NOT operators.
  const terms = keywords(title).slice(0, 6);
  if (terms.length === 0) return [];

  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${repo} is:issue in:title (${terms.join(" OR ")})`,
    per_page: 20,
  });

  // Compare word stems so "crashing" matches "crashes"; GitHub's search already does this on its side.
  const stems = terms.map(stem);
  const needed = Math.min(2, terms.length);
  return data.items
    .filter((item) => !item.pull_request)
    .map((item) => ({ item, score: new Set(keywords(item.title).map(stem).filter((s) => stems.includes(s))).size }))
    .filter(({ score }) => score >= needed)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => ({ number: item.number, title: item.title, url: item.html_url, open: item.state === "open" }));
}

export type IssueCloser =
  | { type: "pull_request"; number: number; title: string; url: string }
  | { type: "commit"; sha: string; url: string };

/** The pull request or commit that closed an issue, if any. Needs read access to pull requests and contents. */
export async function getIssueCloser(repo: string, issueNumber: number): Promise<IssueCloser | null> {
  type Closer = { __typename: string; number?: number; title?: string; url?: string; abbreviatedOid?: string };
  type Result = { repository: { issue: { timelineItems: { nodes: { closer: Closer | null }[] } } | null } | null };

  const result = await octokit.graphql<Result>(
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) {
            nodes {
              ... on ClosedEvent {
                closer {
                  __typename
                  ... on PullRequest { number title url }
                  ... on Commit { abbreviatedOid url }
                }
              }
            }
          }
        }
      }
    }`,
    { ...split(repo), number: issueNumber },
  );

  const closer = result.repository?.issue?.timelineItems.nodes[0]?.closer;
  if (closer?.__typename === "PullRequest" && closer.number && closer.url) {
    return { type: "pull_request", number: closer.number, title: closer.title ?? "", url: closer.url };
  }
  if (closer?.__typename === "Commit" && closer.abbreviatedOid && closer.url) {
    return { type: "commit", sha: closer.abbreviatedOid, url: closer.url };
  }
  return null;
}

/**
 * Resolves issue and pull request numbers (e.g. from release notes) to the issues they stand for:
 * an issue is itself, and a pull request stands for the issues it closes.
 */
export async function resolveShippedIssues(repo: string, numbers: number[]) {
  if (numbers.length === 0) return [];

  type Node =
    | { __typename: "Issue"; number: number }
    | { __typename: "PullRequest"; closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[] } }
    | null;
  type Result = { repository: Record<string, Node> | null };

  const fields = numbers.map(
    (n) => `n${n}: issueOrPullRequest(number: ${n}) {
      __typename
      ... on Issue { number }
      ... on PullRequest { closingIssuesReferences(first: 25) { nodes { number repository { nameWithOwner } } } }
    }`,
  );
  const query = `query ($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields.join("\n")} } }`;

  let result: Result | undefined;
  try {
    result = await octokit.graphql<Result>(query, split(repo));
  } catch (error) {
    // Numbers that don't exist come back as errors alongside the data for the ones that do.
    result = (error as { data?: Result }).data;
    if (!result) throw error;
  }

  const issues = new Map<string, { repo: string; number: number }>();
  for (const node of Object.values(result.repository ?? {})) {
    if (node?.__typename === "Issue") {
      issues.set(`${repoKey(repo)}#${node.number}`, { repo, number: node.number });
    } else if (node?.__typename === "PullRequest") {
      for (const ref of node.closingIssuesReferences.nodes) {
        const refRepo = ref.repository.nameWithOwner;
        issues.set(`${repoKey(refRepo)}#${ref.number}`, { repo: refRepo, number: ref.number });
      }
    }
  }
  return [...issues.values()];
}
