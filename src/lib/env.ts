import fs from "node:fs";
import path from "node:path";

/**
 * Load `.env.local` into `process.env` for code that runs OUTSIDE Next.
 *
 * Next loads `.env.local` automatically, but the CLI scripts (backfill, scan-one, prioritize) run
 * under plain `tsx`, and a hook-spawned job gets an even barer environment. Without this they
 * silently miss settings the app relies on — most importantly
 * `DASHBOARD_FORCE_SUBSCRIPTION_AUTH`, whose whole job is to strip an inherited, possibly-expired
 * `ANTHROPIC_*` token so the `claude` CLI falls back to its own persistent login. Missing it turns
 * every unattended extraction into a 401.
 *
 * Deliberately minimal (no dependency): `KEY=value`, `#` comments, optional quotes. Existing
 * environment variables always win, so an explicit `FOO=1 npm run …` still overrides the file.
 */
export function loadEnvLocal(rootDir = process.cwd()): void {
  const file = path.join(rootDir, ".env.local");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env.local is a normal setup
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue; // blank line or comment
    const key = m[1];
    if (process.env[key] != null) continue; // real env wins
    process.env[key] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}
