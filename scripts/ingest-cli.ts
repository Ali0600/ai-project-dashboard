/**
 * Ingest an extraction JSON object into the dashboard DB.
 * Used by the /sync-board slash command (live Claude writes JSON, we store it).
 *
 *   npx tsx scripts/ingest-cli.ts --cwd <projectDir> [--session <id>] [--file <json>]
 *
 * JSON is read from --file or stdin and must match the ExtractionResult schema.
 *
 * Items are linked to their source conversation so the UI can show "From <title> · <date>":
 * if --session is given we use it directly; otherwise we resolve the *active* conversation from
 * the filesystem — the newest transcript whose `cwd` matches --cwd (that's the live /sync-board
 * session) — and upsert it. Falls back to an unlinked item (conversation_id = null) if none match.
 */
import fs from "node:fs";
import path from "node:path";
import { ingestExtraction } from "../src/lib/ingest";
import {
  getConversationBySession,
  getOrCreateProject,
  upsertConversation,
} from "../src/lib/store";
import { listTranscripts, readTranscript } from "../src/lib/transcripts";
import { ExtractionResult } from "../src/lib/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Newest mtime first; -1 for files we can't stat (sorted to the back). */
function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Resolve the conversation these items belong to. Prefer an explicit --session; else find the
 * newest transcript whose JSONL `cwd` equals the target cwd (the live session) and upsert it.
 * Reads the JSONL `cwd` rather than decoding the dir name (real dashes in paths break decoding).
 */
async function resolveConversationId(cwd: string, session?: string): Promise<number | null> {
  if (session) return getConversationBySession(session)?.id ?? null;

  const target = path.resolve(cwd);
  const candidates = listTranscripts()
    .sort((a, b) => mtime(b.transcriptPath) - mtime(a.transcriptPath))
    .slice(0, 5); // the live session is almost always the most recently written

  for (const t of candidates) {
    try {
      const { meta } = await readTranscript(t.transcriptPath);
      if (meta.cwd && path.resolve(meta.cwd) === target) {
        // Reuse the existing row if present (don't reset its scan_status); else create it.
        return getConversationBySession(meta.sessionId)?.id ?? upsertConversation(meta).id;
      }
    } catch {
      // Unreadable/partial transcript — skip and try the next.
    }
  }
  return null;
}

async function main(): Promise<void> {
  const cwd = arg("--cwd") || process.env.PWD;
  const session = arg("--session");
  const file = arg("--file");

  if (!cwd) {
    console.error("ingest-cli: --cwd <projectDir> is required");
    process.exit(1);
  }

  const raw = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error("ingest-cli: input is not valid JSON");
    process.exit(1);
  }

  const parsed = ExtractionResult.safeParse(json);
  if (!parsed.success) {
    console.error("ingest-cli: JSON does not match the extraction schema:");
    console.error(parsed.error.message);
    process.exit(1);
  }

  const project = getOrCreateProject(cwd);
  const conversationId = await resolveConversationId(cwd, session);
  const res = ingestExtraction({
    projectId: project.id,
    conversationId,
    extraction: parsed.data,
  });

  console.log(
    JSON.stringify({ project: project.name, created: res.created, flaggedDone: res.flaggedDone }),
  );
}

main();
