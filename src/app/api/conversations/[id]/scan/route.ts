import { NextResponse } from "next/server";
import { ClaudeUnavailableError } from "@/lib/claude";
import { scanTranscript } from "@/lib/scan";
import { getConversation } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300; // headless extraction can take a while

/** POST /api/conversations/:id/scan — run headless extraction for one conversation. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conv = getConversation(Number(id));
  if (!conv) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  try {
    const result = await scanTranscript(conv.transcript_path, { incremental: true });
    return NextResponse.json({ ok: true, ...result });
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
