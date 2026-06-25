import fs from "node:fs";
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

// Generic words stripped before fuzzy title matching, so the meaningful nouns dominate.
const STOP = new Set([
  "the", "and", "for", "with", "via", "from", "into", "your", "build", "add", "make",
  "create", "set", "use", "using", "app", "feature", "implement", "support", "new",
]);

/** Significant tokens of a title (lowercased, de-noised) — for fuzzy completion matching. */
export function tokenize(s: string): string[] {
  return normalizeTitle(s)
    .split(" ")
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Containment similarity between a reference string and a candidate title: the share of the
 * smaller token set that overlaps (1.0 when one set ⊆ the other). Lets a paraphrased "completed"
 * reference ("basket feature") match a longer stored title ("Build in-app basket optimizer …").
 */
export function titleMatchScore(ref: string, candidate: string): number {
  const a = new Set(tokenize(ref));
  const b = new Set(tokenize(candidate));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

/**
 * Jaccard similarity of two titles' token sets (|∩| / |∪|) plus the shared-token count. Used for
 * **de-duplication**: two tasks that are the same thing reworded have nearly identical token sets
 * (high Jaccard), whereas a shorter task that's merely a subset of a longer one scores lower — so
 * genuinely distinct-but-related tasks aren't wrongly merged.
 */
export function titleJaccard(a: string, b: string): { score: number; shared: number } {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return { score: 0, shared: 0 };
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return { score: union === 0 ? 0 : inter / union, shared: inter };
}

/** Minimum Jaccard + shared tokens for two titles to count as the same item (reworded). */
const DEDUP_JACCARD = 0.6;

/** Find an existing item (of any of `kinds`, any status) that is a reworded duplicate of `title`. */
export function findFuzzyDuplicate(
  projectId: number,
  kinds: ItemKind | ItemKind[],
  title: string,
): ItemRow | undefined {
  const list = Array.isArray(kinds) ? kinds : [kinds];
  if (list.length === 0) return undefined;
  const placeholders = list.map(() => "?").join(",");
  const items = getDb()
    .prepare(`SELECT * FROM items WHERE project_id = ? AND kind IN (${placeholders})`)
    .all(projectId, ...list) as ItemRow[];
  let best: ItemRow | undefined;
  let bestScore = 0;
  for (const it of items) {
    const { score, shared } = titleJaccard(title, it.title);
    if (shared >= 2 && score >= DEDUP_JACCARD && score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
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
  const rows = db
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM items i
           WHERE i.project_id = p.id AND i.kind = 'task'
             AND i.status IN ('todo','in_progress')) AS open_tasks,
        (SELECT COUNT(*) FROM items i
           WHERE i.project_id = p.id AND i.status != 'dismissed') AS total_items,
        (SELECT MAX(c.last_activity_at) FROM conversations c
           WHERE c.project_id = p.id) AS last_activity_at
       FROM projects p
       ORDER BY last_activity_at DESC NULLS LAST, p.id DESC`,
    )
    .all() as Omit<ProjectSummary, "needs_scan">[];
  // Compute needs_scan live (transcript newer than last scan), not just the stored flag.
  return rows.map((p) => ({
    ...p,
    needs_scan: listConversations(p.id).filter(hasUnscannedActivity).length,
  }));
}

/** True if the transcript has activity newer than our last scan (live "needs scan"). */
export function hasUnscannedActivity(conv: ConversationRow): boolean {
  // A transcript that no longer exists on disk can't be scanned — never "pending".
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(conv.transcript_path).mtimeMs;
  } catch {
    return false;
  }
  if (conv.scan_status === "needs_scan") return true;
  if (!conv.last_scanned_at) return true;
  const scannedMs = new Date(conv.last_scanned_at.replace(" ", "T") + "Z").getTime();
  return mtimeMs > scannedMs + 2000; // 2s grace so a just-scanned convo doesn't flap
}

export function getProject(id: number): ProjectRow | undefined {
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

/** Look up a project by its cwd without creating one (used by the hook to only flag known projects). */
export function getProjectByCwd(cwd: string): ProjectRow | undefined {
  return getDb().prepare("SELECT * FROM projects WHERE cwd = ?").get(cwd) as ProjectRow | undefined;
}

/** Delete a project and (via ON DELETE CASCADE) its conversations + items. */
export function deleteProject(id: number): void {
  getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
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
  const db = getDb();
  const normKey = normalizeTitle(a.title);
  // Cross-kind dedup (precedence task > suggestion): a suggestion that just repeats an
  // existing, non-dismissed task is redundant — skip it. Same-kind dups are handled by the
  // UNIQUE(project_id, kind, norm_key) constraint below.
  if (a.kind === "suggestion" && taskExistsWithKey(a.projectId, normKey)) return null;
  // Fuzzy dedup (any status — incl. done/dismissed) so a reworded version doesn't reappear on a
  // re-scan. A suggestion also dedups against TASKS (precedence task > suggestion), so "add
  // EXPO_TOKEN secret" doesn't come back as a suggestion once it's a done task. Learnings dedup
  // only against other learnings — a learning can legitimately share wording with a task.
  const dupKinds: ItemKind[] | null =
    a.kind === "suggestion"
      ? ["task", "suggestion"]
      : a.kind === "task"
        ? ["task"]
        : a.kind === "learning"
          ? ["learning"]
          : null;
  if (dupKinds && findFuzzyDuplicate(a.projectId, dupKinds, a.title)) return null;

  const info = db
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
      norm_key: normKey,
    });
  return info.changes > 0 ? Number(info.lastInsertRowid) : null;
}

/** True if a non-dismissed task with this norm_key already exists in the project. */
export function taskExistsWithKey(projectId: number, normKey: string): boolean {
  return !!getDb()
    .prepare(
      "SELECT 1 FROM items WHERE project_id = ? AND kind = 'task' AND norm_key = ? AND status != 'dismissed' LIMIT 1",
    )
    .get(projectId, normKey);
}

/**
 * Retire suggestions that duplicate an existing (non-dismissed) task — exact OR reworded (fuzzy).
 * Run after ingesting tasks. Returns the number dismissed.
 */
export function dismissSuggestionsCollidingWithTasks(projectId: number): number {
  const db = getDb();
  const tasks = db
    .prepare("SELECT title FROM items WHERE project_id = ? AND kind = 'task' AND status != 'dismissed'")
    .all(projectId) as { title: string }[];
  if (tasks.length === 0) return 0;
  const suggestions = db
    .prepare("SELECT id, title FROM items WHERE project_id = ? AND kind = 'suggestion' AND status != 'dismissed'")
    .all(projectId) as { id: number; title: string }[];
  const dismiss = db.prepare(
    "UPDATE items SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?",
  );
  let n = 0;
  for (const s of suggestions) {
    const dup = tasks.some((t) => {
      const { score, shared } = titleJaccard(s.title, t.title);
      return shared >= 2 && score >= DEDUP_JACCARD;
    });
    if (dup) {
      dismiss.run(s.id);
      n++;
    }
  }
  return n;
}

/**
 * Promote a suggestion into a Board task. If a non-dismissed task with the same norm_key
 * already exists (or the rename would collide with a task tombstone), dismiss the suggestion
 * instead and report "merged".
 */
export function promoteToTask(id: number): "promoted" | "merged" | "missing" {
  const db = getDb();
  const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
  if (!row) return "missing";
  const dismiss = () =>
    db.prepare("UPDATE items SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?").run(id);

  if (taskExistsWithKey(row.project_id, row.norm_key)) {
    dismiss();
    return "merged";
  }
  try {
    db.prepare(
      "UPDATE items SET kind = 'task', status = 'todo', updated_at = datetime('now') WHERE id = ?",
    ).run(id);
    return "promoted";
  } catch {
    // UNIQUE(project_id,'task',norm_key) collision with a dismissed task tombstone.
    dismiss();
    return "merged";
  }
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
  // Completion ("Looks done?") is a task-only concept — a learning or suggestion can't be "done".
  // Scope every lookup to kind='task' so a `completed[]` reference can't flag a non-task row.
  if (/^\d+$/.test(idOrTitle)) {
    row = db.prepare("SELECT * FROM items WHERE id = ? AND project_id = ? AND kind = 'task'").get(
      Number(idOrTitle),
      projectId,
    ) as ItemRow | undefined;
  }
  if (!row) {
    row = db
      .prepare(
        `SELECT * FROM items
           WHERE project_id = ? AND kind = 'task' AND norm_key = ? AND status IN ('todo','in_progress')
           ORDER BY id DESC LIMIT 1`,
      )
      .get(projectId, normalizeTitle(idOrTitle)) as ItemRow | undefined;
  }
  // Fuzzy fallback: the model often paraphrases the title it's marking complete. Match it to the
  // best open task by token containment, but only when it's strong AND clearly unambiguous.
  if (!row) {
    const openItems = db
      .prepare(
        "SELECT * FROM items WHERE project_id = ? AND kind = 'task' AND status IN ('todo','in_progress')",
      )
      .all(projectId) as ItemRow[];
    let best: ItemRow | undefined;
    let bestScore = 0;
    let secondScore = 0;
    for (const it of openItems) {
      const s = titleMatchScore(idOrTitle, it.title);
      if (s > bestScore) {
        secondScore = bestScore;
        bestScore = s;
        best = it;
      } else if (s > secondScore) {
        secondScore = s;
      }
    }
    if (best && bestScore >= 0.7 && bestScore - secondScore >= 0.2) row = best;
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
