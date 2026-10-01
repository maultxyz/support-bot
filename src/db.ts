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
`);

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

const removeGuildStatements = ["issue_links", "forums", "staff_roles"].map((table) =>
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
}

const forumStatements = {
  get: db.prepare(`SELECT channel_id AS channelId, guild_id AS guildId, kind FROM forums WHERE channel_id = ?`),
  list: db.prepare(`SELECT channel_id AS channelId, guild_id AS guildId, kind FROM forums WHERE guild_id = ? ORDER BY kind`),
  upsert: db.prepare(`
    INSERT INTO forums (channel_id, guild_id, kind) VALUES (?, ?, ?)
    ON CONFLICT (channel_id) DO UPDATE SET kind = excluded.kind`),
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
    forumStatements.upsert.run(forum.channelId, forum.guildId, forum.kind);
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
