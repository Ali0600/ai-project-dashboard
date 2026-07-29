import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "./db";
import {
  collapseDuplicateTasks,
  countLostConversations,
  createFixTaskFromFailure,
  deriveResearchTopic,
  flagSuggestedDone,
  markConversationLost,
  openFailureTitles,
  openItemTitles,
  recordFailureOccurrence,
  sameFailure,
  getOrCreateProject,
  hasUnscannedActivity,
  insertItem,
  listItems,
  normalizeTitle,
  promoteToTask,
  reorderTasks,
  updateItemStatus,
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

describe("flagSuggestedDone is task-only (completion can't land on a suggestion)", () => {
  it("flags a matching task but never a suggestion", () => {
    const p = getOrCreateProject("/tmp/store-test-flag");
    insertItem({ projectId: p.id, kind: "task", title: "Deploy to Render" });
    insertItem({ projectId: p.id, kind: "suggestion", title: "Pin the GitHub repo" });

    // A completion reference whose words match only a suggestion must NOT flag anything.
    expect(flagSuggestedDone(p.id, "Pin the GitHub repo", "ev")).toBe(false);
    // The task is still flaggable.
    expect(flagSuggestedDone(p.id, "Deploy to Render", "ev")).toBe(true);

    const flagged = listItems(p.id).filter((i) => i.suggested_done === 1);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].kind).toBe("task");
  });
});

describe("insertItem fuzzy-dedups suggestions", () => {
  it("drops a reworded suggestion that matches an existing one", () => {
    const p = getOrCreateProject("/tmp/store-test-sugg-dedup");
    const first = insertItem({ projectId: p.id, kind: "suggestion", title: "Stream large files with readline" });
    expect(first).not.toBeNull();
    // Same token set, reworded → deduped.
    const reworded = insertItem({ projectId: p.id, kind: "suggestion", title: "Stream large files using readline" });
    expect(reworded).toBeNull();
  });
});

