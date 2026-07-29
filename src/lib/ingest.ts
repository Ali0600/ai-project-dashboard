import { getDb } from "./db";
import {
  collapseDuplicateTasks,
  dismissSuggestionsCollidingWithTasks,
  flagSuggestedDone,
  insertItem,
  normalizeTitle,
  recordFailureOccurrence,
} from "./store";
import type { ExtractionResult, ResearchIdea } from "./types";

export interface IngestResult {
  created: number;
  flaggedDone: number;
  /** Known failures reported again by this scan (recurrence counts bumped). */
  recurred: number;
  createdIds: number[];
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
    const createdIds: number[] = [];
    const add = (id: number | null) => {
      if (id != null) createdIds.push(id);
    };

    for (const t of extraction.tasks) {
      add(
        insertItem({
          projectId,
          conversationId,
          kind: "task",
          title: t.title,
          detail: t.detail,
          status: t.status_guess,
          priority: t.priority,
          sourceQuote: t.source_quote,
        }),
      );
    }
    // Collapse reworded duplicate tasks (keeps one canonical, prefers done) so pre-dedup dups heal.
    collapseDuplicateTasks(projectId);
    // Retire any pre-existing suggestion that a task (including ones just added) now covers.
    dismissSuggestionsCollidingWithTasks(projectId);

    for (const it of extraction.suggestions) {
      add(
        insertItem({
          projectId,
          conversationId,
          kind: "suggestion",
          title: it.title,
          detail: it.detail,
          sourceQuote: it.source_quote,
        }),
      );
    }

    // Failures: a NEW failure becomes a row; a KNOWN one bumps its recurrence count instead.
    // Collapse repeats within this one extraction first — chunk boundaries are arbitrary, so a
    // single incident narrated in two chunks must count as one occurrence, not two.
    let recurred = 0;
    const seenThisScan = new Set<string>();
    for (const f of extraction.failures) {
      const key = normalizeTitle(f.title);
      if (seenThisScan.has(key)) continue;
      seenThisScan.add(key);
      const id = insertItem({
        projectId,
        conversationId,
        kind: "failure",
        title: f.title,
        detail: f.detail,
        sourceQuote: f.source_quote,
      });
      if (id != null) add(id);
      // insertItem stays pure (null = duplicate); the recurrence bookkeeping lives here, where it
      // can also reopen a failure that was marked done and leave dismissed tombstones alone.
      else if (recordFailureOccurrence(projectId, f.title, f.source_quote) !== "ignored") recurred++;
    }

    let flaggedDone = 0;
    for (const c of extraction.completed) {
      if (flagSuggestedDone(projectId, c.existing_id_or_title, c.evidence_quote)) flaggedDone++;
    }

    return { created: createdIds.length, flaggedDone, recurred, createdIds };
  })();
}

/**
 * Write web-research ideas into the DB as `research` items (separate from the conversation
 * extraction path). Dedup + tombstoning are enforced by insertItem. Returns created ids.
 */
export function ingestResearch(opts: {
  projectId: number;
  ideas: ResearchIdea[];
}): { created: number; createdIds: number[] } {
  const { projectId, ideas } = opts;
  return getDb().transaction((): { created: number; createdIds: number[] } => {
    const createdIds: number[] = [];
    for (const idea of ideas) {
      const id = insertItem({
        projectId,
        kind: "research",
        title: idea.title,
        detail: idea.detail,
        sourceQuote: idea.source_quote,
        sourceUrl: idea.source_url || undefined,
      });
      if (id != null) createdIds.push(id);
    }
    return { created: createdIds.length, createdIds };
  })();
}
