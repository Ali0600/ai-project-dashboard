import { getDb } from "./db";
import { PRIORITY_RANK } from "./types";
import type {
  ConversationRow,
  ItemKind,
  ItemRow,
  ItemStatus,
  ItemWithSource,
  Priority,
  ProjectRow,
} from "./types";
import type { TranscriptMeta } from "./transcripts";

/** Normalize a title into a stable de-dup key. */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Parent directory name of a path (used as a project-key fallback — never the file itself). */
function parentDirName(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 2] || "unknown";
}

/* --------------------------------- projects ------------------------------ */

export function getOrCreateProject(cwd: string, name?: string): ProjectRow {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM projects WHERE cwd = ?").get(cwd) as
    | ProjectRow
    | undefined;
  if (existing) return existing;
  const info = db
    .prepare("INSERT INTO projects (cwd, name) VALUES (?, ?)")
    .run(cwd, name || basename(cwd));
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(info.lastInsertRowid) as ProjectRow;
}

export interface ProjectSummary extends ProjectRow {
  open_tasks: number;
  total_items: number;
  needs_scan: number;
  last_activity_at: string | null;
}

export function listProjects(): ProjectSummary[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM items i
           WHERE i.project_id = p.id AND i.kind = 'task'
             AND i.status IN ('todo','in_progress')) AS open_tasks,
        (SELECT COUNT(*) FROM items i
           WHERE i.project_id = p.id AND i.status != 'dismissed') AS total_items,
        (SELECT COUNT(*) FROM conversations c
           WHERE c.project_id = p.id AND c.scan_status = 'needs_scan') AS needs_scan,
        (SELECT MAX(c.last_activity_at) FROM conversations c
           WHERE c.project_id = p.id) AS last_activity_at
       FROM projects p
       ORDER BY last_activity_at DESC NULLS LAST, p.id DESC`,
    )
    .all() as ProjectSummary[];
}

export function getProject(id: number): ProjectRow | undefined {
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

/* ------------------------------ conversations ---------------------------- */

export function upsertConversation(
  meta: TranscriptMeta,
  scanStatus: "needs_scan" | "scanned" = "needs_scan",
): ConversationRow {
  const db = getDb();
  const project = getOrCreateProject(meta.cwd || parentDirName(meta.transcriptPath));
  db.prepare(
    `INSERT INTO conversations
       (session_id, project_id, title, slug, transcript_path, scan_status, started_at, last_activity_at)
     VALUES (@session_id, @project_id, @title, @slug, @transcript_path, @scan_status, @started_at, @last_activity_at)
     ON CONFLICT(session_id) DO UPDATE SET
       title = COALESCE(excluded.title, conversations.title),
       slug = COALESCE(excluded.slug, conversations.slug),
       transcript_path = excluded.transcript_path,
       last_activity_at = excluded.last_activity_at,
       scan_status = @scan_status`,
  ).run({
    session_id: meta.sessionId,
    project_id: project.id,
    title: meta.title,
    slug: meta.slug,
    transcript_path: meta.transcriptPath,
    scan_status: scanStatus,
    started_at: meta.startedAt,
    last_activity_at: meta.lastActivityAt,
  });
  return db
    .prepare("SELECT * FROM conversations WHERE session_id = ?")
    .get(meta.sessionId) as ConversationRow;
}

export function getConversation(id: number): ConversationRow | undefined {
  return getDb().prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
    | ConversationRow
    | undefined;
}

export function getConversationBySession(sessionId: string): ConversationRow | undefined {
  return getDb().prepare("SELECT * FROM conversations WHERE session_id = ?").get(sessionId) as
    | ConversationRow
    | undefined;
}

export function listConversations(projectId: number): ConversationRow[] {
  return getDb()
    .prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY last_activity_at DESC")
    .all(projectId) as ConversationRow[];
}

export function markConversationScanned(id: number, lastUuid: string | null): void {
  getDb()
    .prepare(
      `UPDATE conversations
         SET scan_status = 'scanned', last_scanned_uuid = ?, last_scanned_at = datetime('now')
       WHERE id = ?`,
    )
    .run(lastUuid, id);
}

/* ---------------------------------- items -------------------------------- */

export function listItems(projectId: number, kind?: ItemKind): ItemRow[] {
  const db = getDb();
  if (kind) {
    return db
      .prepare("SELECT * FROM items WHERE project_id = ? AND kind = ? ORDER BY priority ASC, id DESC")
      .all(projectId, kind) as ItemRow[];
  }
  return db
    .prepare("SELECT * FROM items WHERE project_id = ? ORDER BY priority ASC, id DESC")
    .all(projectId) as ItemRow[];
}

/** Items joined with their source conversation (title + when). */
export function listItemsWithSource(projectId: number, kind?: ItemKind): ItemWithSource[] {
  const db = getDb();
  const base = `
    SELECT i.*, c.title AS conversation_title, c.started_at AS conversation_at
    FROM items i
    LEFT JOIN conversations c ON c.id = i.conversation_id
    WHERE i.project_id = ?`;
  if (kind) {
    return db
      .prepare(`${base} AND i.kind = ? ORDER BY i.priority ASC, i.id DESC`)
      .all(projectId, kind) as ItemWithSource[];
  }
  return db
    .prepare(`${base} ORDER BY i.priority ASC, i.id DESC`)
    .all(projectId) as ItemWithSource[];
}

/** Open tasks (id + title) for a project — used by the re-prioritization pass. */
export function openTasks(projectId: number): { id: number; title: string }[] {
  return getDb()
    .prepare(
      "SELECT id, title FROM items WHERE project_id = ? AND kind = 'task' AND status IN ('todo','in_progress') ORDER BY id DESC",
    )
    .all(projectId) as { id: number; title: string }[];
}

/** Titles of open items, used to tell the extractor what already exists. */
export function openItemTitles(projectId: number): string[] {
  return (
    getDb()
      .prepare(
        "SELECT title FROM items WHERE project_id = ? AND status IN ('todo','in_progress') ORDER BY id DESC",
      )
      .all(projectId) as { title: string }[]
  ).map((r) => r.title);
}

export interface InsertItemArgs {
  projectId: number;
  conversationId?: number | null;
  kind: ItemKind;
  title: string;
  detail?: string;
  status?: ItemStatus;
  priority?: Priority;
  sourceQuote?: string;
}

/** Insert an item; returns the new row id, or null if it was a duplicate/tombstone. */
export function insertItem(a: InsertItemArgs): number | null {
  const info = getDb()
    .prepare(
      `INSERT INTO items
         (project_id, conversation_id, kind, title, detail, status, priority, source_quote, norm_key)
       VALUES (@project_id, @conversation_id, @kind, @title, @detail, @status, @priority, @source_quote, @norm_key)
       ON CONFLICT(project_id, kind, norm_key) DO NOTHING`,
    )
    .run({
      project_id: a.projectId,
      conversation_id: a.conversationId ?? null,
      kind: a.kind,
      title: a.title,
      detail: a.detail ?? "",
      status: a.status ?? "todo",
      priority: PRIORITY_RANK[a.priority ?? "medium"],
      source_quote: a.sourceQuote ?? "",
      norm_key: normalizeTitle(a.title),
    });
  return info.changes > 0 ? Number(info.lastInsertRowid) : null;
}

export function updateItemStatus(id: number, status: ItemStatus): void {
  getDb()
    .prepare("UPDATE items SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
}

export function updateItemPriority(id: number, priority: Priority): void {
  getDb()
    .prepare("UPDATE items SET priority = ?, updated_at = datetime('now') WHERE id = ?")
    .run(PRIORITY_RANK[priority], id);
}

export interface ItemContext {
  item: ItemRow;
  projectCwd: string;
  sessionId: string | null;
}

/** Item plus its project cwd and source conversation session id (for implement runs). */
export function getItemContext(id: number): ItemContext | undefined {
  const row = getDb()
    .prepare(
      `SELECT i.*, p.cwd AS project_cwd, c.session_id AS session_id
         FROM items i
         JOIN projects p ON p.id = i.project_id
         LEFT JOIN conversations c ON c.id = i.conversation_id
        WHERE i.id = ?`,
    )
    .get(id) as (ItemRow & { project_cwd: string; session_id: string | null }) | undefined;
  if (!row) return undefined;
  const { project_cwd, session_id, ...item } = row;
  return { item: item as ItemRow, projectCwd: project_cwd, sessionId: session_id };
}

export function saveImplementationPlan(id: number, plan: string): void {
  getDb()
    .prepare("UPDATE items SET implementation_plan = ?, updated_at = datetime('now') WHERE id = ?")
    .run(plan, id);
}

/** Flag an open item as "looks done" with supporting evidence. */
export function flagSuggestedDone(projectId: number, idOrTitle: string, evidence: string): boolean {
  const db = getDb();
  let row: ItemRow | undefined;
  if (/^\d+$/.test(idOrTitle)) {
    row = db.prepare("SELECT * FROM items WHERE id = ? AND project_id = ?").get(
      Number(idOrTitle),
      projectId,
    ) as ItemRow | undefined;
  }
  if (!row) {
    row = db
      .prepare(
        `SELECT * FROM items
           WHERE project_id = ? AND norm_key = ? AND status IN ('todo','in_progress')
           ORDER BY id DESC LIMIT 1`,
      )
      .get(projectId, normalizeTitle(idOrTitle)) as ItemRow | undefined;
  }
  if (!row || row.status === "done" || row.status === "dismissed") return false;
  db.prepare(
    "UPDATE items SET suggested_done = 1, done_evidence = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(evidence, row.id);
  return true;
}

/** Confirm a "looks done" suggestion -> move to done. */
export function confirmDone(id: number): void {
  getDb()
    .prepare(
      "UPDATE items SET status = 'done', suggested_done = 0, updated_at = datetime('now') WHERE id = ?",
    )
    .run(id);
}

/** Reject a "looks done" suggestion -> keep the task, clear the flag. */
export function dismissSuggestion(id: number): void {
  getDb()
    .prepare("UPDATE items SET suggested_done = 0, updated_at = datetime('now') WHERE id = ?")
    .run(id);
}
