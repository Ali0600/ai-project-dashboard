import fs from "node:fs";
import path from "node:path";

/**
 * Preflight integration — the dashboard treats Preflight as the single source of dependency-health
 * truth (https://preflight-web.vercel.app, keyless `POST /api/scan`). We read each project's manifest
 * from its local `cwd` (this dashboard stores projects as local paths, not GitHub repos), send it to
 * Preflight, and render the returned `Report` with our own cards. Any Preflight improvement appears on
 * its next redeploy with zero changes here.
 */

/** One dependency's verdict from a Preflight scan (extra fields tolerated). */
export interface PreflightFinding {
  name: string;
  range?: string;
  version?: string;
  dev?: boolean;
  direct?: boolean;
  vulns?: unknown[];
  lockstep?: unknown;
  verdict?: string; // "safe" | "cve" | "malware" | "stale" | …
  reason?: string;
  [k: string]: unknown;
}

/** Counts keyed by category (cve / malware / pinned / stale / safe / …). */
export type PreflightSummary = Record<string, number | undefined> & {
  cve?: number;
  malware?: number;
};

/** The full Report returned by `POST /api/scan`. */
export interface PreflightReport {
  ecosystem?: string;
  path?: string;
  total?: number;
  summary?: PreflightSummary;
  findings?: PreflightFinding[];
  [k: string]: unknown;
}

/** A package.json's lockfile is taken from the same directory as the package.json. */
const NPM_LOCKFILES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"] as const;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".turbo",
  "coverage",
]);
const MAX_SEARCH_DEPTH = 2; // root + up to 2 nested levels (monorepos: mobile/+backend/, packages/web/)

/** Configured Preflight base URL (trailing slash trimmed), or null when unset. */
export function preflightUrl(): string | null {
  const u = process.env.PREFLIGHT_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

/** Files for ONE ecosystem scan: a package.json (+ its lockfile), or a requirements.txt. */
export type ManifestGroup = Record<string, string>;

const MAX_GROUPS = 8; // bound the number of /api/scan calls for a large monorepo

/**
 * Collect dependency-manifest groups for a project — one per ecosystem occurrence. Checks the root,
 * then shallow subdirectories, so a monorepo's nested manifests are each found and scanned separately
 * (Preflight scans one ecosystem per call). E.g. grocery-helper → [{mobile/package.json + lockfile},
 * {backend/requirements.txt}]. Skips node_modules, build output, and hidden dirs.
 */
export function collectManifestGroups(cwd: string): ManifestGroup[] {
  const groups: ManifestGroup[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];

  while (queue.length > 0 && groups.length < MAX_GROUPS) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const read = (name: string): string | null => {
      try {
        return fs.readFileSync(path.join(dir, name), "utf8");
      } catch {
        return null;
      }
    };

    if (fileNames.has("package.json")) {
      const pkg = read("package.json");
      if (pkg != null) {
        const group: ManifestGroup = { "package.json": pkg };
        for (const lock of NPM_LOCKFILES) {
          const content = fileNames.has(lock) ? read(lock) : null;
          if (content != null) {
            group[lock] = content;
            break; // one lockfile per package.json
          }
        }
        groups.push(group);
      }
    }
    if (fileNames.has("requirements.txt")) {
      const req = read("requirements.txt");
      if (req != null) groups.push({ "requirements.txt": req });
    }

    if (depth < MAX_SEARCH_DEPTH) {
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
          queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      }
    }
  }
  return groups;
}

/** POST manifests to Preflight's keyless `/api/scan` and return the parsed Report. */
export async function scanFiles(files: Record<string, string>): Promise<PreflightReport> {
  const base = preflightUrl();
  if (!base) throw new Error("PREFLIGHT_URL is not set");
  const res = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Preflight /api/scan failed: HTTP ${res.status}`);
  return (await res.json()) as PreflightReport;
}

/** Liveness check — false if PREFLIGHT_URL is unset or the service is unreachable/unhealthy. */
export async function preflightHealthy(): Promise<boolean> {
  const base = preflightUrl();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return false;
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

/**
 * Merge several single-ecosystem Reports (one per manifest group in a monorepo) into one combined
 * health view: summary counts summed, findings concatenated, ecosystems joined. Returns the sole
 * Report unchanged when there's only one.
 */
export function mergeReports(reports: PreflightReport[]): PreflightReport {
  if (reports.length === 1) return reports[0];
  const summary: PreflightSummary = {};
  const findings: PreflightFinding[] = [];
  const ecosystems = new Set<string>();
  let total = 0;
  for (const r of reports) {
    if (r.ecosystem) ecosystems.add(r.ecosystem);
    total += r.total ?? r.findings?.length ?? 0;
    for (const [k, v] of Object.entries(r.summary ?? {})) {
      if (typeof v === "number") summary[k] = (summary[k] ?? 0) + v;
    }
    if (Array.isArray(r.findings)) findings.push(...r.findings);
  }
  return { ecosystem: [...ecosystems].join(" + "), total, summary, findings };
}
