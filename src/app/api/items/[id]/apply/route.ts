import { NextResponse } from "next/server";
import { applyPlanOnBranch, ClaudeUnavailableError } from "@/lib/claude";
import { getItemContext, saveApplyResult } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 600; // editing + committing can take a while

/**
 * POST /api/items/:id/apply — "Apply on a branch": run the agent with edits enabled inside an
 * isolated git worktree + branch of the task's project, capture the diff, persist it. Never pushes.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemId = Number(id);
  if (!Number.isFinite(itemId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const ctx = getItemContext(itemId);
  if (!ctx) return NextResponse.json({ error: "item not found" }, { status: 404 });
  // Tasks only. Suggestion/research text is model- and web-authored; promoting it to a task is the
  // human checkpoint before it can steer an edit-enabled agent, and the UI's task-only gate is
  // client-side, so enforce it here too.
  if (ctx.item.kind !== "task") {
    return NextResponse.json(
      { error: "only tasks can be applied — promote this item to a task first" },
      { status: 400 },
    );
  }

  try {
    const res = await applyPlanOnBranch({
      cwd: ctx.projectCwd,
      title: ctx.item.title,
      detail: ctx.item.detail ?? "",
      plan: ctx.item.implementation_plan,
    });
    // Persist the branch + diff (clear them when the run made no changes).
    saveApplyResult(itemId, res.changedFiles > 0 ? res.branch : null, res.diff || null);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof ClaudeUnavailableError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
