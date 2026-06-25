"use client";

import { useEffect, useState } from "react";
import { formatDate } from "@/lib/format";
import type { ItemStatus, ItemWithSource } from "@/lib/types";
import CopyButton from "./CopyButton";
import type { ApplyOutcome } from "./ProjectDashboard";
import PriorityPill from "./PriorityPill";

const KIND_LABEL: Record<string, string> = {
  task: "Task",
  suggestion: "Suggestion",
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
  onImplement,
  onApply,
  onPromote,
}: {
  item: ItemWithSource | null;
  onClose: () => void;
  onSetStatus: (id: number, status: ItemStatus) => void;
  onConfirm: (id: number) => void;
  onDismissSuggestion: (id: number) => void;
  onPriorityChange: (id: number, rank: number) => void;
  onImplement: (id: number) => Promise<void>;
  onApply: (id: number) => Promise<ApplyOutcome>;
  onPromote: (id: number) => void;
}) {
  const [implBusy, setImplBusy] = useState(false);
  const [implError, setImplError] = useState<string | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyNote, setApplyNote] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;

  const isTask = item.kind === "task";

  async function runImplement() {
    setImplBusy(true);
    setImplError(null);
    try {
      await onImplement(item!.id);
    } catch (e) {
      setImplError((e as Error).message);
    } finally {
      setImplBusy(false);
    }
  }

  async function runApply() {
    if (
      !window.confirm(
        "Let Claude edit files to implement this task? It runs in an isolated git worktree on a new " +
          "branch — your working copy is untouched and nothing is pushed. You review and push the branch yourself.",
      )
    )
      return;
    setApplyBusy(true);
    setApplyError(null);
    setApplyNote(null);
    try {
      const r = await onApply(item!.id);
      setApplyNote(
        r.changedFiles > 0
          ? `Created branch ${r.branch} with ${r.changedFiles} changed file${r.changedFiles > 1 ? "s" : ""}.${
              r.worktreeDir ? ` (Uncommitted — see worktree ${r.worktreeDir})` : ""
            }`
          : "Claude made no file changes.",
      );
    } catch (e) {
      setApplyError((e as Error).message);
    } finally {
      setApplyBusy(false);
    }
  }

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

        <div className="mt-3 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold leading-snug">{item.title}</h2>
          <CopyButton
            text={item.detail ? `${item.title}\n\n${item.detail}` : item.title}
            label="Copy"
            className="mt-0.5 shrink-0"
          />
        </div>

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

        {/* Implementation plan (tasks only) */}
        {isTask && (
          <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Implementation plan
              </p>
              <div className="flex items-center gap-2">
                {item.implementation_plan && (
                  <CopyButton text={item.implementation_plan} label="Copy plan" />
                )}
                <button
                  onClick={runImplement}
                  disabled={implBusy}
                  title="Resume the source conversation and draft a plan (read-only — applies nothing)"
                  className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                >
                  {implBusy ? "Drafting…" : item.implementation_plan ? "Re-draft" : "▶ Implement"}
                </button>
              </div>
            </div>
            {implBusy && (
              <p className="mt-2 text-xs text-zinc-500">
                Resuming the source conversation and drafting a plan… this can take a minute.
              </p>
            )}
            {implError && (
              <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{implError}</p>
            )}
            {item.implementation_plan && (
              <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-black/5 p-3 text-xs leading-relaxed text-zinc-700 dark:bg-white/5 dark:text-zinc-300">
                {item.implementation_plan}
              </pre>
            )}
          </div>
        )}

        {/* Apply on a branch (tasks only) — edits enabled, isolated worktree, nothing pushed */}
        {isTask && (
          <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Apply on a branch
              </p>
              <button
                onClick={runApply}
                disabled={applyBusy}
                title="Let Claude implement this in an isolated git worktree on a new branch (nothing is pushed)"
                className="rounded-lg border border-indigo-300 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60 dark:border-indigo-500/30 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
              >
                {applyBusy ? "Applying…" : item.apply_branch ? "Re-apply" : "⎇ Apply on a branch"}
              </button>
            </div>
            {applyBusy && (
              <p className="mt-2 text-xs text-zinc-500">
                Editing files on a new branch in an isolated worktree… this can take a few minutes.
              </p>
            )}
            {applyError && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{applyError}</p>}
            {applyNote && <p className="mt-2 text-xs text-zinc-500">{applyNote}</p>}
            {item.apply_branch && (
              <p className="mt-2 text-xs text-zinc-500">
                Branch{" "}
                <code className="rounded bg-black/10 px-1 py-0.5 dark:bg-white/10">
                  {item.apply_branch}
                </code>{" "}
                — review and push it yourself.
              </p>
            )}
            {item.apply_diff && (
              <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre rounded-md bg-black/5 p-3 text-[11px] leading-relaxed text-zinc-700 dark:bg-white/5 dark:text-zinc-300">
                {item.apply_diff}
              </pre>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {item.kind === "suggestion" && (
            <button
              onClick={() => {
                onPromote(item.id);
                onClose();
              }}
              title="Move this suggestion onto the Board as a task"
              className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
            >
              ▶ Promote to task
            </button>
          )}
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
