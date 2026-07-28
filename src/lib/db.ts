import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite schema. Kept inline (rather than a separate .sql file read at runtime)
 * so it survives Next.js bundling and works identically from CLI scripts.
 *
 * The UNIQUE(project_id, kind, norm_key) constraint on `items` is the backbone of
 * de-duplication: re-scanning a conversation can't create a second copy of the same
 * item, and a `dismissed` row acts as a tombstone (a re-insert hits the conflict and
 * is ignored, so dismissed items never come back).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cwd         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL UNIQUE,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             TEXT,
  slug              TEXT,
  transcript_path   TEXT NOT NULL,
  last_scanned_uuid TEXT,
  scan_status       TEXT NOT NULL DEFAULT 'needs_scan',
  started_at        TEXT,
  last_activity_at  TEXT,
  last_scanned_at   TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  detail          TEXT,
  status          TEXT NOT NULL DEFAULT 'todo',
  priority        INTEGER NOT NULL DEFAULT 3,
  suggested_done  INTEGER NOT NULL DEFAULT 0,
  done_evidence   TEXT,
  source_uuid     TEXT,
  source_quote    TEXT,
  source_url      TEXT,
  implementation_plan TEXT,
  apply_branch    TEXT,
  apply_diff      TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  norm_key        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, kind, norm_key)
);

