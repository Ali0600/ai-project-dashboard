import path from "node:path";
import { extractOnce, mergeExtractions } from "./claude";
import { ingestExtraction } from "./ingest";
import {
  getConversationBySession,
  markConversationScanned,
  openItemTitles,
  upsertConversation,
} from "./store";
import { chunkText, readTranscript } from "./transcripts";
import type { ExtractionResult } from "./types";

/** Cap per-scan headless calls to bound cost; keep the most recent chunks. */
const MAX_CHUNKS = Number(process.env.SCAN_MAX_CHUNKS || 12);

export interface ScanResult {
  conversationId: number;
  created: number;
  flaggedDone: number;
  chunks: number;
  skipped: boolean;
}

function sessionIdFromPath(p: string): string {
  return path.basename(p).replace(/\.jsonl$/, "");
}

/**
 * Full pipeline for one transcript:
 *   read (incrementally) -> upsert conversation -> headless extract over chunks
 *   -> ingest -> mark scanned.
 */
export async function scanTranscript(
  transcriptPath: string,
  opts: { incremental?: boolean } = {},
): Promise<ScanResult> {
  const incremental = opts.incremental ?? true;
  const existing = getConversationBySession(sessionIdFromPath(transcriptPath));
  const since = incremental ? existing?.last_scanned_uuid ?? null : null;

  const { meta, text, lastUuid, empty } = readTranscript(transcriptPath, since);

  // No cwd means this isn't a real interactive project conversation (e.g. a headless
  // `claude -p` artifact). Skip it rather than inventing a junk project.
  if (!meta.cwd) {
    return { conversationId: 0, created: 0, flaggedDone: 0, chunks: 0, skipped: true };
  }

  const conv = upsertConversation(meta);

  if (empty) {
    markConversationScanned(conv.id, lastUuid);
    return { conversationId: conv.id, created: 0, flaggedDone: 0, chunks: 0, skipped: true };
  }

  let chunks = chunkText(text);
  if (chunks.length > MAX_CHUNKS) chunks = chunks.slice(-MAX_CHUNKS); // keep most recent

  const existingTitles = openItemTitles(conv.project_id);
  const parts: ExtractionResult[] = [];
  for (const ch of chunks) {
    parts.push(await extractOnce(ch, existingTitles));
  }
  const merged = mergeExtractions(parts);

  const res = ingestExtraction({
    projectId: conv.project_id,
    conversationId: conv.id,
    extraction: merged,
  });
  markConversationScanned(conv.id, lastUuid);

  return { conversationId: conv.id, ...res, chunks: chunks.length, skipped: false };
}
