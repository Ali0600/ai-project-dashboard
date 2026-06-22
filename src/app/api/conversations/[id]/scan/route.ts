import { NextResponse } from "next/server";
import { ClaudeUnavailableError } from "@/lib/claude";
import { scanTranscript } from "@/lib/scan";
import { getConversation } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300; // headless extraction can take a while

/**
 * POST /api/conversations/:id/scan — run headless extraction for one conversation, streaming
 * newline-delimited JSON progress events as it goes: `{phase:"reading"}`,
 * `{phase:"extracting",index,total,detail?}`, `{phase:"ingesting"}`, then a terminal
 * `{phase:"result",...ScanResult}` or `{phase:"error",error}`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conv = getConversation(Number(id));
  if (!conv) return NextResponse.json({ error: "conversation not found" }, { status: 404 });

  // `{ full: true }` re-reads the whole transcript (ignores the checkpoint) so completions that
  // happened in already-scanned content can be reconciled against the current open items.
  const body = (await req.json().catch(() => ({}))) as { full?: boolean };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await scanTranscript(conv.transcript_path, {
          incremental: !body.full,
          onProgress: send,
        });
        send({ phase: "result", ...result });
      } catch (e) {
        // Errors travel in-stream (HTTP status is already 200 once streaming starts).
        const error = e instanceof ClaudeUnavailableError ? e.message : (e as Error).message;
        send({ phase: "error", error });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
