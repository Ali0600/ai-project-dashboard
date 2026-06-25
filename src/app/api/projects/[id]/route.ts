import { NextResponse } from "next/server";
import { deleteProject, getProject } from "@/lib/store";

export const runtime = "nodejs";

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
