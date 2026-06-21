"use client";

import {
  PRIORITIES,
  PRIORITY_META,
  PRIORITY_RANK,
  priorityFromRank,
  type Priority,
} from "@/lib/priority";

/** Color-coded priority selector. Used on cards and list items. */
export default function PriorityPill({
  itemId,
  rank,
  onChanged,
}: {
  itemId: number;
  rank: number;
  onChanged?: (rank: number) => void;
}) {
  const current = priorityFromRank(rank);
  const meta = PRIORITY_META[current];

  async function change(p: Priority) {
    if (p === current) return;
    onChanged?.(PRIORITY_RANK[p]); // optimistic
    await fetch(`/api/items/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: p }),
    });
  }

  return (
    <select
      value={current}
      title="Priority"
      // stop drag/click handlers on parent cards from firing
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => change(e.target.value as Priority)}
      className={`shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-semibold outline-none ${meta.className}`}
    >
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {PRIORITY_META[p].label}
        </option>
      ))}
    </select>
  );
}
