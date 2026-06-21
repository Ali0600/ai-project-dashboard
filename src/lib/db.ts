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
  implementation_plan TEXT,
  norm_key        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, kind, norm_key)
);

CREATE INDEX IF NOT EXISTS idx_items_project       ON items(project_id);
CREATE INDEX IF NOT EXISTS idx_items_conversation  ON items(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_project        ON conversations(project_id);
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
}
