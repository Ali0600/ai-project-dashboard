import { NextResponse } from "next/server";
import {
  hasScannableManifest,
  preflightUrl,
  readLocalManifests,
  scanFiles,
} from "@/lib/preflight";
import { getPreflightReport, getProject, savePreflightReport } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL = 24 * 60 * 60 * 1000; // cache a project's Report for 24h

/**
 * GET /api/preflight?projectId=<id>[&refresh=1]
 *
 * Returns a project's dependency-health Report. Reads the project's manifests from its local `cwd`,
 * sends them to Preflight's keyless `POST /api/scan`, and caches the Report in SQLite for 24h.
 * `refresh=1` forces a re-scan. On a Preflight outage we fall back to the (stale) cached Report when
 * we have one, so a card degrades gracefully instead of erroring.
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

  const files = readLocalManifests(project.cwd);
  if (!hasScannableManifest(files)) {
    return NextResponse.json({ skipped: true, reason: "no package.json/requirements.txt in project" });
  }

  try {
    const report = await scanFiles(files);
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