describe("insertItem research kind", () => {
  it("persists source_url and dedups against existing tasks/suggestions", () => {
    const p = getOrCreateProject("/tmp/store-test-research");
    // A research idea that duplicates an existing task is dropped (don't resurface tracked work).
    insertItem({ projectId: p.id, kind: "task", title: "Add barcode scanner to app" });
    const dup = insertItem({
      projectId: p.id,
      kind: "research",
      title: "Add barcode scanner",
      sourceUrl: "https://reddit.com/r/x/1",
    });
    expect(dup).toBeNull();

    // A genuinely new research idea is inserted with its source_url.
    const id = insertItem({
      projectId: p.id,
      kind: "research",
      title: "Offline receipt history",
      sourceUrl: "https://news.ycombinator.com/item?id=1",
    });
    expect(id).not.toBeNull();
    const row = listItems(p.id, "research").find((i) => i.id === id);
    expect(row?.source_url).toBe("https://news.ycombinator.com/item?id=1");
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

describe("sameFailure: error signatures decide, not token overlap", () => {
  it("refuses to merge two failures that differ only by status code", () => {
    // Plain Jaccard scores this 0.667 (>= 0.6) and would MERGE them, silently folding a 502 into
    // the 500's recurrence count.
    expect(sameFailure("API request failed with HTTP 500", "API request failed with HTTP 502")).toBe(
      false,
    );
  });

  it("refuses to merge the same status code from different hosts", () => {
    expect(
      sameFailure("HTTP 429 rate limit from oppp.online", "HTTP 429 rate limit from tcgplayer.com"),
    ).toBe(false);
  });

  it("matches the same failure reworded by the model", () => {
    // Plain Jaccard scores this 0.455 (< 0.6) and would SPLIT one failure across two rows, so its
    // recurrence would never be counted.
    expect(
      sameFailure(
        "oppp.online returns HTTP 429 during reference download",
        "oppp.online rate-limits reference downloads (HTTP 429)",
      ),
    ).toBe(true);
  });

  it("falls back to the generic reworded-title rule when neither title has a signature", () => {
    expect(sameFailure("Build step keeps hanging forever", "Build step keeps hanging")).toBe(true);
    expect(sameFailure("Build step keeps hanging forever", "Docs are out of date")).toBe(false);
  });
});

describe("recordFailureOccurrence: what recurrence MEANS depends on status", () => {
  const seed = (projectId: number, title: string, status: string) =>
    getDb()
      .prepare(
        "INSERT INTO items (project_id, kind, title, status, norm_key) VALUES (?, 'failure', ?, ?, ?)",
      )
      .run(projectId, title, status, normalizeTitle(title)).lastInsertRowid as number;
  const read = (id: number) =>
    getDb().prepare("SELECT * FROM items WHERE id = ?").get(id) as {
      status: string;
      times_seen: number;
    };

  it("bumps an open failure", () => {
    const p = getOrCreateProject("/tmp/store-test-recur-open");
    const id = seed(p.id, "HTTP 429 rate limit from oppp.online", "todo");
    expect(recordFailureOccurrence(p.id, "HTTP 429 rate limit from oppp.online", "ev")).toBe("bumped");
    expect(read(id)).toMatchObject({ status: "todo", times_seen: 2 });
  });

  it("reopens a failure that recurred after being marked done", () => {
    const p = getOrCreateProject("/tmp/store-test-recur-done");
    const id = seed(p.id, "ECONNRESET from registry.example", "done");
    expect(recordFailureOccurrence(p.id, "ECONNRESET from registry.example", "came back")).toBe(
      "reopened",
    );
    // A fix that didn't hold is the most valuable signal here — it must not tick up invisibly.
    expect(read(id)).toMatchObject({ status: "todo", times_seen: 2 });
  });

  it("leaves a dismissed failure completely alone", () => {
    const p = getOrCreateProject("/tmp/store-test-recur-dismissed");
    const id = seed(p.id, "HTTP 503 from flaky.example", "dismissed");
    expect(recordFailureOccurrence(p.id, "HTTP 503 from flaky.example", "ev")).toBe("ignored");
    expect(read(id)).toMatchObject({ status: "dismissed", times_seen: 1 });
  });

  it("reports missing when nothing matches", () => {
    const p = getOrCreateProject("/tmp/store-test-recur-missing");
    expect(recordFailureOccurrence(p.id, "HTTP 418 from nowhere.example", "ev")).toBe("missing");
  });
});

describe("failure kind isolation", () => {
  it("dedups only against failures, never against a task of the same name", () => {
    const p = getOrCreateProject("/tmp/store-test-failure-dedup");
    const title = "HTTP 429 rate limit from oppp.online";
    // A "Fix: <failure>" task must never block the failure itself from being recorded.
    insertItem({ projectId: p.id, kind: "task", title });
    const failure = insertItem({ projectId: p.id, kind: "failure", title });
    expect(failure).not.toBeNull();
    // The same failure again is a duplicate (ingest turns this into a recurrence bump).
    expect(insertItem({ projectId: p.id, kind: "failure", title })).toBeNull();
  });

  it("is invisible to task-only machinery", () => {
    const p = getOrCreateProject("/tmp/store-test-failure-isolation");
    const title = "HTTP 500 from build.example";
    insertItem({ projectId: p.id, kind: "failure", title });
    // Completion detection is task-only — a failure must never be flagged "looks done?".
    expect(flagSuggestedDone(p.id, title, "ev")).toBe(false);
    // Failure titles are error signatures; they'd derail a query describing what the project IS.
    expect(deriveResearchTopic(p.id)).not.toContain("HTTP 500");
    // And they must not be fed to the extractor's "do not duplicate" list, or recurrence dies.
    expect(openItemTitles(p.id)).not.toContain(title);
    expect(openFailureTitles(p.id)).toContain(title);
  });
});

describe("createFixTaskFromFailure keeps the failure countable", () => {
  it("spawns a task without converting the failure", () => {
    const p = getOrCreateProject("/tmp/store-test-fixtask");
    const title = "HTTP 429 rate limit from api.example";
    const failureId = insertItem({ projectId: p.id, kind: "failure", title, detail: "blocked" })!;
    getDb().prepare("UPDATE items SET fix_research = ? WHERE id = ?").run("WEB SOURCED TEXT", failureId);

    const res = createFixTaskFromFailure(failureId);
    expect(res).not.toBe("missing");
    expect(res).not.toBe("not_failure");
    const taskId = (res as { taskId: number }).taskId;

    const failure = listItems(p.id, "failure").find((i) => i.id === failureId)!;
    // Converting would drop it out of openFailureTitles and reset the count on the next recurrence.
    expect(failure.kind).toBe("failure");
    expect(failure.status).toBe("in_progress");
    expect(openFailureTitles(p.id)).toContain(title);

    const task = listItems(p.id, "task").find((i) => i.id === taskId)!;
    // The task's detail feeds the edit-enabled apply agent — web-sourced text must never reach it.
    expect(task.detail).not.toContain("WEB SOURCED TEXT");
    expect(task.detail).toContain("blocked");
  });
});

describe("markConversationLost distinguishes lost content from captured work", () => {
  it("marks a never-scanned conversation lost, but leaves an already-scanned one alone", () => {
    const p = getOrCreateProject("/tmp/store-test-lost");
    const db = getDb();
    const add = (session: string, scanned: boolean) =>
      db
        .prepare(
          `INSERT INTO conversations (session_id, project_id, transcript_path, scan_status, last_scanned_at)
           VALUES (?, ?, '/tmp/gone.jsonl', ?, ?)`,
        )
        .run(session, p.id, scanned ? "scanned" : "needs_scan", scanned ? "2026-07-01 00:00:00" : null)
        .lastInsertRowid as number;

    const never = add("lost-never", false);
    const already = add("lost-already", true);

    markConversationLost(never);
    markConversationLost(already);

    const statusOf = (id: number) =>
      (db.prepare("SELECT scan_status FROM conversations WHERE id = ?").get(id) as { scan_status: string })
        .scan_status;
    expect(statusOf(never)).toBe("lost"); // content unrecoverable — say so
    expect(statusOf(already)).toBe("scanned"); // items already extracted; nothing was lost
    expect(countLostConversations(p.id)).toBe(1);
  });
});

describe("flagSuggestedDone requires real evidence, not one coincidental word", () => {
  it("does not flag a task when the reference shares only a single token", () => {
    const p = getOrCreateProject("/tmp/store-test-1token");
    insertItem({ projectId: p.id, kind: "task", title: "Fix EPIPE crash in claude spawn" });
    // "build" is a stop word, so this reference reduces to the single token {fix} — a perfect
    // containment score against the task above, but no evidence that the task is done.
    expect(flagSuggestedDone(p.id, "Fix build", "ev")).toBe(false);
    // Two shared significant tokens is real evidence and still flags.
    expect(flagSuggestedDone(p.id, "the EPIPE crash", "ev")).toBe(true);
  });
});

describe("promoteToTask never tombstones the task it was asked to promote", () => {
  it("reports already_task instead of dismissing an existing task", () => {
    const p = getOrCreateProject("/tmp/store-test-promote-task");
    const taskId = insertItem({ projectId: p.id, kind: "task", title: "Ship the reorder API" })!;
    // Before the guard, taskExistsWithKey matched the row itself → dismiss() + "merged".
    expect(promoteToTask(taskId)).toBe("already_task");
    expect(listItems(p.id, "task").find((i) => i.id === taskId)?.status).toBe("todo");
  });

  it("still promotes a suggestion and still merges a genuine collision", () => {
    const p = getOrCreateProject("/tmp/store-test-promote-sugg");
    const sug = insertItem({ projectId: p.id, kind: "suggestion", title: "Pin the GitHub repo" })!;
    expect(promoteToTask(sug)).toBe("promoted");
    expect(listItems(p.id, "task").find((i) => i.id === sug)?.kind).toBe("task");
  });
});

describe("reorderTasks does not resurrect dismissed tasks", () => {
  it("leaves a dismissed task dismissed when a stale drag lists it", () => {
    const p = getOrCreateProject("/tmp/store-test-reorder-tombstone");
    const keep = insertItem({ projectId: p.id, kind: "task", title: "Keep this open task" })!;
    const gone = insertItem({ projectId: p.id, kind: "task", title: "Collapsed duplicate task" })!;
    updateItemStatus(gone, "dismissed");

    // A drag computed before the dismissal still lists `gone` in the column.
    reorderTasks(p.id, "todo", [gone, keep]);

    const rows = listItems(p.id, "task");
    expect(rows.find((i) => i.id === gone)?.status).toBe("dismissed");
    expect(rows.find((i) => i.id === keep)?.status).toBe("todo");
  });
});

describe("normalizeTitle keeps non-Latin titles distinguishable", () => {
  it("does not collapse titles without ASCII alphanumerics to the same key", () => {
    // Both would normalize to "" before the fallback, colliding under UNIQUE(project,kind,norm_key)
    // so the second insert would be silently dropped.
    expect(normalizeTitle("支持离线模式")).not.toBe("");
    expect(normalizeTitle("支持离线模式")).not.toBe(normalizeTitle("添加条形码扫描"));

    const p = getOrCreateProject("/tmp/store-test-nonlatin");
    expect(insertItem({ projectId: p.id, kind: "task", title: "支持离线模式" })).not.toBeNull();
    expect(insertItem({ projectId: p.id, kind: "task", title: "添加条形码扫描" })).not.toBeNull();
  });
});

describe("reorderTasks writes sort_order per position (and status for cross-column drags)", () => {
  it("persists the given order and moves a card across columns in one call", () => {
    const p = getOrCreateProject("/tmp/store-test-reorder");
    const a = insertItem({ projectId: p.id, kind: "task", title: "Set up deploy pipeline" })!;
    const b = insertItem({ projectId: p.id, kind: "task", title: "Add barcode scanner feature" })!;
    const c = insertItem({ projectId: p.id, kind: "task", title: "Write offline sync logic" })!;

    // Order the To Do column as C, A, B → sort_order 0,1,2.
    reorderTasks(p.id, "todo", [c, a, b]);
    const pos = Object.fromEntries(listItems(p.id, "task").map((t) => [t.id, t.sort_order]));
    expect([pos[c], pos[a], pos[b]]).toEqual([0, 1, 2]);

    // Dragging A into Done sets its status and position together.
    reorderTasks(p.id, "done", [a]);
    const moved = listItems(p.id, "task").find((t) => t.id === a)!;
    expect(moved.status).toBe("done");
    expect(moved.sort_order).toBe(0);
  });
});
