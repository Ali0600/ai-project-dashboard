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
}
