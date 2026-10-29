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
  CREATE TABLE IF NOT EXISTS post_details (
    thread_id  TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    answers    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS announcements (
    message_id TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS faq_entries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id          TEXT NOT NULL,
    category          TEXT NOT NULL,
    question          TEXT NOT NULL,
    answer            TEXT NOT NULL,
    source_thread_ids TEXT NOT NULL DEFAULT '',
    updated_by        TEXT NOT NULL,
    updated_at        INTEGER NOT NULL,
    uses              INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS faq_entries_guild ON faq_entries (guild_id);
`);

// Columns added after the first release.
function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("forums", "repo", "TEXT");
// JSON array of questions; NULL means the defaults for the forum's kind.
addColumn("forums", "detail_questions", "TEXT");
addColumn("faq_entries", "position", "INTEGER");

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

const removeGuildStatements = ["issue_links", "forums", "staff_roles", "posts", "guild_settings", "announcements", "post_details", "faq_entries"].map((table) =>
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
  /** Questions asked by the welcome message's "Add details" button; null means the defaults. */
  detailQuestions: string[] | null;
}

const FORUM_SELECT = `
  SELECT channel_id AS channelId, guild_id AS guildId, kind, repo, detail_questions AS detailQuestions FROM forums`;

function toForum(row: unknown): ForumConfig {
  const forum = row as Omit<ForumConfig, "detailQuestions"> & { detailQuestions: string | null };
  return { ...forum, detailQuestions: forum.detailQuestions === null ? null : JSON.parse(forum.detailQuestions) };
}

const forumStatements = {
  get: db.prepare(`${FORUM_SELECT} WHERE channel_id = ?`),
  list: db.prepare(`${FORUM_SELECT} WHERE guild_id = ? ORDER BY kind`),
  // Re-registering a forum without a repo keeps the one it already has.
  upsert: db.prepare(`
    INSERT INTO forums (channel_id, guild_id, kind, repo) VALUES (?, ?, ?, ?)
    ON CONFLICT (channel_id) DO UPDATE SET kind = excluded.kind, repo = COALESCE(excluded.repo, forums.repo)`),
  remove: db.prepare(`DELETE FROM forums WHERE channel_id = ?`),
  setDetailQuestions: db.prepare(`UPDATE forums SET detail_questions = ? WHERE channel_id = ?`),
};

/** Forum channels registered with /setup forum, and the kind of request each one holds. */
export const forums = {
  get(channelId: string) {
    const row = forumStatements.get.get(channelId);
    return row ? toForum(row) : undefined;
  },
  list(guildId: string) {
    return forumStatements.list.all(guildId).map(toForum);
  },
  set(forum: Omit<ForumConfig, "detailQuestions">) {
    forumStatements.upsert.run(forum.channelId, forum.guildId, forum.kind, forum.repo);
  },
  /** Returns true if the channel was registered. */
  remove(channelId: string) {
    return forumStatements.remove.run(channelId).changes > 0;
  },
  /** Pass `null` to go back to the defaults for the forum's kind. */
  setDetailQuestions(channelId: string, questions: string[] | null) {
    forumStatements.setDetailQuestions.run(questions === null ? null : JSON.stringify(questions), channelId);
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

export interface Announcement {
  messageId: string;
  guildId: string;
  channelId: string;
  createdBy: string;
  createdAt: number;
}

const announcementStatements = {
  get: db.prepare(`
    SELECT message_id AS messageId, guild_id AS guildId, channel_id AS channelId,
           created_by AS createdBy, created_at AS createdAt
    FROM announcements WHERE message_id = ?`),
  insert: db.prepare(`
    INSERT INTO announcements (message_id, guild_id, channel_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)`),
  remove: db.prepare(`DELETE FROM announcements WHERE message_id = ?`),
};

/** Messages posted with /announce, so /announce edit only touches those. */
export const announcements = {
  get(messageId: string) {
    return announcementStatements.get.get(messageId) as Announcement | undefined;
  },
  add(announcement: Omit<Announcement, "createdAt">) {
    announcementStatements.insert.run(
      announcement.messageId,
      announcement.guildId,
      announcement.channelId,
      announcement.createdBy,
      Date.now(),
    );
  },
  remove(messageId: string) {
    announcementStatements.remove.run(messageId);
  },
};

export interface PostDetail {
  question: string;
  answer: string;
}

const detailStatements = {
  get: db.prepare(`SELECT answers FROM post_details WHERE thread_id = ?`),
  upsert: db.prepare(`
    INSERT INTO post_details (thread_id, guild_id, answers, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at`),
  remove: db.prepare(`DELETE FROM post_details WHERE thread_id = ?`),
};

/** Answers given with a post's "Add details" button, included when the post becomes a GitHub issue. */
export const postDetails = {
  get(threadId: string) {
    const row = detailStatements.get.get(threadId) as { answers: string } | undefined;
    return row ? (JSON.parse(row.answers) as PostDetail[]) : [];
  },
  set(threadId: string, guildId: string, answers: PostDetail[]) {
    detailStatements.upsert.run(threadId, guildId, JSON.stringify(answers), Date.now());
  },
  remove(threadId: string) {
    detailStatements.remove.run(threadId);
  },
};

export interface FaqEntry {
  id: number;
  guildId: string;
  category: string;
  question: string;
  answer: string;
  /** Posts that asked this question; empty for entries written by hand. */
  sourceThreadIds: string[];
  updatedBy: string;
  updatedAt: number;
  /** Times it was sent with /faq send. */
  uses: number;
  /** Importance from the last /faq merge (1 is most important); null for entries added since. Breaks ties. */
  position: number | null;
}

/** How often a question comes up: posts that asked it, plus times staff answered a post with it. */
export function faqRelevance(entry: FaqEntry) {
  return entry.sourceThreadIds.length + entry.uses;
}

/** Most asked first; ties go to the order from the last merge, then the oldest entry. */
function byRelevance(a: FaqEntry, b: FaqEntry) {
  return (
    faqRelevance(b) - faqRelevance(a) ||
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) ||
    a.id - b.id
  );
}

const FAQ_SELECT = `
  SELECT id, guild_id AS guildId, category, question, answer, source_thread_ids AS sourceThreadIds,
         updated_by AS updatedBy, updated_at AS updatedAt, uses, position
  FROM faq_entries`;

function toFaqEntry(row: unknown): FaqEntry {
  const entry = row as Omit<FaqEntry, "sourceThreadIds"> & { sourceThreadIds: string };
  return { ...entry, sourceThreadIds: entry.sourceThreadIds.split(",").filter(Boolean) };
}

const faqStatements = {
  get: db.prepare(`${FAQ_SELECT} WHERE id = ? AND guild_id = ?`),
  list: db.prepare(`${FAQ_SELECT} WHERE guild_id = ?`),
  insert: db.prepare(`
    INSERT INTO faq_entries (guild_id, category, question, answer, source_thread_ids, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  update: db.prepare(`
    UPDATE faq_entries SET category = ?, question = ?, answer = ?, updated_by = ?, updated_at = ? WHERE id = ? AND guild_id = ?`),
  sources: db.prepare(`UPDATE faq_entries SET source_thread_ids = ? WHERE id = ?`),
  merged: db.prepare(`
    UPDATE faq_entries SET category = ?, question = ?, answer = ?, source_thread_ids = ?, uses = ?, position = ?,
                           updated_by = ?, updated_at = ?
    WHERE id = ?`),
  remove: db.prepare(`DELETE FROM faq_entries WHERE id = ? AND guild_id = ?`),
  used: db.prepare(`UPDATE faq_entries SET uses = uses + 1 WHERE id = ?`),
};

type FaqContent = Pick<FaqEntry, "category" | "question" | "answer">;

/** One entry of the FAQ after /faq merge: the IDs it combines (the first one is kept) and its new text. */
export interface FaqMerge extends FaqContent {
  ids: number[];
}

/** FAQ entries compiled with /faq generate or written with /faq add, which staff can edit and send into posts. */
export const faqs = {
  get(guildId: string, id: number) {
    const row = faqStatements.get.get(id, guildId);
    return row ? toFaqEntry(row) : undefined;
  },
  /** Every entry, most asked first. */
  list(guildId: string) {
    return faqStatements.list.all(guildId).map(toFaqEntry).sort(byRelevance);
  },
  add(guildId: string, content: FaqContent & { sourceThreadIds?: string[] }, userId: string) {
    const result = faqStatements.insert.run(
      guildId,
      content.category,
      content.question,
      content.answer,
      [...new Set(content.sourceThreadIds)].join(","),
      userId,
      Date.now(),
    );
    return Number(result.lastInsertRowid);
  },
  /** Returns true if the entry exists. */
  update(guildId: string, id: number, content: FaqContent, userId: string) {
    return (
      faqStatements.update.run(content.category, content.question, content.answer, userId, Date.now(), id, guildId).changes > 0
    );
  },
  /** Records more posts that asked an entry's question. Returns how many of them weren't recorded yet. */
  addSources(guildId: string, id: number, threadIds: string[]) {
    const entry = faqs.get(guildId, id);
    if (!entry) return 0;
    const sources = new Set([...entry.sourceThreadIds, ...threadIds]);
    faqStatements.sources.run([...sources].join(","), id);
    return sources.size - entry.sourceThreadIds.length;
  },
  /**
   * Replaces the FAQ with `merged`, in order of importance: each item keeps its first entry, takes the posts and
   * use counts of the others, and deletes them. Entries not in `merged` are deleted too.
   */
  merge(guildId: string, merged: FaqMerge[], userId: string) {
    const entries = new Map(faqs.list(guildId).map((entry) => [entry.id, entry]));
    db.exec("BEGIN");
    try {
      merged.forEach((item, index) => {
        const parts = item.ids.map((id) => entries.get(id)!);
        const sources = new Set(parts.flatMap((part) => part.sourceThreadIds));
        const uses = parts.reduce((sum, part) => sum + part.uses, 0);
        faqStatements.merged.run(
          item.category, item.question, item.answer, [...sources].join(","), uses, index + 1, userId, Date.now(), item.ids[0]!,
        );
        // The first entry was updated above; any others were merged into it, so they're deleted below.
        entries.delete(item.ids[0]!);
      });
      for (const id of entries.keys()) faqStatements.remove.run(id, guildId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  /** Returns true if the entry existed. */
  remove(guildId: string, id: number) {
    return faqStatements.remove.run(id, guildId).changes > 0;
  },
  markUsed(id: number) {
    faqStatements.used.run(id);
  },
};
