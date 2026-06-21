import { getDb } from "./db";
import { flagSuggestedDone, insertItem } from "./store";
import type { ExtractionResult } from "./types";

export interface IngestResult {
  created: number;
  flaggedDone: number;
}

/**
 * Write an extraction result into the DB for one project/conversation.
 * Wrapped in a transaction. De-duplication and tombstoning are enforced by the
 * UNIQUE(project_id, kind, norm_key) constraint inside insertItem().
 */
export function ingestExtraction(opts: {
  projectId: number;
  conversationId?: number | null;
  extraction: ExtractionResult;
}): IngestResult {
  const { projectId, conversationId = null, extraction } = opts;

  return getDb().transaction((): IngestResult => {
    let created = 0;

    for (const t of extraction.tasks) {
      if (
        insertItem({
          projectId,
          conversationId,
          kind: "task",
          title: t.title,
          detail: t.detail,
          status: t.status_guess,
          priority: t.priority,
          sourceQuote: t.source_quote,
        })
      )
        created++;
    }

    const simple = [
      ["recommendation", extraction.recommendations],
      ["next_step", extraction.next_steps],
      ["learning", extraction.learnings],
    ] as const;
    for (const [kind, arr] of simple) {
      for (const it of arr) {
        if (
          insertItem({
            projectId,
            conversationId,
            kind,
            title: it.title,
            detail: it.detail,
            sourceQuote: it.source_quote,
          })
        )
          created++;
      }
    }

    let flaggedDone = 0;
    for (const c of extraction.completed) {
      if (flagSuggestedDone(projectId, c.existing_id_or_title, c.evidence_quote)) flaggedDone++;
    }

    return { created, flaggedDone };
  })();
}
