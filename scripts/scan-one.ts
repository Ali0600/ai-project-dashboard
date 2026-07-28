/**
 * Scan ONE conversation, unattended.
 *
 *   npx tsx scripts/scan-one.ts --transcript <path>
 *   npx tsx scripts/scan-one.ts --session <session-id>
 *
 * This is what `flag-hook` spawns (detached) when DASHBOARD_AUTO_SCAN is on, so it runs with no
 * terminal attached and nobody watching. Two consequences shape the design:
 *
 *  - **It must never run twice for the same transcript.** SessionEnd can fire more than once, and a
 *    manual scan may already be in flight. Duplicate extraction burns quota and races the DB, so a
 *    second instance is refused by an exclusive lockfile rather than by timing luck.
 *  - **It must leave a record.** A silent unattended job that fails is indistinguishable from one
 *    that never ran, so every outcome is appended to data/auto-scan.log.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvLocal } from "../src/lib/env";

// Must run before anything reads process.env: this job is spawned from a hook with a bare
// environment, so .env.local (notably DASHBOARD_FORCE_SUBSCRIPTION_AUTH) isn't there otherwise.
loadEnvLocal(path.resolve(__dirname, ".."));

import { ClaudeUnavailableError } from "../src/lib/claude";
import { scanTranscript } from "../src/lib/scan";
import { getConversationBySession } from "../src/lib/store";
import { listTranscripts } from "../src/lib/transcripts";

/** A transcript is named `<session-id>.jsonl` (mirrors scan.ts). */
function sessionIdFromPath(p: string): string {
  return path.basename(p).replace(/\.jsonl$/, "");
}

/** A lock older than this is treated as abandoned (the holder died without cleaning up). */
const STALE_LOCK_MS = 30 * 60 * 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function logLine(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    const dir = path.join(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "auto-scan.log"), line);
  } catch {
    /* logging must never be the reason a scan fails */
  }
  process.stdout.write(line);
}

/**
 * Take an exclusive lock for this session. `wx` fails if the file exists, which is the atomic
 * "create only if absent" the guard needs — a PID file checked-then-written would race.
 */
function acquireLock(sessionId: string): string | null {
  const lockPath = path.join(os.tmpdir(), `dash-scan-${sessionId}.lock`);
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return lockPath;
  } catch {
    // Someone holds it. Steal it only if it's clearly abandoned, so a crashed run can't wedge
    // this session's scanning forever.
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > STALE_LOCK_MS) {
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
        return lockPath;
      }
    } catch {
      /* lost the race to another starter — treat as held */
    }
    return null;
  }
}

async function main() {
  const explicitPath = arg("--transcript");
  const session = arg("--session");

  let transcriptPath = explicitPath;
  if (!transcriptPath && session) {
    const conv = getConversationBySession(session);
    transcriptPath =
      conv?.transcript_path ??
      listTranscripts().find((t) => t.sessionId === session)?.transcriptPath;
  }
  if (!transcriptPath) {
    logLine("auto-scan: no --transcript/--session resolved; nothing to do");
    return;
  }
  if (!fs.existsSync(transcriptPath)) {
    logLine(`auto-scan: transcript missing, skipping ${transcriptPath}`);
    return;
  }

  const sessionId = session || sessionIdFromPath(transcriptPath);
  const lock = acquireLock(sessionId);
  if (!lock) {
    logLine(`auto-scan: another scan already running for ${sessionId}, skipping`);
    return;
  }

  const started = Date.now();
  try {
    const r = await scanTranscript(transcriptPath);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    logLine(
      r.skipped
        ? `auto-scan: ${sessionId} no new content (${secs}s)`
        : `auto-scan: ${sessionId} +${r.created} item(s), ${r.flaggedDone} done-flag(s), ${r.chunks} chunk(s) (${secs}s)`,
    );
  } catch (e) {
    const why =
      e instanceof ClaudeUnavailableError
        ? `claude unavailable: ${e.message}`
        : (e as Error).message;
    logLine(`auto-scan: ${sessionId} FAILED — ${why}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

main();
