import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config, type IssueKind } from "./config.js";

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });

export const db = new DatabaseSync(config.DATABASE_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS issue_links (
    thread_id    TEXT PRIMARY KEY,
    guild_id     TEXT NOT NULL,
    repo         TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_url    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    UNIQUE (repo, issue_number)
  );
  CREATE TABLE IF NOT EXISTS forums (
    channel_id TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    kind       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS staff_roles (
    role_id  TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    thread_id         TEXT PRIMARY KEY,
    guild_id          TEXT NOT NULL,
    forum_id          TEXT NOT NULL,
    kind              TEXT NOT NULL,
    author_id         TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    first_response_at INTEGER,
    last_staff_at     INTEGER,
    last_author_at    INTEGER,
    alerted_at        INTEGER,
    closed_at         INTEGER,
    close_reason      TEXT,
    tag_ids           TEXT NOT NULL DEFAULT '',
    votes             INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS posts_guild_created ON posts (guild_id, created_at);
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id         TEXT PRIMARY KEY,
    alert_channel_id TEXT,
    alert_role_id    TEXT,
    alert_after_mins INTEGER,
    autoclose_after_mins INTEGER
  );
`);

// Columns added after the first release.
function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("forums", "repo", "TEXT");

export interface IssueLink {
  threadId: string;
  guildId: string;
  /** Lowercased `owner/repo`. */
  repo: string;
  issueNumber: number;
  issueUrl: string;
  kind: IssueKind;
  createdBy: string;
  createdAt: number;
}

const SELECT = `
  SELECT thread_id AS threadId, guild_id AS guildId, repo, issue_number AS issueNumber,
         issue_url AS issueUrl, kind, created_by AS createdBy, created_at AS createdAt
  FROM issue_links`;

const statements = {
  byThread: db.prepare(`${SELECT} WHERE thread_id = ?`),
  byIssue: db.prepare(`${SELECT} WHERE repo = ? AND issue_number = ?`),
  insert: db.prepare(`
    INSERT INTO issue_links (thread_id, guild_id, repo, issue_number, issue_url, kind, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  removeByThread: db.prepare(`DELETE FROM issue_links WHERE thread_id = ?`),
  removeByIssue: db.prepare(`DELETE FROM issue_links WHERE repo = ? AND issue_number = ?`),
};

export const links = {
  byThread(threadId: string) {
    return statements.byThread.get(threadId) as IssueLink | undefined;
  },
  byIssue(repo: string, issueNumber: number) {
    return statements.byIssue.get(repo.toLowerCase(), issueNumber) as IssueLink | undefined;
  },
  create(link: Omit<IssueLink, "createdAt">): IssueLink {
    const createdAt = Date.now();
    statements.insert.run(
      link.threadId,
      link.guildId,
      link.repo.toLowerCase(),
      link.issueNumber,
      link.issueUrl,
      link.kind,
      link.createdBy,
      createdAt,
    );
    return { ...link, repo: link.repo.toLowerCase(), createdAt };
  },
  removeByThread(threadId: string) {
    statements.removeByThread.run(threadId);
  },
  removeByIssue(repo: string, issueNumber: number) {
    statements.removeByIssue.run(repo.toLowerCase(), issueNumber);
  },
};

const removeGuildStatements = ["issue_links", "forums", "staff_roles", "posts", "guild_settings"].map((table) =>
  db.prepare(`DELETE FROM ${table} WHERE guild_id = ?`),
);

/** Forgets everything stored for a server, e.g. when the bot is removed from it. */
export function removeGuildData(guildId: string) {
  for (const statement of removeGuildStatements) statement.run(guildId);
}

export interface ForumConfig {
  channelId: string;
  guildId: string;
  kind: IssueKind;
  /** `owner/repo` for this forum's issues; null means GITHUB_OWNER/GITHUB_REPO. */
  repo: string | null;
}

const FORUM_SELECT = `SELECT channel_id AS channelId, guild_id AS guildId, kind, repo FROM forums`;

const forumStatements = {
  get: db.prepare(`${FORUM_SELECT} WHERE channel_id = ?`),
  list: db.prepare(`${FORUM_SELECT} WHERE guild_id = ? ORDER BY kind`),
  // Re-registering a forum without a repo keeps the one it already has.
  upsert: db.prepare(`
    INSERT INTO forums (channel_id, guild_id, kind, repo) VALUES (?, ?, ?, ?)
    ON CONFLICT (channel_id) DO UPDATE SET kind = excluded.kind, repo = COALESCE(excluded.repo, forums.repo)`),
  remove: db.prepare(`DELETE FROM forums WHERE channel_id = ?`),
};

/** Forum channels registered with /setup forum, and the kind of request each one holds. */
export const forums = {
  get(channelId: string) {
    return forumStatements.get.get(channelId) as ForumConfig | undefined;
  },
  list(guildId: string) {
    return forumStatements.list.all(guildId) as unknown as ForumConfig[];
  },
  set(forum: ForumConfig) {
    forumStatements.upsert.run(forum.channelId, forum.guildId, forum.kind, forum.repo);
  },
  /** Returns true if the channel was registered. */
  remove(channelId: string) {
    return forumStatements.remove.run(channelId).changes > 0;
  },
};

const staffStatements = {
  list: db.prepare(`SELECT role_id AS roleId FROM staff_roles WHERE guild_id = ?`),
  add: db.prepare(`INSERT OR IGNORE INTO staff_roles (role_id, guild_id) VALUES (?, ?)`),
  remove: db.prepare(`DELETE FROM staff_roles WHERE role_id = ?`),
};

/** Roles registered with /setup staff add. Their members can manage issues and resolve any post. */
export const staffRoles = {
  list(guildId: string) {
    return (staffStatements.list.all(guildId) as { roleId: string }[]).map((row) => row.roleId);
  },
  /** Returns true if the role was newly added. */
  add(guildId: string, roleId: string) {
    return staffStatements.add.run(roleId, guildId).changes > 0;
  },
  /** Returns true if the role was registered. */
  remove(roleId: string) {
    return staffStatements.remove.run(roleId).changes > 0;
  },
};

export interface Post {
  threadId: string;
  guildId: string;
  forumId: string;
  kind: IssueKind;
  authorId: string;
  createdAt: number;
  /** When staff first replied, on Discord or GitHub. */
  firstResponseAt: number | null;
  /** When staff last replied, on Discord or GitHub. */
  lastStaffAt: number | null;
  /** When the post's author last wrote in it (or reactivated it). */
  lastAuthorAt: number | null;
  /** When the unanswered-post alert was sent. */
  alertedAt: number | null;
  closedAt: number | null;
  closeReason: string | null;
  /** Comma-separated IDs of the forum tags applied to the post. */
  tagIds: string;
  votes: number;
}

const POST_SELECT = `
  SELECT thread_id AS threadId, guild_id AS guildId, forum_id AS forumId, kind, author_id AS authorId,
         created_at AS createdAt, first_response_at AS firstResponseAt, last_staff_at AS lastStaffAt,
         last_author_at AS lastAuthorAt, alerted_at AS alertedAt,
         closed_at AS closedAt, close_reason AS closeReason, tag_ids AS tagIds, votes
  FROM posts`;

const postStatements = {
  get: db.prepare(`${POST_SELECT} WHERE thread_id = ?`),
  insert: db.prepare(`
    INSERT OR IGNORE INTO posts (thread_id, guild_id, forum_id, kind, author_id, created_at, tag_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  staffReply: db.prepare(`
    UPDATE posts SET first_response_at = COALESCE(first_response_at, ?1), last_staff_at = ?1 WHERE thread_id = ?2`),
  authorReply: db.prepare(`UPDATE posts SET last_author_at = ? WHERE thread_id = ?`),
  alerted: db.prepare(`UPDATE posts SET alerted_at = ? WHERE thread_id = ?`),
  closed: db.prepare(`UPDATE posts SET closed_at = ?, close_reason = ? WHERE thread_id = ?`),
  reopened: db.prepare(`UPDATE posts SET closed_at = NULL, close_reason = NULL WHERE thread_id = ?`),
  tags: db.prepare(`UPDATE posts SET tag_ids = ? WHERE thread_id = ?`),
  votes: db.prepare(`UPDATE posts SET votes = ? WHERE thread_id = ?`),
  remove: db.prepare(`DELETE FROM posts WHERE thread_id = ?`),
  unanswered: db.prepare(`
    ${POST_SELECT} WHERE guild_id = ? AND created_at <= ?
      AND first_response_at IS NULL AND alerted_at IS NULL AND closed_at IS NULL`),
  // Support posts where staff replied last and the author hasn't written since, ignoring posts linked to an issue.
  awaitingAuthor: db.prepare(`
    ${POST_SELECT} WHERE guild_id = ? AND kind = 'support' AND closed_at IS NULL
      AND last_staff_at IS NOT NULL AND last_staff_at <= ?
      AND (last_author_at IS NULL OR last_author_at < last_staff_at)
      AND thread_id NOT IN (SELECT thread_id FROM issue_links)`),
  active: db.prepare(`${POST_SELECT} WHERE guild_id = ? AND (created_at >= ? OR closed_at >= ? OR closed_at IS NULL)`),
};

/** Posts in managed forums, tracked from when they're created. Feeds unanswered alerts and /stats. */
export const posts = {
  get(threadId: string) {
    return postStatements.get.get(threadId) as Post | undefined;
  },
  create(post: Pick<Post, "threadId" | "guildId" | "forumId" | "kind" | "authorId" | "createdAt" | "tagIds">) {
    postStatements.insert.run(
      post.threadId,
      post.guildId,
      post.forumId,
      post.kind,
      post.authorId,
      post.createdAt,
      post.tagIds,
    );
  },
  /** Records a reply from staff, on Discord or GitHub. */
  markStaffReply(threadId: string, at = Date.now()) {
    postStatements.staffReply.run(at, threadId);
  },
  /** Records activity from the post's author. */
  markAuthorReply(threadId: string, at = Date.now()) {
    postStatements.authorReply.run(at, threadId);
  },
  markAlerted(threadId: string, at = Date.now()) {
    postStatements.alerted.run(at, threadId);
  },
  markClosed(threadId: string, reason: string, at = Date.now()) {
    postStatements.closed.run(at, reason, threadId);
  },
  markReopened(threadId: string) {
    postStatements.reopened.run(threadId);
  },
  setTags(threadId: string, tagIds: readonly string[]) {
    postStatements.tags.run(tagIds.join(","), threadId);
  },
  setVotes(threadId: string, votes: number) {
    postStatements.votes.run(votes, threadId);
  },
  remove(threadId: string) {
    postStatements.remove.run(threadId);
  },
  /** Open posts created before `cutoff` that no staff member has replied to and no alert has gone out for. */
  unanswered(guildId: string, cutoff: number) {
    return postStatements.unanswered.all(guildId, cutoff) as unknown as Post[];
  },
  /** Open, unlinked support posts waiting on their author since before `cutoff`. */
  awaitingAuthor(guildId: string, cutoff: number) {
    return postStatements.awaitingAuthor.all(guildId, cutoff) as unknown as Post[];
  },
  /** Posts created or closed since `since`, plus every post that's still open. */
  activeSince(guildId: string, since: number) {
    return postStatements.active.all(guildId, since, since) as unknown as Post[];
  },
};

export interface GuildSettings {
  guildId: string;
  alertChannelId: string | null;
  alertRoleId: string | null;
  alertAfterMins: number | null;
  autoCloseAfterMins: number | null;
}

const SETTINGS_SELECT = `
  SELECT guild_id AS guildId, alert_channel_id AS alertChannelId, alert_role_id AS alertRoleId,
         alert_after_mins AS alertAfterMins, autoclose_after_mins AS autoCloseAfterMins
  FROM guild_settings`;

const settingsStatements = {
  get: db.prepare(`${SETTINGS_SELECT} WHERE guild_id = ?`),
  withAlerts: db.prepare(`${SETTINGS_SELECT} WHERE alert_channel_id IS NOT NULL AND alert_after_mins IS NOT NULL`),
  setAlerts: db.prepare(`
    INSERT INTO guild_settings (guild_id, alert_channel_id, alert_role_id, alert_after_mins) VALUES (?, ?, ?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET
      alert_channel_id = excluded.alert_channel_id,
      alert_role_id = excluded.alert_role_id,
      alert_after_mins = excluded.alert_after_mins`),
  withAutoClose: db.prepare(`${SETTINGS_SELECT} WHERE autoclose_after_mins IS NOT NULL`),
  setAutoClose: db.prepare(`
    INSERT INTO guild_settings (guild_id, autoclose_after_mins) VALUES (?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET autoclose_after_mins = excluded.autoclose_after_mins`),
};

/** Per-server options set with /setup. */
export const guildSettings = {
  get(guildId: string) {
    return settingsStatements.get.get(guildId) as GuildSettings | undefined;
  },
  /** Servers that have unanswered-post alerts turned on. */
  withAlerts() {
    return settingsStatements.withAlerts.all() as unknown as GuildSettings[];
  },
  /** Pass `null`s to turn alerts off. */
  setAlerts(guildId: string, channelId: string | null, roleId: string | null, afterMins: number | null) {
    settingsStatements.setAlerts.run(guildId, channelId, roleId, afterMins);
  },
  /** Servers that close inactive posts automatically. */
  withAutoClose() {
    return settingsStatements.withAutoClose.all() as unknown as GuildSettings[];
  },
  /** Pass `null` to stop closing inactive posts. */
  setAutoClose(guildId: string, afterMins: number | null) {
    settingsStatements.setAutoClose.run(guildId, afterMins);
  },
};
