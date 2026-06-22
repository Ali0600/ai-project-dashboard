import { spawn } from "node:child_process";
import { ExtractionResult, PRIORITIES, type Priority } from "./types";

const MODEL = process.env.CLAUDE_EXTRACT_MODEL || "haiku";
const MAX_BUDGET = process.env.CLAUDE_MAX_BUDGET_USD || "0.25";
const IMPLEMENT_MODEL = process.env.CLAUDE_IMPLEMENT_MODEL || "sonnet";
const IMPLEMENT_BUDGET = process.env.CLAUDE_IMPLEMENT_BUDGET_USD || "0.50";

export class ClaudeUnavailableError extends Error {}

/** The instruction given to headless Claude. Mirrors prompts/extract.md. */
const INSTRUCTION = `You analyze a Claude Code conversation transcript and extract a project's actionable knowledge as STRICT JSON.

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "tasks":       [{"title": string, "detail": string, "status_guess": "todo"|"in_progress"|"done", "priority": "urgent"|"high"|"medium"|"low", "source_quote": string}],
  "suggestions": [{"title": string, "detail": string, "source_quote": string}],
  "learnings":   [{"title": string, "detail": string, "source_quote": string}],
  "completed":   [{"existing_id_or_title": string, "evidence_quote": string}]
}

Definitions:
- tasks: concrete, actionable work items for the user to do (things to build, fix, configure, test).
- priority (tasks only): urgent | high | medium | low — how important/time-sensitive the task is (blockers and security issues = urgent; nice-to-haves = low). Default medium when unsure.
- suggestions: advice, ideas, or optional next steps the assistant proposed that are NOT already concrete committed tasks ("you should", "I recommend", "consider", "Optional Next Step:").
- learnings: teachable, transferable concepts worth remembering.
- completed: items from the EXISTING OPEN ITEMS list below that this conversation shows are now DONE. Use the existing item's exact title (or id) in existing_id_or_title, and quote the evidence.

Rules:
- Titles must be short and actionable (max ~10 words). Put context in detail.
- Do NOT duplicate anything already in EXISTING OPEN ITEMS — only emit genuinely new items.
- Never list the same item as both a task and a suggestion — if it's concrete committed work, it's a task.
- Only list something under "completed" if there is explicit evidence it was finished.
- source_quote / evidence_quote: a SHORT paraphrase (max ~100 chars). Do NOT include double-quote characters or newlines inside any string value.
- If a category has nothing, use an empty array. Never invent items.

OUTPUT FORMAT: return ONLY valid, minified JSON on a single line. No markdown, no code fences, no commentary. Every string value must escape special characters and contain no literal newlines.`;

function buildPrompt(conversationText: string, existingOpenTitles: string[]): string {
  const existing =
    existingOpenTitles.length > 0
      ? existingOpenTitles.map((t) => `- ${t}`).join("\n")
      : "(none)";
  return `${INSTRUCTION}

=== EXISTING OPEN ITEMS (do not duplicate; use for "completed" detection) ===
${existing}

=== CONVERSATION TRANSCRIPT ===
${conversationText}

=== END TRANSCRIPT ===
Return the JSON object now.`;
}

/** Spawn the `claude` CLI with the given args; prompt (if any) is piped via stdin. */
function spawnClaude(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // Mark these as the dashboard's own subprocesses so our SessionEnd hook
    // (flag-hook.ts) ignores them instead of capturing them as conversations.
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env, DASHBOARD_EXTRACTION: "1" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        reject(new ClaudeUnavailableError("`claude` CLI not found on PATH"));
      } else {
        reject(e);
      }
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const combined = `${out}\n${err}`;
        if (/\b401\b|authenticate|authentication credentials|invalid api key|oauth/i.test(combined)) {
          reject(
            new ClaudeUnavailableError(
              "The `claude` CLI failed to authenticate (401). The dashboard server is using expired/invalid " +
                "credentials — this happens when the dev server was started from an environment whose token has " +
                "since expired. Restart the dashboard from a terminal where `claude` is logged in (run `claude` " +
                "once to log in, or `claude setup-token` for a persistent headless token), then scan again.",
            ),
          );
        } else {
          reject(new Error(`claude exited with code ${code}: ${err || out}`.trim()));
        }
      } else {
        resolve(out);
      }
    });
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

function runClaude(prompt: string): Promise<string> {
  return spawnClaude(
    ["-p", "--output-format", "json", "--model", MODEL, "--no-session-persistence", "--max-budget-usd", MAX_BUDGET],
    { input: prompt },
  );
}

