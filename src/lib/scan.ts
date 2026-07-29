import fs from "node:fs";
import path from "node:path";
import { extractOnce, mergeExtractions } from "./claude";
import { ingestExtraction } from "./ingest";
import { extractBacklog } from "./plans";
import {
  getConversationBySession,
  markConversationLost,
  markConversationScanned,
  openFailureTitles,
  openItemTitles,
  upsertConversation,
} from "./store";
import { chunkText, readTranscript } from "./transcripts";
import type { ExtractionResult } from "./types";

/** Cap per-scan headless calls to bound cost. */
const MAX_CHUNKS = Number(process.env.SCAN_MAX_CHUNKS || 16);
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS || 120000);
/** Max plan files whose Backlog we fold into one scan. */
const MAX_PLAN_CHUNKS = 2;

/** Over the cap, keep the first few + the most recent chunks (don't silently drop the middle). */
function selectChunks(chunks: string[], max: number): string[] {
  if (chunks.length <= max) return chunks;
  const head = Math.min(3, max - 1);
  return [...chunks.slice(0, head), ...chunks.slice(chunks.length - (max - head))];
}

/**
 * Build extraction chunks from the Backlog section of any plan files the conversation references.
 * A plan with no recognizable Backlog section contributes nothing (the noise guard). Off when
 * `SCAN_PLAN_FILES=0`.
 */
function buildPlanChunks(planRefs: string[]): string[] {
  if (process.env.SCAN_PLAN_FILES === "0") return [];
  const chunks: string[] = [];
  for (const planPath of planRefs) {
    if (chunks.length >= MAX_PLAN_CHUNKS) break;
    let md: string;
    try {
      md = fs.readFileSync(planPath, "utf8");
    } catch {
      continue; // referenced plan was moved/deleted
    }
    const backlog = extractBacklog(md);
    if (!backlog) continue;
    chunks.push(
      `=== PROJECT PLAN BACKLOG (${path.basename(planPath)}) — intended but NOT yet built; ` +
        `emit as tasks/suggestions, and treat anything the plan marks done/SHIPPED as completed ===\n` +
        backlog.slice(0, CHUNK_CHARS),
    );
  }
  return chunks;
}

export interface ScanResult {
  conversationId: number;
  created: number;
  flaggedDone: number;
  createdIds: number[];
  chunks: number;
  skipped: boolean;
}

/** A live step emitted during a scan (for streaming progress to the UI). */
export interface ScanProgress {
  phase: "reading" | "extracting" | "ingesting";
  /** 1-based chunk number, for the "extracting" phase. */
  index?: number;
  total?: number;
  /** e.g. "plan backlog" to mark the plan-derived chunks. */
  detail?: string;
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
  opts: { incremental?: boolean; onProgress?: (p: ScanProgress) => void } = {},
): Promise<ScanResult> {
  const incremental = opts.incremental ?? true;
  const report = opts.onProgress ?? (() => {});
  const existing = getConversationBySession(sessionIdFromPath(transcriptPath));
  const since = incremental ? existing?.last_scanned_uuid ?? null : null;

  // The transcript may have been removed/rotated since we recorded it (compaction, cleanup,
  // a session that never persisted). Skip gracefully and clear it from "pending" so the
  // batch doesn't keep failing on a file that no longer exists.
  if (!fs.existsSync(transcriptPath)) {
    // Never extracted and the file is gone → its content is unrecoverable. Record that as `lost`
    // rather than `scanned`, so the loss is visible instead of looking like a captured, empty run.
    if (existing) {
      markConversationLost(existing.id);
    }
    return {
      conversationId: existing?.id ?? 0,
      created: 0,
      flaggedDone: 0,
      createdIds: [],
      chunks: 0,
      skipped: true,
    };
  }

  // Watermark the transcript's mtime BEFORE reading: extraction below can run for minutes, and any
  // content appended during that window must still count as unscanned (see markConversationScanned).
  let readMtimeMs: number | undefined;
  try {
    readMtimeMs = fs.statSync(transcriptPath).mtimeMs;
  } catch {
    readMtimeMs = undefined;
  }

  report({ phase: "reading" });
  const { meta, text, lastUuid, empty, planRefs } = await readTranscript(transcriptPath, since);

  // No cwd means this isn't a real interactive project conversation (e.g. a headless
  // `claude -p` artifact). Skip it rather than inventing a junk project.
  if (!meta.cwd) {
    return { conversationId: 0, created: 0, flaggedDone: 0, createdIds: [], chunks: 0, skipped: true };
  }

  const conv = upsertConversation(meta);

  // Fold in referenced plan files' Backlog sections (scan/backfill only, not live /sync-board).
  const planChunks = buildPlanChunks(planRefs);

  // Nothing new in the transcript and no plan backlog to (re)read → skip.
  if (empty && planChunks.length === 0) {
    markConversationScanned(conv.id, lastUuid, readMtimeMs);
    return { conversationId: conv.id, created: 0, flaggedDone: 0, createdIds: [], chunks: 0, skipped: true };
  }

  const transcriptChunks = selectChunks(chunkText(text, CHUNK_CHARS), MAX_CHUNKS);
  const chunks = [...transcriptChunks, ...planChunks];

  const existingTitles = openItemTitles(conv.project_id);
  // Passed separately from `existingTitles` because the prompt's rule for these is the opposite:
  // re-report them when they recur (that's the recurrence count).
  const knownFailures = openFailureTitles(conv.project_id);
  const parts: ExtractionResult[] = [];
  for (let i = 0; i < chunks.length; i++) {
    report({
      phase: "extracting",
      index: i + 1,
      total: chunks.length,
      detail: i >= transcriptChunks.length ? "plan backlog" : undefined,
    });
    parts.push(await extractOnce(chunks[i], existingTitles, knownFailures));
  }
  const merged = mergeExtractions(parts);

  report({ phase: "ingesting" });
  const res = ingestExtraction({
    projectId: conv.project_id,
    conversationId: conv.id,
    extraction: merged,
  });
  markConversationScanned(conv.id, lastUuid, readMtimeMs);

  return { conversationId: conv.id, ...res, chunks: chunks.length, skipped: false };
}
