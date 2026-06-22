"use client";

import type { ItemStatus, ItemWithSource } from "@/lib/types";
import SourceLine from "./SourceLine";

/** Generic list for suggestions / learnings. */
export default function ItemList({
  items,
  emptyLabel,
  recentlyAdded,
  onSetStatus,
  onOpenDetail,
  onPromote,
}: {
  items: ItemWithSource[];
  emptyLabel: string;
  recentlyAdded: Set<number>;
  onSetStatus: (id: number, status: ItemStatus) => void;
  onOpenDetail: (id: number) => void;
  onPromote?: (id: number) => void;
}) {
  const visible = items.filter((i) => i.status !== "dismissed");

  if (visible.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-black/15 p-8 text-center text-sm text-zinc-500 dark:border-white/15">
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {visible.map((item) => {
        const done = item.status === "done";
        const isNew = recentlyAdded.has(item.id);
        return (
          <li
            key={item.id}
            onClick={() => onOpenDetail(item.id)}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border bg-white p-3 dark:bg-zinc-800 ${
              isNew
                ? "border-emerald-400 ring-1 ring-emerald-400/40 dark:border-emerald-500"
                : "border-black/10 dark:border-white/10"
            }`}
          >
            <button
              title={done ? "Mark as not done" : "Mark as done"}
              onClick={(e) => {
                e.stopPropagation();
                onSetStatus(item.id, done ? "todo" : "done");
              }}
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                done
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-zinc-400 text-transparent hover:border-emerald-600"
              }`}
            >
              ✓
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p
                  className={`text-sm font-medium leading-snug ${
                    done ? "text-zinc-400 line-through dark:text-zinc-500" : ""
                  }`}
                >
                  {item.title}
                </p>
                {isNew && (
                  <span className="shrink-0 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                    New
                  </span>
                )}
              </div>
              {item.detail && (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{item.detail}</p>
              )}
              <SourceLine item={item} />
            </div>
            {item.kind === "suggestion" && onPromote && (
              <button
                title="Promote to a Board task"
                onClick={(e) => {
                  e.stopPropagation();
                  onPromote(item.id);
                }}
                className="shrink-0 rounded-lg border border-indigo-300 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500/40 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
              >
                → Task
              </button>
            )}
            <button
              title="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                onSetStatus(item.id, "dismissed");
              }}
              className="shrink-0 rounded px-1.5 text-zinc-400 hover:bg-black/5 hover:text-zinc-600 dark:hover:bg-white/10"
            >
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}
