import { NextResponse } from "next/server";
import { getProject, reorderTasks } from "@/lib/store";
import type { ItemStatus } from "@/lib/types";

export const runtime = "nodejs";

/** Only real Kanban columns can receive a drag — 'dismissed' is not a drop target. */
const COLUMN_STATUSES: ItemStatus[] = ["todo", "in_progress", "done"];
/** Bound the write: a column is a handful of cards, never thousands. */
const MAX_ORDERED_IDS = 500;

/**
 * POST /api/projects/:id/reorder — persist a Kanban column's manual card order after a drag.
 * Body: `{ status, orderedIds }`. Writes each task's position (and status, so a cross-column drag
 * lands + orders in one call). Board-only concern, so it's scoped to `kind='task'` in the store.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  if (!getProject(projectId)) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { status?: string; orderedIds?: unknown };
  const status = body.status as ItemStatus;
  if (!COLUMN_STATUSES.includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  if (
    !Array.isArray(body.orderedIds) ||
    !body.orderedIds.every((n) => Number.isFinite(Number(n)))
  ) {
    return NextResponse.json({ error: "orderedIds must be an array of numbers" }, { status: 400 });
  }
  if (body.orderedIds.length > MAX_ORDERED_IDS) {
    return NextResponse.json(
      { error: `orderedIds must contain at most ${MAX_ORDERED_IDS} ids` },
      { status: 400 },
    );
  }

  reorderTasks(projectId, status, body.orderedIds.map(Number));
  return NextResponse.json({ ok: true });
}