/** Remove ASCII control characters that are illegal unescaped inside JSON strings. */
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) out += ch.charCodeAt(0) < 0x20 ? " " : ch;
  return out;
}

/** Pull a JSON object out of text that may be fenced or have surrounding prose. */
export function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in model output");
  }
  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Common failure: raw newlines/tabs inside string values.
    return JSON.parse(stripControlChars(candidate));
  }
}

/**
 * Run one headless extraction over a single chunk of conversation text.
 * Retries once with a corrective nudge if the model returns invalid JSON.
 */
export async function extractOnce(
  conversationText: string,
  existingOpenTitles: string[],
): Promise<ExtractionResult> {
  const base = buildPrompt(conversationText, existingOpenTitles);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? base
        : `${base}\n\nYour previous response was not valid JSON. Return ONLY a single line of valid, minified JSON with all quotes escaped and no newlines inside strings.`;
    const envelope = JSON.parse(await runClaude(prompt));
    if (envelope.is_error || envelope.subtype !== "success") {
      lastErr = new Error(`Claude extraction failed: ${envelope.subtype || "unknown error"}`);
      continue;
    }
    try {
      return ExtractionResult.parse(extractJsonObject(String(envelope.result ?? "")));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("extraction failed");
}

/**
 * Ask headless Claude to assign a priority to each existing task. Returns a map of
 * task id -> priority; tasks the model omits or scores invalidly are left out.
 */
export async function assignPriorities(
  tasks: { id: number; title: string }[],
): Promise<Record<number, Priority>> {
  if (tasks.length === 0) return {};
  const list = tasks.map((t) => `${t.id}: ${t.title}`).join("\n");
  const prompt = `You assign a priority to each software-project task below.
Priorities: "urgent" (blockers, security, broken builds), "high" (important soon), "medium" (normal), "low" (nice-to-have).

Return ONLY a JSON object mapping each task id (string key) to one of "urgent"|"high"|"medium"|"low". No prose, no code fences. Example: {"12":"high","13":"low"}.

TASKS:
${list}`;

  const envelope = JSON.parse(await runClaude(prompt));
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(`Claude prioritization failed: ${envelope.subtype || "unknown error"}`);
  }
  const raw = extractJsonObject(String(envelope.result ?? "")) as Record<string, unknown>;
  const out: Record<number, Priority> = {};
  for (const t of tasks) {
    const v = String(raw[String(t.id)] ?? "").toLowerCase();
    if ((PRIORITIES as readonly string[]).includes(v)) out[t.id] = v as Priority;
  }
  return out;
}

/**
 * Draft an implementation plan for a task. Resumes the source conversation (so it has the
 * original context) and runs read-only — edit/shell tools are disallowed, so nothing is
 * written to disk. Returns the plan text. If there's no source conversation, runs fresh in
 * the project dir (CLAUDE.md context only).
 */
export async function implementPlan(opts: {
  sessionId: string | null;
  cwd: string;
  title: string;
  detail: string;
}): Promise<string> {
  const prompt = `Draft a concise, actionable implementation plan for the task below, for this project.
This is PLANNING ONLY — do not modify any files. Inspect the code (read-only) as needed, then reply with:
1. Approach — a 1-2 sentence summary.
2. Steps — the concrete changes (key files + what to change in each).
3. Risks / edge cases to watch.

TASK: ${opts.title}
DETAILS: ${opts.detail || "(none)"}`;

  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    IMPLEMENT_MODEL,
    "--max-budget-usd",
    IMPLEMENT_BUDGET,
    // Read-only: no file edits, no shell — guarantees "plan only, applies nothing".
    "--disallowed-tools",
    "Write Edit MultiEdit NotebookEdit Bash",
  ];
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  else args.push("--no-session-persistence");

  const envelope = JSON.parse(await spawnClaude(args, { cwd: opts.cwd, input: prompt }));
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(`Claude implement failed: ${envelope.subtype || "unknown error"}`);
  }
  return String(envelope.result ?? "").trim();
}

/** Merge several chunk extractions into one (DB handles final de-duplication). */
export function mergeExtractions(parts: ExtractionResult[]): ExtractionResult {
  const merged: ExtractionResult = {
    tasks: [],
    suggestions: [],
    learnings: [],
    completed: [],
  };
  for (const p of parts) {
    merged.tasks.push(...p.tasks);
    merged.suggestions.push(...p.suggestions);
    merged.learnings.push(...p.learnings);
    merged.completed.push(...p.completed);
  }
  return merged;
}
