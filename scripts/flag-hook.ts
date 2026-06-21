/**
 * SessionEnd / Stop hook target. Reads the hook payload from stdin and marks the
 * conversation as `needs_scan` in the dashboard DB. Deliberately cheap: it never
 * parses the transcript and never blocks Claude Code (always exits 0).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertConversation } from "../src/lib/store";
import type { TranscriptMeta } from "../src/lib/transcripts";

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

  // Skip the dashboard's own headless extraction runs and bare home-dir sessions —
  // neither is a real project conversation.
  const skip = !!process.env.DASHBOARD_EXTRACTION || cwd === os.homedir();

  if (transcriptPath && cwd && sessionId && !skip) {
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
  }
} catch {
  // Never block Claude Code on a dashboard error.
}

process.exit(0);
