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

// Every open item's title is injected into the EXISTING OPEN ITEMS block of every extraction chunk
// prompt (and the research prompt), so one oversized item would inflate every future LLM call for
// this project. Bound them at the entry point; the extractor is already told to keep titles short.
const MAX_TITLE = 200;
const MAX_DETAIL = 4000;

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
  const detail = (body.detail ?? "").trim();
  if (!Number.isFinite(projectId) || !title) {
    return NextResponse.json({ error: "projectId and title are required" }, { status: 400 });
  }
  if (title.length > MAX_TITLE || detail.length > MAX_DETAIL) {
    return NextResponse.json(
      { error: `title must be ≤ ${MAX_TITLE} chars and detail ≤ ${MAX_DETAIL}` },
      { status: 400 },
    );
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

  const id = insertItem({ projectId, kind, title, detail, priority, status });
  if (id == null) {
    return NextResponse.json({ error: "A task with this title already exists" }, { status: 409 });
  }
  return NextResponse.json({ id }, { status: 201 });
}
