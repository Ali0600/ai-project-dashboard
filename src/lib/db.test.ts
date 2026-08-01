import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { getDb, reconcileMissingTranscripts } from "./db";

// Point at a throwaway DB before getDb() resolves the path, so this never touches data/dashboard.db.
const testDbPath = path.join(os.tmpdir(), `db-test-${Math.random().toString(36).slice(2)}.db`);
process.env.DASHBOARD_DB = testDbPath;

const tmp: string[] = [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`];

function transcript(): string {
  const p = path.join(os.tmpdir(), `conv-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, "{}\n");
  tmp.push(p);
  return p;
}

/** Count how many times a write transaction is opened while `fn` runs. */
function countTransactions(db: BetterSqlite3.Database, fn: () => void): number {
  const original = db.transaction.bind(db);
  let opened = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).transaction = (cb: any) => {
    opened++;
    return original(cb);
  };
  try {
    fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).transaction = original;
  }
  return opened;
}

afterAll(() => {
  for (const f of tmp) fs.rmSync(f, { force: true });
});

describe("reconcileMissingTranscripts only writes when there is something to change", () => {
  it("opens no transaction when every transcript is present", () => {
    const db = getDb();
    db.prepare("INSERT INTO projects (cwd, name) VALUES ('/tmp/db-test-proj', 'p')").run();
    const projectId = db.prepare("SELECT id FROM projects WHERE cwd = '/tmp/db-test-proj'").get() as {
      id: number;
    };
    db.prepare(
      `INSERT INTO conversations (session_id, project_id, transcript_path, scan_status)
       VALUES ('present-1', ?, ?, 'needs_scan')`,
    ).run(projectId.id, transcript());

    // The row is pending, so the function still has work to INSPECT — but nothing to write. It ran
    // on every getDb(), i.e. every dev recompile, into a DB that sits inside the watched project
    // directory; an unconditional write here is what can feed the file-watcher.
    expect(countTransactions(db, () => reconcileMissingTranscripts(db))).toBe(0);
  });

  it("still opens exactly one transaction when a transcript really is gone", () => {
    const db = getDb();
    const projectId = db.prepare("SELECT id FROM projects WHERE cwd = '/tmp/db-test-proj'").get() as {
      id: number;
    };
    db.prepare(
      `INSERT INTO conversations (session_id, project_id, transcript_path, scan_status, last_activity_at)
       VALUES ('gone-1', ?, '/tmp/definitely-not-here.jsonl', 'needs_scan', '2020-01-01T00:00:00Z')`,
    ).run(projectId.id);

    expect(countTransactions(db, () => reconcileMissingTranscripts(db))).toBe(1);
    const row = db
      .prepare("SELECT scan_status FROM conversations WHERE session_id = 'gone-1'")
      .get() as { scan_status: string };
    expect(row.scan_status).toBe("lost"); // old + never captured => unrecoverable, not "scanned"

    // And a second pass has nothing left to do, so it must go quiet again.
    expect(countTransactions(db, () => reconcileMissingTranscripts(db))).toBe(0);
  });
});
