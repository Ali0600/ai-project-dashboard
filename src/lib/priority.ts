/**
 * Task priority constants — deliberately free of any server-only / zod imports so client
 * components can use them without bloating the browser bundle. Stored in the DB as an
 * integer rank (1 = highest). Re-exported from types.ts for server-side convenience.
 */
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

const RANK_TO_PRIORITY: Record<number, Priority> = { 1: "urgent", 2: "high", 3: "medium", 4: "low" };

export function priorityFromRank(rank: number): Priority {
  return RANK_TO_PRIORITY[rank] ?? "medium";
}

/** Label + Tailwind classes for rendering each priority. */
export const PRIORITY_META: Record<Priority, { label: string; className: string }> = {
  urgent: {
    label: "Urgent",
    className: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  },
  high: {
    label: "High",
    className: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  },
  medium: {
    label: "Medium",
    className: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  },
  low: {
    label: "Low",
    className: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
  },
};
