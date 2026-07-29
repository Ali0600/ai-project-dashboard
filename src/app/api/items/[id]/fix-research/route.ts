import { NextResponse } from "next/server";
import { ClaudeUnavailableError, researchFix } from "@/lib/claude";
import { getItemContext, saveFixResearch } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300; // web research runs a few minutes

/**
 * POST /api/items/:id/fix-research — "How do I fix this?": research the failure on the web and
 * store a sourced remediation writeup. Read-the-web only (no repo access, no edits) and the result
 * is review-only text; it is never executed and never handed to an edit-enabled agent.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemId = Number(id);
  if (!Number.isFinite(itemId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const ctx = getItemContext(itemId);
  if (!ctx) return NextResponse.json({ error: "item not found" }, { status: 404 });
  if (ctx.item.kind !== "failure") {
    return NextResponse.json({ error: "fix research applies to failures only" }, { status: 400 });
  }

  try {
    // Project NAME only — never the cwd. A filesystem path is of no use to a web-only agent and
    // would be one more piece of local detail crossing into a prompt with open egress.
    const research = await researchFix({
      projectName: ctx.projectName,
      title: ctx.item.title,
      detail: ctx.item.detail ?? "",
      sourceQuote: ctx.item.source_quote ?? "",
    });
    saveFixResearch(itemId, research);
    return NextResponse.json({ ok: true, research });
  } catch (e) {
    if (e instanceof ClaudeUnavailableError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    console.error(`[fix-research] item ${itemId} failed:`, e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
