import { NextResponse } from "next/server";
import { ClaudeUnavailableError, implementPlan } from "@/lib/claude";
import { getItemContext, saveImplementationPlan } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300; // resuming + planning can take a while

/**
 * POST /api/items/:id/implement — draft an implementation plan for the task by resuming its
 * source conversation (read-only; nothing is written to the repo). Persists and returns the plan.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemId = Number(id);
  if (!Number.isFinite(itemId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const ctx = getItemContext(itemId);
  if (!ctx) return NextResponse.json({ error: "item not found" }, { status: 404 });

  try {
    const plan = await implementPlan({
      sessionId: ctx.sessionId,
      cwd: ctx.projectCwd,
      title: ctx.item.title,
      detail: ctx.item.detail ?? "",
    });
    saveImplementationPlan(itemId, plan);
    return NextResponse.json({ ok: true, plan });
  } catch (e) {
    if (e instanceof ClaudeUnavailableError) {
      return NextResponse.json(
        { error: "The `claude` CLI is not available on the server PATH." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
