import { z } from "zod";

/** The four kinds of things we pull out of a conversation. */
export const ITEM_KINDS = ["task", "recommendation", "next_step", "learning"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_STATUSES = ["todo", "in_progress", "done", "dismissed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

// Priority constants live in ./priority (zod-free) so client components can import them
// without pulling zod into the browser bundle. Re-exported here for server-side convenience.
import { PRIORITIES } from "./priority";
export { PRIORITIES, PRIORITY_RANK, priorityFromRank } from "./priority";
export type { Priority } from "./priority";

/* ----------------------------------------------------------------------------
 * Extraction contract — the JSON shape Claude (live or headless) must return.
 * Validated with zod so a malformed model response fails loudly instead of
 * silently writing garbage to the DB.
 * ------------------------------------------------------------------------- */

const Task = z.object({
  title: z.string().min(1),
  detail: z.string().optional().default(""),
  status_guess: z.enum(["todo", "in_progress", "done"]).optional().default("todo"),
  priority: z.enum(PRIORITIES).optional().default("medium"),
  source_quote: z.string().optional().default(""),
});

const SimpleItem = z.object({
  title: z.string().min(1),
  detail: z.string().optional().default(""),
  source_quote: z.string().optional().default(""),
});

const Completed = z.object({
  existing_id_or_title: z.union([z.string(), z.number()]).transform(String),
  evidence_quote: z.string().optional().default(""),
});

export const ExtractionResult = z.object({
  tasks: z.array(Task).optional().default([]),
  recommendations: z.array(SimpleItem).optional().default([]),
  next_steps: z.array(SimpleItem).optional().default([]),
  learnings: z.array(SimpleItem).optional().default([]),
  completed: z.array(Completed).optional().default([]),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

/* ----------------------------------------------------------------------------
 * Row shapes (as stored in SQLite).
 * ------------------------------------------------------------------------- */

export interface ProjectRow {
  id: number;
  cwd: string;
  name: string;
  created_at: string;
}

export interface ConversationRow {
  id: number;
  session_id: string;
  project_id: number;
  title: string | null;
  slug: string | null;
  transcript_path: string;
  last_scanned_uuid: string | null;
  scan_status: "needs_scan" | "scanned";
  started_at: string | null;
  last_activity_at: string | null;
  last_scanned_at: string | null;
}

export interface ItemRow {
  id: number;
  project_id: number;
  conversation_id: number | null;
  kind: ItemKind;
  title: string;
  detail: string | null;
  status: ItemStatus;
  priority: number;
  suggested_done: 0 | 1;
  done_evidence: string | null;
  source_uuid: string | null;
  source_quote: string | null;
  norm_key: string;
  created_at: string;
  updated_at: string;
}

/** An item joined with its source conversation (title + when), for the UI. */
export interface ItemWithSource extends ItemRow {
  conversation_title: string | null;
  conversation_at: string | null;
}
