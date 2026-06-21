import { NextResponse } from "next/server";
import { getProject, insertItem } from "@/lib/store";
import {
  ITEM_KINDS,
  ITEM_STATUSES,
  PRIORITIES,
  type ItemKind,
  type ItemStatus,
  type Priority,
} from "@/lib/types";

export const runtime = "nodejs";

/** POST /api/items — create an item manually. Body: { projectId, title, detail?, priority?, status?, kind? } */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    projectId?: number;
    title?: string;
    detail?: string;
    priority?: string;
    status?: string;
    kind?: string;
  };

  const projectId = Number(body.projectId);
  const title = (body.title ?? "").trim();
  if (!Number.isFinite(projectId) || !title) {
    return NextResponse.json({ error: "projectId and title are required" }, { status: 400 });
  }
  if (!getProject(projectId)) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  const kind = (ITEM_KINDS as readonly string[]).includes(body.kind ?? "")
    ? (body.kind as ItemKind)
    : "task";
  const priority = (PRIORITIES as readonly string[]).includes(body.priority ?? "")
    ? (body.priority as Priority)
    : "medium";
  const status = (ITEM_STATUSES as readonly string[]).includes(body.status ?? "")
    ? (body.status as ItemStatus)
    : "todo";

  const id = insertItem({ projectId, kind, title, detail: body.detail ?? "", priority, status });
  if (id == null) {
    return NextResponse.json({ error: "A task with this title already exists" }, { status: 409 });
  }
  return NextResponse.json({ id }, { status: 201 });
}