CREATE INDEX IF NOT EXISTS idx_items_project       ON items(project_id);
CREATE INDEX IF NOT EXISTS idx_items_conversation  ON items(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_project        ON conversations(project_id);

-- Cached Preflight dependency-scan Report per project (one row; refreshed on a 24h TTL by the
-- /api/preflight route). Stored as raw JSON so the Report shape can evolve with Preflight.
CREATE TABLE IF NOT EXISTS preflight_reports (
  project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  report      TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);
`;

let _db: Database.Database | null = null;

export function dbPath(): string {
  return (
    process.env.DASHBOARD_DB ||
    path.join(process.cwd(), "data", "dashboard.db")
  );
}

export function getDb(): Database.Database {
  if (_db) return _db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL"); // better concurrency for hook + UI writes
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  _db = db;
  return db;
}

/**
 * How recently a conversation must have been active for an already-missing transcript to mean "it
 * was never written" rather than "it has since been pruned". Claude Code's retention is measured in
 * weeks, so a few days is a wide safety margin on the destructive branch.
 */
const PHANTOM_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Lightweight, idempotent column migrations for DBs created before a column existed. */
function migrate(db: Database.Database): void {
  const cols = (db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const ensure = (name: string, ddl: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE items ADD COLUMN ${ddl}`);
  };
  // 3 = medium (matches PRIORITY_RANK and the SCHEMA default).
  ensure("priority", "priority INTEGER NOT NULL DEFAULT 3");
  ensure("implementation_plan", "implementation_plan TEXT");
  ensure("apply_branch", "apply_branch TEXT");
  ensure("apply_diff", "apply_diff TEXT");
  ensure("source_url", "source_url TEXT");

  // Manual within-column ordering: add `sort_order` once, seeding each task's initial position from
  // the existing (priority ASC, id DESC) order per (project, status) so boards don't reshuffle on
  // first load. Guarded to the first add so later boots never clobber a user's manual order.
  if (!cols.includes("sort_order")) {
    db.exec("ALTER TABLE items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE items SET sort_order = (
        SELECT COUNT(*) FROM items b
          WHERE b.project_id = items.project_id AND b.kind = 'task' AND b.status = items.status
            AND (b.priority < items.priority OR (b.priority = items.priority AND b.id > items.id))
      ) WHERE kind = 'task';
    `);
  }

  // One-time consolidation: merge legacy `recommendation` + `next_step` into a single
  // `suggestion` kind. Idempotent — after the first run there are no legacy-kind rows left,
  // so every statement becomes a no-op. Order matters: drop would-be UNIQUE collisions first,
  // then rename, then retire suggestions a task already covers.
  db.exec(`
    DELETE FROM items
      WHERE kind IN ('recommendation','next_step')
        AND id NOT IN (
          SELECT MIN(id) FROM items
            WHERE kind IN ('recommendation','next_step')
            GROUP BY project_id, norm_key
        );
    UPDATE items SET kind = 'suggestion' WHERE kind IN ('recommendation','next_step');
    UPDATE items SET status = 'dismissed', updated_at = datetime('now')
      WHERE kind = 'suggestion' AND status <> 'dismissed'
        AND EXISTS (
          SELECT 1 FROM items t
            WHERE t.project_id = items.project_id AND t.kind = 'task' AND t.norm_key = items.norm_key
        );
  `);

  // Completion is task-only: clear any `suggested_done` flag that landed on a learning/suggestion
  // (a pre-fix `flagSuggestedDone` matched references across all kinds). No-op once data is clean.
  db.exec(
    `UPDATE items SET suggested_done = 0, done_evidence = NULL WHERE suggested_done = 1 AND kind <> 'task';`,
  );

  // The `learning` item kind was removed: the board is for actionable triage (tasks / suggestions /
  // research), and learnings live in docs/learnings.md + ~/.claude/lessons.md. Drop any existing
  // learning rows. Idempotent — a no-op once none remain.
  db.exec(`DELETE FROM items WHERE kind = 'learning';`);

  // Backfill blank conversation titles (legacy/empty rows) so source lines and any future
  // per-conversation filter aren't empty. New titles come from the scan path going forward.
  db.exec(
    `UPDATE conversations SET title = COALESCE(NULLIF(slug, ''), session_id) WHERE title IS NULL OR title = '';`,
  );

  reconcileMissingTranscripts(db);
}

/**
 * Reconcile conversations whose transcript no longer exists on disk. Claude Code prunes transcripts
 * on its own retention schedule, so a conversation flagged for scanning can lose its content before
 * anyone scans it — silently, because a missing file is skipped everywhere.
 *
 * Two distinct cases, and conflating them is what hid this:
 *  - Never scanned → `lost`. The content is unrecoverable; the UI surfaces the count.
 *  - Never scanned AND flagged so recently that no retention window could have elapsed → the
 *    transcript never existed at all (an orchestrated/ephemeral run whose real transcript lives
 *    elsewhere). Delete it; there was never anything to lose.
 * Conversations already scanned keep their status — their items are safely in the DB.
 *
 * The age test is the only reliable discriminator: the hook records the same NULL metadata for both
 * kinds, so "recent + already missing" is what separates "never written" from "pruned since".
 * Deleting is the destructive branch, so it stays deliberately narrow — anything ambiguous is kept
 * and marked `lost`.
 *
 * Idempotent: rows already `lost` are re-checked cheaply and phantom rows are gone after the first
 * pass. A `lost` row whose file reappears is restored to `needs_scan` so it can still be captured.
 */
function reconcileMissingTranscripts(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT c.id, c.transcript_path, c.scan_status, c.last_scanned_at, c.last_activity_at,
              (SELECT COUNT(*) FROM items i WHERE i.conversation_id = c.id) AS item_count
         FROM conversations c
        WHERE c.scan_status IN ('needs_scan','lost')`,
    )
    .all() as {
    id: number;
    transcript_path: string;
    scan_status: string;
    last_scanned_at: string | null;
    last_activity_at: string | null;
    item_count: number;
  }[];
  if (rows.length === 0) return;

  const markLost = db.prepare("UPDATE conversations SET scan_status = 'lost' WHERE id = ?");
  const unmarkLost = db.prepare("UPDATE conversations SET scan_status = 'needs_scan' WHERE id = ?");
  const remove = db.prepare("DELETE FROM conversations WHERE id = ?");

  db.transaction(() => {
    for (const c of rows) {
      const exists = fs.existsSync(c.transcript_path);
      if (exists) {
        // A previously-lost transcript is back (restored, or the path was wrong) — let it be scanned.
        if (c.scan_status === "lost") unmarkLost.run(c.id);
        continue;
      }
      if (c.last_scanned_at != null || c.item_count > 0) continue; // captured something already
      // "Missing already, but flagged within the last few days" can only mean the transcript was
      // never written — real transcripts survive far longer than this before being pruned.
      const activityMs = c.last_activity_at ? Date.parse(c.last_activity_at) : NaN;
      const phantom =
        Number.isFinite(activityMs) && Date.now() - activityMs < PHANTOM_MAX_AGE_MS;
      if (phantom) remove.run(c.id);
      else if (c.scan_status !== "lost") markLost.run(c.id);
    }
  })();
}
