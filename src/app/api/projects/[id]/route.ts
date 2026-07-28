import fs from "node:fs";
import { NextResponse } from "next/server";
import { deleteProject, getProject, getProjectByCwd, updateProjectCwd } from "@/lib/store";

export const runtime = "nodejs";

/**
 * PATCH /api/projects/:id — re-point a project at a moved folder. `{ cwd }`.
 *
 * Projects are keyed by their local path, and capture matches that path exactly, so moving a repo
 * silently stops capture and breaks dependency scanning + apply-on-branch. This lets the project
 * follow the move instead of stranding its history.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  if (!getProject(projectId)) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { cwd?: string };
  const cwd = (body.cwd ?? "").trim();
  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  // Point only at a real directory — a typo'd path would break capture just as silently.
  let isDir: boolean;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return NextResponse.json({ error: `not a directory: ${cwd}` }, { status: 400 });
  }
  const clash = getProjectByCwd(cwd);
  if (clash && clash.id !== projectId) {
    return NextResponse.json(
      { error: `another project (${clash.name}) already uses that folder` },
      { status: 409 },
    );
  }

  updateProjectCwd(projectId, cwd);
  return NextResponse.json({ ok: true, cwd });
}

/** DELETE /api/projects/:id — remove a project and (via ON DELETE CASCADE) its conversations + items. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  if (!getProject(projectId)) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }
  deleteProject(projectId);
  return NextResponse.json({ ok: true });
}
