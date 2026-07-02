import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ExtractionResult, PRIORITIES, type Priority, ResearchResult, type ResearchIdea } from "./types";

const MODEL = process.env.CLAUDE_EXTRACT_MODEL || "haiku";
const MAX_BUDGET = process.env.CLAUDE_MAX_BUDGET_USD || "0.25";
const IMPLEMENT_MODEL = process.env.CLAUDE_IMPLEMENT_MODEL || "sonnet";
const IMPLEMENT_BUDGET = process.env.CLAUDE_IMPLEMENT_BUDGET_USD || "0.50";
const APPLY_BUDGET = process.env.CLAUDE_APPLY_BUDGET_USD || "1.00";
const APPLY_DIFF_MAX = 20_000; // cap the diff stored/returned so a huge change doesn't bloat the payload
const RESEARCH_MODEL = process.env.CLAUDE_RESEARCH_MODEL || "sonnet"; // web research + synthesis wants a capable model
const RESEARCH_BUDGET = process.env.CLAUDE_RESEARCH_BUDGET_USD || "0.50";

export class ClaudeUnavailableError extends Error {}

/** The instruction given to headless Claude. Mirrors prompts/extract.md. */
const INSTRUCTION = `You analyze a Claude Code conversation transcript and extract a project's actionable knowledge as STRICT JSON.

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{
  "tasks":       [{"title": string, "detail": string, "status_guess": "todo"|"in_progress"|"done", "priority": "urgent"|"high"|"medium"|"low", "source_quote": string}],
  "suggestions": [{"title": string, "detail": string, "source_quote": string}],
  "completed":   [{"existing_id_or_title": string, "evidence_quote": string}]
}

Definitions:
- tasks: concrete, actionable work items for the user to do (things to build, fix, configure, test).
- priority (tasks only): urgent | high | medium | low — how important/time-sensitive the task is (blockers and security issues = urgent; nice-to-haves = low). Default medium when unsure.
- suggestions: advice, ideas, or optional next steps the assistant proposed that are NOT already concrete committed tasks ("you should", "I recommend", "consider", "Optional Next Step:").
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

/** True when DASHBOARD_FORCE_SUBSCRIPTION_AUTH is set to a truthy value (opt-in). */
function forceSubscriptionAuth(): boolean {
  const v = process.env.DASHBOARD_FORCE_SUBSCRIPTION_AUTH;
  return v != null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Build the environment for a spawned `claude` process. Always tags it with DASHBOARD_EXTRACTION
 * (so flag-hook ignores it). When `force` is set, strips every inherited `ANTHROPIC_*` variable
 * (API key, auth token, base URL, …) so the CLI falls back to its own persistent login
 * (`claude setup-token`) instead of a possibly-expired token inherited from the parent shell
 * (e.g. the desktop app's terminal) — preventing 401 "poisoning".
 */
export function spawnEnv(base: NodeJS.ProcessEnv, force: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, DASHBOARD_EXTRACTION: "1" };
  if (force) {
    for (const key of Object.keys(env)) {
      if (/^ANTHROPIC_/i.test(key)) delete env[key];
    }
  }
  return env;
}

/** Spawn the `claude` CLI with the given args; prompt (if any) is piped via stdin. */
function spawnClaude(args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // Mark these as the dashboard's own subprocesses so our SessionEnd hook (flag-hook.ts)
    // ignores them; optionally strip inherited ANTHROPIC_* so we use the persistent login.
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: spawnEnv(process.env, forceSubscriptionAuth()),
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
    "Write Edit NotebookEdit Bash",
  ];
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  else args.push("--no-session-persistence");

  const envelope = JSON.parse(await spawnClaude(args, { cwd: opts.cwd, input: prompt }));
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(`Claude implement failed: ${envelope.subtype || "unknown error"}`);
  }
  return String(envelope.result ?? "").trim();
}

/** Run a git command in `cwd`, resolving stdout (throws with stderr on failure). */
function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

function branchSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export interface ApplyResult {
  branch: string;
  changedFiles: number;
  diff: string;
  summary: string;
  /** Set only when changes were made but couldn't be committed — the worktree is kept for recovery. */
  worktreeDir: string | null;
}

/**
 * "Apply on a branch": run the agent with edits ENABLED but bounded, inside an isolated git
 * worktree + new branch of the task's project, then capture the diff. The main checkout is never
 * touched, shell/network tools are disallowed, and nothing is pushed or PR'd — the durable artifact
 * is a local `dashboard/apply-*` branch the user reviews and pushes themselves.
 *
 * Runs fresh (NOT `--resume`) so every file operation is relative to the worktree cwd — a resumed
 * session could carry absolute paths back to the original checkout and defeat the isolation.
 */
export async function applyPlanOnBranch(opts: {
  cwd: string;
  title: string;
  detail: string;
  plan?: string | null;
}): Promise<ApplyResult> {
  let repoRoot: string;
  try {
    repoRoot = (await git(["rev-parse", "--show-toplevel"], opts.cwd)).trim();
  } catch {
    throw new Error(
      `Not a git repository: ${opts.cwd}. "Apply on a branch" needs the project to be under git.`,
    );
  }

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const branch = `dashboard/apply-${branchSlug(opts.title)}-${Date.now().toString(36)}`;
  const worktreeDir = path.join(os.tmpdir(), `dash-apply-${stamp}`);

  await git(["worktree", "add", "-b", branch, worktreeDir, "HEAD"], repoRoot);

  try {
    const prompt = `Implement the task below by editing files in THIS repository. Make the changes directly; keep them focused and correct. Do not run shell commands.

