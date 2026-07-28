/**
 * SessionEnd / Stop hook target. Reads the hook payload from stdin and marks the
 * conversation as `needs_scan` in the dashboard DB. Deliberately cheap: it never
 * parses the transcript and never blocks Claude Code (always exits 0).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProjectByCwd, upsertConversation } from "../src/lib/store";
import type { TranscriptMeta } from "../src/lib/transcripts";

const DASHBOARD_DIR = path.resolve(__dirname, "..");

/**
 * Is auto-scan enabled? Hooks are spawned by Claude Code with a bare environment — they do NOT
 * inherit the dev server's `.env.local` — so read the flag from that file directly, falling back to
 * a real env var for anyone who prefers to export it.
 */
function autoScanEnabled(): boolean {
  const truthy = (v: string | undefined) =>
    v != null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  if (process.env.DASHBOARD_AUTO_SCAN != null) return truthy(process.env.DASHBOARD_AUTO_SCAN);
  try {
    const env = fs.readFileSync(path.join(DASHBOARD_DIR, ".env.local"), "utf8");
    const m = env.match(/^\s*DASHBOARD_AUTO_SCAN\s*=\s*(.*)$/m);
    return truthy(m?.[1]?.trim().replace(/^["']|["']$/g, ""));
  } catch {
    return false;
  }
}

/**
 * Kick off extraction for the session that just ended, without making Claude Code wait for it.
 * Detached + unref'd so this hook still returns immediately; scan-one.ts holds a per-session lock,
 * so a duplicate SessionEnd (or a manual scan already running) can't double-extract.
 */
function spawnScan(transcriptPath: string): void {
  try {
    const child = spawn("npx", ["tsx", path.join(DASHBOARD_DIR, "scripts", "scan-one.ts"), "--transcript", transcriptPath], {
      cwd: DASHBOARD_DIR,
      detached: true,
      stdio: "ignore",
      // Mark it as ours so the scan's own `claude -p` children don't get captured as conversations.
      env: { ...process.env, DASHBOARD_EXTRACTION: "1" },
    });
    child.unref();
  } catch {
    /* auto-scan is best-effort; never block the session ending */
  }
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

try {
  const raw = readStdin().trim();
  const payload: Record<string, unknown> = raw ? JSON.parse(raw) : {};

  const transcriptPath = (payload.transcript_path as string) || arg("--transcript");
  const cwd = (payload.cwd as string) || arg("--cwd");
  const sessionId =
    (payload.session_id as string) ||
    (transcriptPath ? path.basename(transcriptPath).replace(/\.jsonl$/, "") : arg("--session"));

  // Skip the dashboard's own headless extraction runs and bare home-dir sessions.
  const skip = !!process.env.DASHBOARD_EXTRACTION || cwd === os.homedir();

  // Only flag sessions for folders the dashboard ALREADY tracks as a project. A folder becomes a
  // project explicitly — via `/sync-board` or `npm run backfill` — so random one-off sessions
  // (e.g. in /tmp) never auto-create projects. Once a project exists, the hook keeps it fresh.
  // A real interactive session has written its transcript by the time SessionEnd fires. Sessions
  // that report a path which doesn't exist are ephemeral/orchestrated runs (workflow subagents keep
  // their transcripts elsewhere) — recording them creates rows that can never be scanned.
  const transcriptExists = !!transcriptPath && fs.existsSync(transcriptPath);

  if (transcriptPath && transcriptExists && cwd && sessionId && !skip && getProjectByCwd(cwd)) {
    const meta: TranscriptMeta = {
      sessionId,
      cwd,
      transcriptPath,
      title: null,
      slug: null,
      startedAt: null,
      lastActivityAt: new Date().toISOString(),
      lastUuid: null,
    };
    upsertConversation(meta, "needs_scan");

    // Opt-in: extract right away instead of waiting for someone to open the dashboard and click
    // Scan. Without this the board only updates when the user remembers to, and transcripts get
    // pruned on Claude Code's schedule — so unscanned sessions can expire before they're captured.
    if (autoScanEnabled()) spawnScan(transcriptPath);
  }
} catch {
  // Never block Claude Code on a dashboard error.
}

process.exit(0);
