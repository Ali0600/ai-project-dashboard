import { NextResponse } from "next/server";
import {
  collectManifestGroups,
  mergeReports,
  type PreflightReport,
  preflightUrl,
  scanFiles,
} from "@/lib/preflight";
import { getPreflightReport, getProject, savePreflightReport } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL = 24 * 60 * 60 * 1000; // cache a project's Report for 24h

/**
 * GET /api/preflight?projectId=<id>[&refresh=1]
 *
 * Returns a project's dependency-health Report. Finds the project's manifests under its local `cwd`
 * (root + shallow subdirs, so monorepos work), scans each ecosystem group via Preflight's keyless
 * `POST /api/scan`, merges the results into one Report, and caches it in SQLite for 24h. `refresh=1`
 * forces a re-scan. On a Preflight outage we fall back to the (stale) cached Report when we have one,
 * so the panel degrades gracefully instead of erroring.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectId = Number(url.searchParams.get("projectId"));
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  if (!preflightUrl()) {
    return NextResponse.json({ error: "PREFLIGHT_URL not set" }, { status: 503 });
  }

  const force = url.searchParams.get("refresh") === "1";
  const cached = getPreflightReport(projectId);
  if (cached && !force && Date.now() - cached.fetched_at < TTL) {
    return NextResponse.json({ report: JSON.parse(cached.report), cached: true, fetched_at: cached.fetched_at });
  }

  const groups = collectManifestGroups(project.cwd);
  if (groups.length === 0) {
    return NextResponse.json({ skipped: true, reason: "no package.json/requirements.txt in project" });
  }

  try {
    // One /api/scan per ecosystem group (Preflight scans one ecosystem per call); merge into one
    // Report. allSettled so a monorepo still shows the ecosystems that succeed if one errors.
    const settled = await Promise.allSettled(groups.map((g) => scanFiles(g)));
    const reports: PreflightReport[] = [];
    for (const s of settled) if (s.status === "fulfilled") reports.push(s.value);
    if (reports.length === 0) {
      const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
      throw new Error(rejected?.reason?.message ?? "Preflight scan failed");
    }
    const report = mergeReports(reports);
    const fetched_at = Date.now();
    savePreflightReport(projectId, JSON.stringify(report), fetched_at);
    return NextResponse.json({ report, cached: false, fetched_at });
  } catch (e) {
    // Preflight unreachable/erroring — serve the stale cache if we have one.
    if (cached) {
      return NextResponse.json({
        report: JSON.parse(cached.report),
        cached: true,
        stale: true,
        fetched_at: cached.fetched_at,
        error: (e as Error).message,
      });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
