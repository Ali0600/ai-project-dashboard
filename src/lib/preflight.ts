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

/** Dependency manifests (+ lockfiles) we send to Preflight, in priority order. */
const MANIFEST_FILES = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
] as const;

/** Configured Preflight base URL (trailing slash trimmed), or null when unset. */
export function preflightUrl(): string | null {
  const u = process.env.PREFLIGHT_URL?.trim();
  return u ? u.replace(/\/+$/, "") : null;
}

/** Read whatever dependency manifests exist in a project's local working directory. */
export function readLocalManifests(cwd: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of MANIFEST_FILES) {
    try {
      files[name] = fs.readFileSync(path.join(cwd, name), "utf8");
    } catch {
      /* not present in this project — skip */
    }
  }
  return files;
}

/** Preflight can only scan when there's a primary manifest (lockfiles alone aren't enough). */
export function hasScannableManifest(files: Record<string, string>): boolean {
  return Boolean(files["package.json"] || files["requirements.txt"]);
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

/** Headline counts for a card badge: CVEs, malware, and how many deps were flagged (not "safe"). */
export function reportHeadline(report: PreflightReport): {
  cve: number;
  malware: number;
  flagged: number;
  total: number;
} {
  const cve = report.summary?.cve ?? 0;
  const malware = report.summary?.malware ?? 0;
  const total = report.total ?? report.findings?.length ?? 0;
  const safe = report.summary?.safe ?? 0;
  // "flagged" = anything Preflight didn't mark safe (cve/malware/stale/…); fall back to total - safe.
  const flagged = Math.max(
    cve + malware,
    report.findings ? report.findings.filter((f) => f.verdict && f.verdict !== "safe").length : total - safe,
  );
  return { cve, malware, flagged, total };
}
