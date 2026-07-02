/**
 * Idempotent installer. Wires the dashboard into Claude Code:
 *   1. Adds a SessionEnd hook to <target>/settings.json (preserving existing hooks).
 *   2. Installs the /sync-board slash command into <target>/commands/.
 *   3. Appends a marker-fenced nudge block to <target>/CLAUDE.md.
 *
 *   npx tsx scripts/install.ts                 # installs into ~/.claude
 *   npx tsx scripts/install.ts --dry-run       # show what would change
 *   npx tsx scripts/install.ts --target <dir>  # install into a different dir (for testing)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dryRun = process.argv.includes("--dry-run");
const target = arg("--target") || path.join(os.homedir(), ".claude");
const dashboardDir = process.cwd();
const dbPath = path.join(dashboardDir, "data", "dashboard.db");

const HOOK_MARKER = "scripts/flag-hook.ts";
const HOOK_COMMAND = `cd "${dashboardDir}" && DASHBOARD_DB="${dbPath}" npx tsx scripts/flag-hook.ts`;

const CLAUDE_MD_START = "<!-- ai-project-dashboard:start -->";
const CLAUDE_MD_END = "<!-- ai-project-dashboard:end -->";
const CLAUDE_MD_BLOCK = `${CLAUDE_MD_START}
## AI Project Dashboard

Conversations are captured to a local Kanban dashboard at ${dashboardDir}.
- When you give the user an actionable **task** or a **suggestion** (advice / an "Optional Next Step:"), state it clearly so it can be captured.
- The user can run **\`/sync-board\`** to pull this conversation's items into the dashboard.
- A SessionEnd hook flags each conversation as \`needs_scan\`; the user scans it from the dashboard UI or with \`/sync-board\`.
${CLAUDE_MD_END}`;

function log(action: string, detail: string) {
  console.log(`${dryRun ? "[dry-run] " : ""}${action}: ${detail}`);
}

/* 1. settings.json — merge SessionEnd hook -------------------------------- */
function installHook() {
  const settingsPath = path.join(target, "settings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  }
  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  const sessionEnd = (hooks.SessionEnd ??= []) as Array<{
    hooks?: Array<{ type: string; command: string }>;
  }>;

  const existing = sessionEnd.find((entry) =>
    entry.hooks?.some((h) => h.command?.includes(HOOK_MARKER)),
  );
  if (existing) {
    const h = existing.hooks!.find((h) => h.command.includes(HOOK_MARKER))!;
    if (h.command === HOOK_COMMAND) {
      log("hook", "already installed (unchanged)");
      return;
    }
    h.command = HOOK_COMMAND;
    log("hook", "updated existing SessionEnd hook command");
  } else {
    sessionEnd.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
    log("hook", "added SessionEnd hook");
  }

  if (!dryRun) {
    fs.mkdirSync(target, { recursive: true });
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + ".bak");
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
}

/* 2. /sync-board command -------------------------------------------------- */
function installCommand() {
  const src = path.join(dashboardDir, ".claude", "commands", "sync-board.md");
  if (!fs.existsSync(src)) {
    log("command", `template missing at ${src} — skipped`);
    return;
  }
  const content = fs.readFileSync(src, "utf8").replaceAll("__DASHBOARD_DIR__", dashboardDir);
  const destDir = path.join(target, "commands");
  const dest = path.join(destDir, "sync-board.md");
  if (!dryRun) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, content);
  }
  log("command", `installed /sync-board -> ${dest}`);
}

/* 3. CLAUDE.md nudge ------------------------------------------------------ */
function installClaudeMd() {
  const claudeMd = path.join(target, "CLAUDE.md");
  let content = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, "utf8") : "";
  if (content.includes(CLAUDE_MD_START)) {
    const re = new RegExp(`${CLAUDE_MD_START}[\\s\\S]*?${CLAUDE_MD_END}`);
    content = content.replace(re, CLAUDE_MD_BLOCK);
    log("CLAUDE.md", "refreshed dashboard block");
  } else {
    content = content.trimEnd() + (content.trim() ? "\n\n" : "") + CLAUDE_MD_BLOCK + "\n";
    log("CLAUDE.md", "appended dashboard block");
  }
  if (!dryRun) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(claudeMd, content);
  }
}

console.log(`Installing AI Project Dashboard into ${target}`);
console.log(`Dashboard dir: ${dashboardDir}\n`);
installHook();
installCommand();
installClaudeMd();
console.log(
  dryRun
    ? "\nDry run complete — no files changed."
    : "\nDone. Restart Claude Code sessions to pick up the new hook.",
);
