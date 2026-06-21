import { NextResponse } from "next/server";
import { listItemsWithSource } from "@/lib/store";

export const runtime = "nodejs";

/** GET /api/projects/:id/items — items joined with source conversation (for client refetch). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  return NextResponse.json(listItemsWithSource(projectId));
}
