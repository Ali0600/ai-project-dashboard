import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { findPlanRefs } from "./plans";

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export interface TranscriptMeta {
  sessionId: string;
  cwd: string | null;
  title: string | null;
  slug: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  lastUuid: string | null;
  transcriptPath: string;
}

export interface ReadResult {
  meta: TranscriptMeta;
  /** Cleaned, role-labelled conversation text (tool noise stripped). */
  text: string;
  /** UUID of the last entry seen — store this as the scan checkpoint. */
  lastUuid: string | null;
  /** True if there was no new content past `sinceUuid`. */
  empty: boolean;
  /** Plan files (`~/.claude/plans/*.md`) referenced anywhere in the transcript. */
  planRefs: string[];
}

/** Locate every conversation transcript on disk. */
export function listTranscripts(): { sessionId: string; transcriptPath: string }[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const out: { sessionId: string; transcriptPath: string }[] = [];
  for (const projDir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const full = path.join(CLAUDE_PROJECTS_DIR, projDir);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith(".jsonl")) {
        out.push({ sessionId: f.replace(/\.jsonl$/, ""), transcriptPath: path.join(full, f) });
      }
    }
  }
  return out;
}

function firstString(...vals: (string | null | undefined)[]): string | null {
  for (const v of vals) if (v) return v;
  return null;
}

/** Pull text out of one entry's message.content, skipping tool_use / tool_result. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const t = (block as { text?: string }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}

const NOISE_PREFIXES = ["<command-", "<local-command-", "Caveat:", "[Request interrupted"];

/**
 * Read a transcript and return cleaned conversation text plus metadata.
 *
 * Streams the file line-by-line so a 79 MB transcript never loads into memory at
 * once (only one line + the small cleaned-text array are held). If `sinceUuid` is
 * given, only content *after* that entry is returned (incremental re-scan); if that
 * checkpoint is not found in the file, we fall back to the full transcript rather
 * than silently extracting nothing.
 */
export async function readTranscript(
  transcriptPath: string,
  sinceUuid?: string | null,
): Promise<ReadResult> {
  const sessionId = path.basename(transcriptPath).replace(/\.jsonl$/, "");
  const meta: TranscriptMeta = {
    sessionId,
    cwd: null,
    title: null,
    slug: null,
    startedAt: null,
    lastActivityAt: null,
    lastUuid: null,
    transcriptPath,
  };

  const segments: string[] = [];
  const planRefs = new Set<string>();
  let firstUserText: string | null = null;
  let checkpointIndex = -1; // segments.length at the moment we pass `sinceUuid`

  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    // Plan-file references can appear in any entry (incl. tool/system lines we otherwise strip),
    // so collect them from the raw line regardless of checkpoint or sidechain filtering.
    for (const p of findPlanRefs(line)) planRefs.add(p);
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = entry.type as string | undefined;
    const uuid = entry.uuid as string | undefined;
    const ts = entry.timestamp as string | undefined;

    if (entry.cwd && !meta.cwd) meta.cwd = entry.cwd as string;
    if (entry.slug && !meta.slug) meta.slug = entry.slug as string;
    if (type === "ai-title" && entry.aiTitle) meta.title = entry.aiTitle as string;
    if (ts) {
      if (!meta.startedAt) meta.startedAt = ts;
      meta.lastActivityAt = ts;
    }
    if (uuid) meta.lastUuid = uuid;

    // Mark where the checkpoint is (content after it is "new"), then skip that entry.
    if (sinceUuid && checkpointIndex === -1 && uuid === sinceUuid) {
      checkpointIndex = segments.length;
      continue;
    }

    // Internal sub-agent turns are noise — skip their content (but keep advancing meta).
    if (entry.isSidechain === true) continue;

    const msg = entry.message as { role?: string; content?: unknown } | undefined;
    if (type === "assistant" && msg) {
      const text = contentToText(msg.content).trim();
      if (text) segments.push(`ASSISTANT: ${text}`);
    } else if (type === "user" && msg) {
      const text = contentToText(msg.content).trim();
      if (!text) continue;
      if (NOISE_PREFIXES.some((p) => text.startsWith(p))) continue;
      if (!firstUserText) firstUserText = text;
      segments.push(`USER: ${text}`);
    }
  }

  meta.title = firstString(meta.title, firstUserText?.slice(0, 80), meta.slug, sessionId);

  // No checkpoint -> everything. Checkpoint found -> only what's after it.
  // Checkpoint given but missing (rotated/stale) -> fall back to everything.
  const chosen =
    !sinceUuid || checkpointIndex < 0 ? segments : segments.slice(checkpointIndex);

  return {
    meta,
    text: chosen.join("\n\n"),
    lastUuid: meta.lastUuid,
    empty: chosen.length === 0,
    planRefs: [...planRefs],
  };
}

/** Split text into chunks no larger than maxChars, preferring paragraph breaks. */
export function chunkText(text: string, maxChars = 120000): string[] {
  if (text.length <= maxChars) return text ? [text] : [];
  const paras = text.split("\n\n");
  const chunks: string[] = [];
  let cur = "";
  for (const para of paras) {
    if (para.length > maxChars) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      for (let i = 0; i < para.length; i += maxChars) chunks.push(para.slice(i, i + maxChars));
      continue;
    }
    if (cur.length + para.length + 2 > maxChars) {
      chunks.push(cur);
      cur = para;
    } else {
      cur = cur ? `${cur}\n\n${para}` : para;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
