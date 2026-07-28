import { NextResponse } from "next/server";
import {
  confirmDone,
  dismissSuggestion,
  promoteToTask,
  updateItemPriority,
  updateItemStatus,
} from "@/lib/store";
import { ITEM_STATUSES, PRIORITIES, type ItemStatus, type Priority } from "@/lib/types";

export const runtime = "nodejs";

/**
 * PATCH /api/items/:id
 *   { status: "todo"|"in_progress"|"done"|"dismissed" }  -> move card / dismiss item
 *   { priority: "urgent"|"high"|"medium"|"low" }         -> set priority
 *   { promote: true }                                    -> promote a suggestion to a Board task
 *   { suggestion: "confirm" }                            -> accept "looks done" -> done
 *   { suggestion: "dismiss" }                            -> reject "looks done" -> keep task
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemId = Number(id);
  if (!Number.isFinite(itemId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    status?: string;
    priority?: string;
    promote?: boolean;
    suggestion?: "confirm" | "dismiss";
  };

  // Each branch reports whether a row actually changed, so a write against a missing item (e.g.
  // deleted by a project cascade in another tab) 404s instead of reporting a phantom success.
  let changed: boolean;
  if (body.suggestion === "confirm") {
    changed = confirmDone(itemId);
  } else if (body.suggestion === "dismiss") {
    changed = dismissSuggestion(itemId);
  } else if (body.promote === true) {
    const result = promoteToTask(itemId);
    if (result === "missing") {
      return NextResponse.json({ error: "item not found" }, { status: 404 });
    }
    if (result === "already_task") {
      return NextResponse.json({ error: "item is already a task" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, result });
  } else if (body.priority && (PRIORITIES as readonly string[]).includes(body.priority)) {
    changed = updateItemPriority(itemId, body.priority as Priority);
  } else if (body.status && (ITEM_STATUSES as readonly string[]).includes(body.status)) {
    changed = updateItemStatus(itemId, body.status as ItemStatus);
  } else {
    return NextResponse.json({ error: "no valid action provided" }, { status: 400 });
  }

  if (!changed) return NextResponse.json({ error: "item not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
