"use client";

import { useState } from "react";
import ItemDetail from "./ItemDetail";
import ItemList from "./ItemList";
import KanbanBoard from "./KanbanBoard";
import type { ItemKind, ItemStatus, ItemWithSource } from "@/lib/types";

const TABS: { key: ItemKind; label: string; empty: string }[] = [
  { key: "task", label: "Board", empty: "" },
  { key: "recommendation", label: "Recommendations", empty: "No recommendations captured yet." },
  { key: "next_step", label: "Next Steps", empty: "No next steps captured yet." },
  { key: "learning", label: "Learnings", empty: "No learnings captured yet." },
];

const KIND_NOUN: Record<ItemKind, string> = {
  task: "task",
  recommendation: "recommendation",
  next_step: "next step",
  learning: "learning",
};

async function patch(id: number, body: Record<string, unknown>) {
  await fetch(`/api/items/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export default function ProjectDashboard({
  initialItems,
  projectId,
  conversationIds,
  pendingConversationIds,
}: {
  initialItems: ItemWithSource[];
  projectId: number;
  conversationIds: number[];
  pendingConversationIds: number[];
}) {
  const [items, setItems] = useState<ItemWithSource[]>(initialItems);
  const [active, setActive] = useState<ItemKind>("task");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [recentlyAdded, setRecentlyAdded] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<number[]>(pendingConversationIds);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  /* --- mutations: optimistic local update + persist --- */
  function update(id: number, local: Partial<ItemWithSource>, body: Record<string, unknown>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...local } : i)));
    patch(id, body);
  }
  const moveTask = (id: number, status: ItemStatus) =>
    update(id, { status, suggested_done: 0 }, { status });
  const setStatus = (id: number, status: ItemStatus) => update(id, { status }, { status });
  const confirmDone = (id: number) =>
    update(id, { status: "done", suggested_done: 0 }, { suggestion: "confirm" });
  const dismissSuggestion = (id: number) =>
    update(id, { suggested_done: 0 }, { suggestion: "dismiss" });
  // PriorityPill issues its own PATCH; we just update state so the column re-sorts.
  const setPriority = (id: number, rank: number) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, priority: rank } : i)));

  async function refetch(): Promise<ItemWithSource[]> {
    const res = await fetch(`/api/projects/${projectId}/items`);
    const data: ItemWithSource[] = res.ok ? await res.json() : items;
    setItems(data);
    return data;
  }

  async function runScan(ids: number[]) {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setSummary(null);
    const newIds: number[] = [];
    let flagged = 0;
    let error = "";
    for (let i = 0; i < ids.length; i++) {
      setSummary(`Scanning ${i + 1}/${ids.length}…`);
      try {
        const res = await fetch(`/api/conversations/${ids[i]}/scan`, { method: "POST" });
        const json = await res.json();
        if (!res.ok) error = json.error || "scan failed";
        else {
          if (Array.isArray(json.createdIds)) newIds.push(...json.createdIds);
          flagged += json.flaggedDone ?? 0;
        }
      } catch {
        error = "scan request failed";
      }
    }
    const fresh = await refetch();
    setRecentlyAdded(new Set(newIds));
    setPending([]);
    setBusy(false);
    setSummary(error ? `Scan error: ${error}` : buildSummary(fresh, newIds, flagged));
  }

  function buildSummary(list: ItemWithSource[], newIds: number[], flagged: number): string {
    const ids = new Set(newIds);
    const counts: Partial<Record<ItemKind, number>> = {};
    for (const it of list) if (ids.has(it.id)) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
    const parts = (Object.entries(counts) as [ItemKind, number][]).map(
      ([k, n]) => `+${n} ${KIND_NOUN[k]}${n > 1 ? "s" : ""}`,
    );
    let s = parts.length ? `Scan complete — ${parts.join(", ")}` : "Scan complete — no new items";
    if (flagged > 0) s += ` · ${flagged} task${flagged > 1 ? "s" : ""} look done`;
    return s;
  }

  const byKind = (kind: ItemKind) =>
    items.filter((i) => i.kind === kind && i.status !== "dismissed");
  const isError = summary?.startsWith("Scan error");
  const selected = selectedId != null ? items.find((i) => i.id === selectedId) ?? null : null;

  return (
    <div>
      {/* Toolbar: scan control */}
      {(conversationIds.length > 0 || (summary && !busy)) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-zinc-500">
            {pending.length > 0
              ? `${pending.length} conversation${pending.length > 1 ? "s" : ""} need scanning`
              : "All conversations scanned"}
          </div>
          {conversationIds.length > 0 && (
            <button
              onClick={() => runScan(pending.length > 0 ? pending : conversationIds)}
              disabled={busy}
              title={
                pending.length > 0
                  ? "Extract items from conversations with new activity"
                  : "Re-scan all conversations for any new items"
              }
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {busy
                ? summary || "Scanning…"
                : pending.length > 0
                  ? `Scan ${pending.length} pending`
                  : "Rescan"}
            </button>
          )}
        </div>
      )}

      {/* Post-scan summary banner */}
      {summary && !busy && (
        <div
          className={`mb-4 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${
            isError
              ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300"
              : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
          }`}
        >
          <span>
            {isError ? "⚠️ " : "✅ "}
            {summary}
          </span>
          <button
            onClick={() => setSummary(null)}
            className="shrink-0 rounded px-1.5 hover:bg-black/5 dark:hover:bg-white/10"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Tabs */}
      <nav className="mb-5 flex flex-wrap gap-1 border-b border-black/10 dark:border-white/10">
        {TABS.map((tab) => {
          const selectedTab = active === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActive(tab.key)}
              className={`relative -mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                selectedTab
                  ? "border-indigo-600 text-indigo-600 dark:text-indigo-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {tab.label}
              <span className="ml-1.5 rounded-full bg-black/10 px-1.5 text-xs dark:bg-white/10">
                {byKind(tab.key).length}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Content */}
      {active === "task" ? (
        <KanbanBoard
          tasks={items.filter((i) => i.kind === "task")}
          recentlyAdded={recentlyAdded}
          onMove={moveTask}
          onConfirm={confirmDone}
          onDismissSuggestion={dismissSuggestion}
          onPriorityChange={setPriority}
          onOpenDetail={setSelectedId}
        />
      ) : (
        <ItemList
          items={items.filter((i) => i.kind === active)}
          emptyLabel={TABS.find((t) => t.key === active)!.empty}
          recentlyAdded={recentlyAdded}
          onSetStatus={setStatus}
          onOpenDetail={setSelectedId}
        />
      )}

      <ItemDetail
        item={selected}
        onClose={() => setSelectedId(null)}
        onSetStatus={setStatus}
        onConfirm={confirmDone}
        onDismissSuggestion={dismissSuggestion}
        onPriorityChange={setPriority}
      />
    </div>
  );
}
