import fs from "node:fs";
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

/** Cap per-scan headless calls to bound cost. */
const MAX_CHUNKS = Number(process.env.SCAN_MAX_CHUNKS || 16);
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS || 120000);

/** Over the cap, keep the first few + the most recent chunks (don't silently drop the middle). */
function selectChunks(chunks: string[], max: number): string[] {
  if (chunks.length <= max) return chunks;
  const head = Math.min(3, max - 1);
  return [...chunks.slice(0, head), ...chunks.slice(chunks.length - (max - head))];
}

export interface ScanResult {
  conversationId: number;
  created: number;
  flaggedDone: number;
  createdIds: number[];
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

  // The transcript may have been removed/rotated since we recorded it (compaction, cleanup,
  // a session that never persisted). Skip gracefully and clear it from "pending" so the
  // batch doesn't keep failing on a file that no longer exists.
  if (!fs.existsSync(transcriptPath)) {
    if (existing) markConversationScanned(existing.id, existing.last_scanned_uuid ?? null);
    return {
      conversationId: existing?.id ?? 0,
      created: 0,
      flaggedDone: 0,
      createdIds: [],
      chunks: 0,
      skipped: true,
    };
  }

  const { meta, text, lastUuid, empty } = await readTranscript(transcriptPath, since);

  // No cwd means this isn't a real interactive project conversation (e.g. a headless
  // `claude -p` artifact). Skip it rather than inventing a junk project.
  if (!meta.cwd) {
    return { conversationId: 0, created: 0, flaggedDone: 0, createdIds: [], chunks: 0, skipped: true };
  }

  const conv = upsertConversation(meta);

  if (empty) {
    markConversationScanned(conv.id, lastUuid);
    return { conversationId: conv.id, created: 0, flaggedDone: 0, createdIds: [], chunks: 0, skipped: true };
  }

  const chunks = selectChunks(chunkText(text, CHUNK_CHARS), MAX_CHUNKS);

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
