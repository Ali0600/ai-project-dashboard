import { NextResponse } from "next/server";
import { ClaudeUnavailableError, researchFeatures } from "@/lib/claude";
import { ingestResearch } from "@/lib/ingest";
import { deriveResearchTopic, getProject, openItemTitles } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300; // web search + synthesis can take a while

/**
 * POST /api/projects/:id/research — research the web for requested features and ingest them as
 * `research` items, streaming newline-delimited JSON progress: `{phase:"searching"}`,
 * `{phase:"ingesting"}`, then a terminal `{phase:"result", created, createdIds}` / `{phase:"error"}`.
 * Body: `{ topic?: string }` — falls back to a derived topic when omitted.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number(id);
  const project = Number.isFinite(projectId) ? getProject(projectId) : undefined;
  if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { topic?: string };
  const topic = (body.topic || "").trim() || deriveResearchTopic(projectId);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      // Best-effort progress: a client disconnect must not abort the run before its ingest lands
      // (see the scan route — same guard, same reason).
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true;
        }
      };
      try {
        send({ phase: "searching" });
        const ideas = await researchFeatures({ topic, existingTitles: openItemTitles(projectId) });
        send({ phase: "ingesting" });
        const res = ingestResearch({ projectId, ideas });
        send({ phase: "result", ...res });
      } catch (e) {
        const error = e instanceof ClaudeUnavailableError ? e.message : (e as Error).message;
        console.error(`[research] project ${projectId} failed:`, e);
        send({ phase: "error", error });
      } finally {
        try {
          if (!closed) controller.close();
        } catch {
          /* already closed by the client disconnecting */
        }
      }
    },
    cancel() {
      // Client went away; the run continues so its ingest still lands.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
