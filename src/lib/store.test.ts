import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hasUnscannedActivity } from "./store";
import type { ConversationRow } from "./types";

const tmpFiles: string[] = [];

function writeTmp(mtime?: Date): string {
  const p = path.join(os.tmpdir(), `conv-test-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, "{}\n");
  if (mtime) fs.utimesSync(p, mtime, mtime);
  tmpFiles.push(p);
  return p;
}

/** Minimal ConversationRow for the fields hasUnscannedActivity reads. */
function conv(partial: Partial<ConversationRow>): ConversationRow {
  return {
    transcript_path: "/does/not/matter",
    scan_status: "scanned",
    last_scanned_at: null,
    ...partial,
  } as ConversationRow;
}

afterAll(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe("hasUnscannedActivity", () => {
  it("returns false when the transcript file is gone, even if flagged needs_scan", () => {
    const c = conv({
      transcript_path: "/no/such/transcript-deadbeef.jsonl",
      scan_status: "needs_scan",
    });
    expect(hasUnscannedActivity(c)).toBe(false);
  });

  it("returns true for a needs_scan conversation whose file exists", () => {
    const c = conv({ transcript_path: writeTmp(), scan_status: "needs_scan" });
    expect(hasUnscannedActivity(c)).toBe(true);
  });

  it("returns true when the file was modified after the last scan", () => {
    const c = conv({
      transcript_path: writeTmp(new Date()), // now
      scan_status: "scanned",
      last_scanned_at: "2000-01-01 00:00:00", // long ago
    });
    expect(hasUnscannedActivity(c)).toBe(true);
  });

  it("returns false when the last scan is newer than the file mtime", () => {
    const c = conv({
      transcript_path: writeTmp(new Date("2000-01-01T00:00:00Z")), // old file
      scan_status: "scanned",
      last_scanned_at: "2030-01-01 00:00:00", // scanned in the future
    });
    expect(hasUnscannedActivity(c)).toBe(false);
  });
});