TASK: ${opts.title}
DETAILS: ${opts.detail || "(none)"}${opts.plan ? `\n\nPLAN TO FOLLOW:\n${opts.plan}` : ""}

When done, briefly summarize what you changed (the key files and the gist).`;

    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      IMPLEMENT_MODEL,
      "--max-budget-usd",
      APPLY_BUDGET,
      // Edits auto-accepted, but bounded: deny shell + network so the run only changes files here.
      "--permission-mode",
      "acceptEdits",
      "--disallowed-tools",
      "Bash WebFetch WebSearch",
      "--no-session-persistence",
    ];

    const envelope = JSON.parse(await spawnClaude(args, { cwd: worktreeDir, input: prompt }));
    if (envelope.is_error || envelope.subtype !== "success") {
      throw new Error(`Claude apply failed: ${envelope.subtype || "unknown error"}`);
    }
    const summary = String(envelope.result ?? "").trim();

    await git(["add", "-A"], worktreeDir);
    const nameOnly = (await git(["diff", "--cached", "--name-only"], worktreeDir)).trim();
    if (!nameOnly) {
      // Agent made no edits — clean up the throwaway branch + worktree.
      await git(["worktree", "remove", "--force", worktreeDir], repoRoot).catch(() => {});
      await git(["branch", "-D", branch], repoRoot).catch(() => {});
      return { branch, changedFiles: 0, diff: "", summary, worktreeDir: null };
    }

    const changedFiles = nameOnly.split("\n").filter(Boolean).length;
    let diff = await git(["diff", "--cached"], worktreeDir);
    if (diff.length > APPLY_DIFF_MAX) {
      diff = `${diff.slice(0, APPLY_DIFF_MAX)}\n… (diff truncated at ${APPLY_DIFF_MAX} chars)`;
    }

    // Commit so the branch is a clean, reviewable artifact; then drop the temp worktree (branch stays).
    let committed = false;
    try {
      await git(["commit", "-q", "-m", `Apply: ${opts.title}`], worktreeDir);
      committed = true;
    } catch {
      committed = false; // e.g. missing git identity — keep the worktree so the changes aren't lost.
    }

    if (committed) {
      await git(["worktree", "remove", "--force", worktreeDir], repoRoot).catch(() => {});
      return { branch, changedFiles, diff, summary, worktreeDir: null };
    }
    return { branch, changedFiles, diff, summary, worktreeDir };
  } catch (e) {
    // Leave nothing dangling on failure.
    await git(["worktree", "remove", "--force", worktreeDir], repoRoot).catch(() => {});
    await git(["branch", "-D", branch], repoRoot).catch(() => {});
    throw e;
  }
}

/**
 * Research the web for features/tasks people are ASKING FOR in a project like `topic`. Runs headless
 * `claude -p` with WebSearch + WebFetch ENABLED (and edit/shell tools disabled, so it can only read
 * the web — it can't act on anything it finds). Returns deduped idea candidates, each with a source
 * URL. Retries once on malformed JSON (mirrors extractOnce). Empty array if nothing is found.
 */
export async function researchFeatures(opts: {
  topic: string;
  existingTitles: string[];
}): Promise<ResearchIdea[]> {
  const existing =
    opts.existingTitles.length > 0 ? opts.existingTitles.map((t) => `- ${t}`).join("\n") : "(none)";
  const base = `You research what features, improvements, and tasks PEOPLE ARE ASKING FOR in projects like the one described below. Use the WebSearch and WebFetch tools to check real, recent sources — Reddit, forums, Product Hunt, Hacker News, GitHub issues, blog posts. Find concrete, frequently-requested ideas (pain points, "I wish it could…", feature requests), not generic advice.

PROJECT: ${opts.topic}

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{"ideas":[{"title": string, "detail": string, "source_url": string, "source_quote": string}]}

Rules:
- Each idea MUST have a real source_url you actually visited (the page where people ask for it).
- title: short and actionable (max ~10 words). detail: 1-2 sentences of context. source_quote: a SHORT paraphrase of what was requested (max ~100 chars, no double-quotes or newlines).
- Do NOT include anything already in EXISTING ITEMS below. Prefer ideas requested by multiple people.
- If you genuinely find nothing concrete, return {"ideas":[]}. Never invent ideas or URLs.

=== EXISTING ITEMS (do not duplicate) ===
${existing}

Return the JSON object now.`;

  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    RESEARCH_MODEL,
    "--max-budget-usd",
    RESEARCH_BUDGET,
    // Web access ON; edits/shell OFF so the agent can only read the web, never act on it.
    "--allowed-tools",
    "WebSearch WebFetch Read",
    "--disallowed-tools",
    "Write Edit NotebookEdit Bash",
    "--no-session-persistence",
  ];

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? base
        : `${base}\n\nYour previous response was not valid JSON. Return ONLY a single line of valid, minified JSON with all quotes escaped and no newlines inside strings.`;
    const envelope = JSON.parse(await spawnClaude(args, { input: prompt }));
    if (envelope.is_error || envelope.subtype !== "success") {
      lastErr = new Error(`Claude research failed: ${envelope.subtype || "unknown error"}`);
      continue;
    }
    try {
      return ResearchResult.parse(extractJsonObject(String(envelope.result ?? ""))).ideas;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("research failed");
}

/** Merge several chunk extractions into one (DB handles final de-duplication). */
export function mergeExtractions(parts: ExtractionResult[]): ExtractionResult {
  const merged: ExtractionResult = {
    tasks: [],
    suggestions: [],
    completed: [],
  };
  for (const p of parts) {
    merged.tasks.push(...p.tasks);
    merged.suggestions.push(...p.suggestions);
    merged.completed.push(...p.completed);
  }
  return merged;
}
