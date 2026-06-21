"use client";

import { useEffect } from "react";
import { formatDate } from "@/lib/format";
import type { ItemStatus, ItemWithSource } from "@/lib/types";
import PriorityPill from "./PriorityPill";

const KIND_LABEL: Record<string, string> = {
  task: "Task",
  recommendation: "Recommendation",
  next_step: "Next step",
  learning: "Learning",
};

const STATUS_OPTIONS: { value: ItemStatus; label: string }[] = [
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
];

export default function ItemDetail({
  item,
  onClose,
  onSetStatus,
  onConfirm,
  onDismissSuggestion,
  onPriorityChange,
}: {
  item: ItemWithSource | null;
  onClose: () => void;
  onSetStatus: (id: number, status: ItemStatus) => void;
  onConfirm: (id: number) => void;
  onDismissSuggestion: (id: number) => void;
  onPriorityChange: (id: number, rank: number) => void;
}) {
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;

  const isTask = item.kind === "task";

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-black/10 bg-white p-5 shadow-xl dark:border-white/10 dark:bg-zinc-900"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="rounded bg-black/10 px-1.5 py-0.5 dark:bg-white/10">
              {KIND_LABEL[item.kind] ?? item.kind}
            </span>
            {isTask && (
              <PriorityPill
                itemId={item.id}
                rank={item.priority}
                onChanged={(r) => onPriorityChange(item.id, r)}
              />
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 text-zinc-400 hover:bg-black/5 hover:text-zinc-700 dark:hover:bg-white/10"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <h2 className="mt-3 text-lg font-semibold leading-snug">{item.title}</h2>

        {item.detail && (
          <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">
            {item.detail}
          </p>
        )}

        {item.suggested_done === 1 && item.status !== "done" && (
          <div className="mt-3 rounded-md bg-amber-100 p-3 dark:bg-amber-500/15">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Looks done?</p>
            {item.done_evidence && (
              <p className="mt-1 text-xs italic text-amber-700/80 dark:text-amber-300/70">
                “{item.done_evidence}”
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => onConfirm(item.id)}
                className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
              >
                ✓ Mark done
              </button>
              <button
                onClick={() => onDismissSuggestion(item.id)}
                className="rounded bg-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200"
              >
                Not yet
              </button>
            </div>
          </div>
        )}

        {/* Source */}
        <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">Source</p>
          {item.conversation_title ? (
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              {item.conversation_title}
              {item.conversation_at ? ` · ${formatDate(item.conversation_at)}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-sm text-zinc-500">Added via /sync-board</p>
          )}
          {item.source_quote && (
            <p className="mt-1.5 border-l-2 border-zinc-300 pl-2 text-xs italic text-zinc-500 dark:border-zinc-600">
              “{item.source_quote}”
            </p>
          )}
          <p className="mt-2 text-[11px] text-zinc-400">
            Captured {formatDate(item.created_at)}
          </p>
        </div>

        {/* Actions */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {isTask ? (
            STATUS_OPTIONS.map((s) => (
              <button
                key={s.value}
                onClick={() => onSetStatus(item.id, s.value)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                  item.status === s.value
                    ? "bg-indigo-600 text-white"
                    : "bg-black/10 text-zinc-700 hover:bg-black/20 dark:bg-white/10 dark:text-zinc-200"
                }`}
              >
                {s.label}
              </button>
            ))
          ) : (
            <button
              onClick={() => onSetStatus(item.id, item.status === "done" ? "todo" : "done")}
              className="rounded-lg bg-black/10 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-black/20 dark:bg-white/10 dark:text-zinc-200"
            >
              {item.status === "done" ? "Reopen" : "Mark done"}
            </button>
          )}
          <button
            onClick={() => {
              onSetStatus(item.id, "dismissed");
              onClose();
            }}
            className="ml-auto rounded-lg px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
