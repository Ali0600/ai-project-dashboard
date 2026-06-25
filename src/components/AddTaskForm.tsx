"use client";

import { useState } from "react";
import { PRIORITIES, PRIORITY_META, PRIORITY_RANK, type Priority } from "@/lib/priority";
import type { ItemWithSource } from "@/lib/types";

export default function AddTaskForm({
  projectId,
  onCreated,
  onCancel,
}: {
  projectId: number;
  onCreated: (item: ItemWithSource) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, title: t, detail: detail.trim(), priority, kind: "task" }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Could not create task");
        setBusy(false);
        return;
      }
      const now = new Date().toISOString();
      onCreated({
        id: json.id,
        project_id: projectId,
        conversation_id: null,
        kind: "task",
        title: t,
        detail: detail.trim(),
        status: "todo",
        priority: PRIORITY_RANK[priority],
        suggested_done: 0,
        done_evidence: null,
        source_uuid: null,
        source_quote: null,
        source_url: null,
        implementation_plan: null,
        apply_branch: null,
        apply_diff: null,
        norm_key: "",
        created_at: now,
        updated_at: now,
        conversation_title: null,
        conversation_at: null,
      });
    } catch {
      setError("Could not create task");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mb-4 rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-900"
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-white/10"
      />
      <textarea
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder="Details (optional)"
        rows={2}
        className="mt-2 w-full resize-y rounded-lg border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-white/10"
      />
      <div className="mt-2 flex items-center gap-2">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
          title="Priority"
          className="rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-sm outline-none dark:border-white/10"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_META[p].label}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {busy ? "Adding…" : "Add task"}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </form>
  );
}
