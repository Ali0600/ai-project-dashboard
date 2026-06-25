import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "./db";
import {
  collapseDuplicateTasks,
  flagSuggestedDone,
  getOrCreateProject,
  hasUnscannedActivity,
  insertItem,
  listItems,
  normalizeTitle,
  titleJaccard,
  titleMatchScore,
  tokenize,
} from "./store";
import type { ConversationRow } from "./types";

// Point the DB at a throwaway file before any store fn opens it (getDb is lazy + memoized, and is
// only called inside the DB-backed test bodies below), so tests never touch the live dashboard.db.
const testDbPath = path.join(os.tmpdir(), `store-test-${Math.random().toString(36).slice(2)}.db`);
process.env.DASHBOARD_DB = testDbPath;

const tmpFiles: string[] = [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`];

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

describe("titleMatchScore / tokenize (fuzzy completion matching)", () => {
  const stored = "Build in-app basket optimizer (Basket feature)";

  it("strips generic/stop words and short tokens", () => {
    expect(tokenize("Build the basket feature for X")).toEqual(["basket"]);
    expect(tokenize("Deploy to Render with monitoring")).toEqual(["deploy", "render", "monitoring"]);
  });

  it("scores a paraphrased completion ref as a full match (token containment)", () => {
    expect(titleMatchScore("Basket feature", stored)).toBe(1);
    expect(titleMatchScore("the basket", stored)).toBe(1);
  });

  it("scores an unrelated title near zero", () => {
    expect(titleMatchScore("Generate recipes from pantry items", stored)).toBe(0);
    expect(titleMatchScore("Publish til repo to GitHub", stored)).toBe(0);
  });

  it("does not over-match a partial/weaker reference above the accept threshold (0.7)", () => {
    // {server, side, optimizer} ∩ {basket, optimizer} = 1 / min(3,2) = 0.5
    expect(titleMatchScore("server-side optimizer", stored)).toBeLessThan(0.7);
  });
});

describe("titleJaccard (reworded-duplicate detection, threshold 0.6)", () => {
  it("treats reworded versions of the same task as duplicates", () => {
    // identical token sets, just reordered/rephrased
    const a = titleJaccard("Add EXPO_TOKEN GitHub secret", "Add EXPO_TOKEN secret to GitHub");
    expect(a.score).toBe(1);
    expect(a.shared).toBe(4);
    // overlapping-but-rephrased still clears 0.6
    expect(titleJaccard("Add EXPO_TOKEN secret for OTA", "Add EXPO_TOKEN GitHub secret").score).toBeGreaterThanOrEqual(0.6);
  });

  it("keeps genuinely distinct tasks separate (below 0.6)", () => {
    expect(titleJaccard("Add EXPO_TOKEN secret", "Add SENTRY_TOKEN secret").score).toBeLessThan(0.6);
    expect(titleJaccard("Deploy to Render", "Enable gated Render deploy via hook").score).toBeLessThan(0.6);
    // a short subset of a longer task is NOT a duplicate (that's containment, not Jaccard)
    expect(titleJaccard("Add tests", "Add tests for the parser module").score).toBeLessThan(0.6);
  });
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

describe("flagSuggestedDone is task-only (completion can't land on a learning/suggestion)", () => {
  it("flags a matching task but never a learning/suggestion", () => {
    const p = getOrCreateProject("/tmp/store-test-flag");
    insertItem({ projectId: p.id, kind: "task", title: "Deploy to Render" });
    insertItem({ projectId: p.id, kind: "learning", title: "Stream large files with readline" });
    insertItem({ projectId: p.id, kind: "suggestion", title: "Pin the GitHub repo" });

    // A completion reference whose words match only a learning/suggestion must NOT flag anything.
    expect(flagSuggestedDone(p.id, "Stream large files with readline", "ev")).toBe(false);
    expect(flagSuggestedDone(p.id, "Pin the GitHub repo", "ev")).toBe(false);
    // The task is still flaggable.
    expect(flagSuggestedDone(p.id, "Deploy to Render", "ev")).toBe(true);

    const flagged = listItems(p.id).filter((i) => i.suggested_done === 1);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].kind).toBe("task");
  });
});

describe("insertItem fuzzy-dedups learnings (only against other learnings)", () => {
  it("drops a reworded learning but keeps one that only overlaps a task", () => {
    const p = getOrCreateProject("/tmp/store-test-learn-dedup");
    const first = insertItem({ projectId: p.id, kind: "learning", title: "Stream large files with readline" });
    expect(first).not.toBeNull();
    // Same token set, reworded → deduped.
    const reworded = insertItem({ projectId: p.id, kind: "learning", title: "Stream large files using readline" });
    expect(reworded).toBeNull();

    // A learning that shares all its tokens with a TASK is NOT deduped (cross-kind isolation).
    insertItem({ projectId: p.id, kind: "task", title: "Configure CI caching" });
    const learning = insertItem({ projectId: p.id, kind: "learning", title: "Configure CI caching" });
    expect(learning).not.toBeNull();
  });
});

describe("collapseDuplicateTasks", () => {
  it("dismisses a reworded duplicate task, keeping the done canonical; leaves distinct tasks", () => {
    const p = getOrCreateProject("/tmp/store-test-collapse");
    // Seed pre-existing near-dups directly (insertItem would dedup them on the way in).
    const seed = getDb().prepare(
      "INSERT INTO items (project_id, kind, title, status, norm_key) VALUES (?, 'task', ?, ?, ?)",
    );
    for (const [title, status] of [
      ["Add EXPO_TOKEN GitHub secret", "done"],
      ["Add EXPO_TOKEN secret to GitHub", "todo"],
      ["Deploy to Render with monitoring", "todo"],
    ] as const) {
      seed.run(p.id, title, status, normalizeTitle(title));
    }

    expect(collapseDuplicateTasks(p.id)).toBe(1);

    const tasks = listItems(p.id, "task");
    const byTitle = (t: string) => tasks.find((i) => i.title === t);
    expect(byTitle("Add EXPO_TOKEN GitHub secret")?.status).toBe("done"); // canonical kept
    expect(byTitle("Add EXPO_TOKEN secret to GitHub")?.status).toBe("dismissed"); // reworded dup
    expect(byTitle("Deploy to Render with monitoring")?.status).toBe("todo"); // distinct, untouched
  });
});
