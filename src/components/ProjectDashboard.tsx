"use client";

import { useEffect, useState } from "react";
import AddTaskForm from "./AddTaskForm";
import ItemDetail from "./ItemDetail";
import ItemList from "./ItemList";
import KanbanBoard from "./KanbanBoard";
import type { ItemKind, ItemStatus, ItemWithSource } from "@/lib/types";

const TABS: { key: ItemKind; label: string; empty: string }[] = [
  { key: "task", label: "Board", empty: "" },
  { key: "suggestion", label: "Suggestions", empty: "No suggestions captured yet." },
  { key: "learning", label: "Learnings", empty: "No learnings captured yet." },
  { key: "research", label: "Research", empty: 'No research yet — click "Use Internet for Research".' },
];

const KIND_NOUN: Record<ItemKind, string> = {
  task: "task",
  suggestion: "suggestion",
  learning: "learning",
  research: "idea",
};

/** Result of an "apply on a branch" run, surfaced in the detail modal. */
export type ApplyOutcome = { branch: string; changedFiles: number; worktreeDir: string | null };

/** Current live scan step shown in the progress panel. */
type ScanStep = {
  convIndex: number;
  convTotal: number;
  label: string;
  stepStart: number; // ms timestamp when this step began (for the elapsed timer)
};

/** Turn a streamed progress event into a human label. */
function progressLabel(ev: { phase: string; index?: number; total?: number; detail?: string }): string {
  switch (ev.phase) {
    case "reading":
      return "Reading transcript…";
    case "extracting":
      return ev.detail
        ? `Reading ${ev.detail} ${ev.index}/${ev.total}…`
        : `Extracting ${ev.index}/${ev.total}…`;
    case "searching":
      return "Searching the web…";
    case "ingesting":
      return "Saving…";
    default:
      return "Working…";
  }
}

/** Read a fetch Response body as newline-delimited JSON, invoking `onEvent` per parsed line. */
async function streamNdjson(res: Response, onEvent: (ev: Record<string, unknown>) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* ignore non-JSON lines */
      }
    }
  }
}

async function patch(id: number, body: Record<string, unknown>) {
  await fetch(`/api/items/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export default function ProjectDashboard({
  initialItems = [],
  projectId,
  conversationIds = [],
  pendingConversationIds = [],
  derivedTopic = "",
}: {
  initialItems?: ItemWithSource[];
  projectId: number;
  conversationIds?: number[];
  pendingConversationIds?: number[];
  derivedTopic?: string;
}) {
  const [items, setItems] = useState<ItemWithSource[]>(initialItems);
  const [active, setActive] = useState<ItemKind>("task");
  const [query, setQuery] = useState("");
  // Web-research ("Use Internet for Research")
  const [showResearch, setShowResearch] = useState(false);
  const [researchBusy, setResearchBusy] = useState(false);
  const [topic, setTopic] = useState(derivedTopic);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [recentlyAdded, setRecentlyAdded] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState<number[]>(pendingConversationIds);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  // Live scan progress (streamed from the server); `now` ticks so the step timer updates.
  const [scan, setScan] = useState<ScanStep | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!scan) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [scan]);

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

  // Promote a suggestion to a Board task. Optimistically move it, persist, then refetch so the
  // rare "merged" case (a duplicate task already existed → suggestion dismissed) self-corrects.
  async function promote(id: number) {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, kind: "task", status: "todo" } : i)),
    );
    await patch(id, { promote: true });
    await refetch();
  }

  // Draft an implementation plan (read-only headless run); persists + shows in the modal.
  async function implement(id: number): Promise<void> {
    const res = await fetch(`/api/items/${id}/implement`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Implement failed");
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, implementation_plan: json.plan } : i)),
    );
  }

  // Apply the plan on an isolated git branch (edits enabled, nothing pushed); persists branch + diff.
  async function apply(id: number): Promise<ApplyOutcome> {
    const res = await fetch(`/api/items/${id}/apply`, { method: "POST" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Apply failed");
    const branch: string | null = json.changedFiles > 0 ? json.branch : null;
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, apply_branch: branch, apply_diff: json.diff || null } : i)),
    );
    return { branch: json.branch, changedFiles: json.changedFiles, worktreeDir: json.worktreeDir };
  }

  function handleCreated(item: ItemWithSource) {
    setItems((prev) => [item, ...prev]);
    setRecentlyAdded((prev) => new Set(prev).add(item.id));
    setShowAddForm(false);
  }

  async function refetch(): Promise<ItemWithSource[]> {
    const res = await fetch(`/api/projects/${projectId}/items`);
    const data: ItemWithSource[] = res.ok ? await res.json() : items;
    setItems(data);
    return data;
  }

  async function runScan(ids: number[], opts: { full?: boolean } = {}) {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setSummary(null);
    const newIds: number[] = [];
    let flagged = 0;
    let error = "";

    // Advance the live step; reset the timer only when the label/conversation actually changes.
    const step = (convIndex: number, label: string) =>
      setScan((prev) => ({
        convIndex,
        convTotal: ids.length,
        label,
        stepStart:
          prev && prev.label === label && prev.convIndex === convIndex ? prev.stepStart : Date.now(),
      }));

    for (let i = 0; i < ids.length; i++) {
      step(i + 1, "Starting…");
      try {
        const res = await fetch(`/api/conversations/${ids[i]}/scan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ full: opts.full ?? false }),
        });
        const ctype = res.headers.get("content-type") || "";
        if (!res.body || !ctype.includes("ndjson")) {
          // Non-streaming fallback (e.g. a 404 JSON error).
          const json = await res.json().catch(() => ({}));
          if (!res.ok) error = json.error || "scan failed";
          continue;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: {
              phase: string;
              index?: number;
              total?: number;
              detail?: string;
              error?: string;
              createdIds?: number[];
              flaggedDone?: number;
            };
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.phase === "result") {
              if (Array.isArray(ev.createdIds)) newIds.push(...ev.createdIds);
              flagged += ev.flaggedDone ?? 0;
            } else if (ev.phase === "error") {
              error = ev.error || "scan failed";
            } else {
              step(i + 1, progressLabel(ev));
            }
          }
        }
      } catch {
        error = "scan request failed";
      }
    }

    const fresh = await refetch();
    setRecentlyAdded(new Set(newIds));
    setPending([]);
    setScan(null);
    setBusy(false);
    setSummary(error ? `Scan error: ${error}` : buildSummary(fresh, newIds, flagged));
  }

  function buildSummary(
    list: ItemWithSource[],
    newIds: number[],
    flagged: number,
    label = "Scan",
  ): string {
    const ids = new Set(newIds);
    const counts: Partial<Record<ItemKind, number>> = {};
    for (const it of list) if (ids.has(it.id)) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
    const parts = (Object.entries(counts) as [ItemKind, number][]).map(
      ([k, n]) => `+${n} ${KIND_NOUN[k]}${n > 1 ? "s" : ""}`,
    );
    let s = parts.length ? `${label} complete — ${parts.join(", ")}` : `${label} complete — no new items`;
    if (flagged > 0) s += ` · ${flagged} task${flagged > 1 ? "s" : ""} look done`;
    return s;
  }

  // Research the web for requested features; ingest as `research` items, streaming live progress.
  async function runResearch() {
    if (busy || researchBusy) return;
    setResearchBusy(true);
    setSummary(null);
    setScan({ convIndex: 1, convTotal: 1, label: "Searching the web…", stepStart: Date.now() });
    const newIds: number[] = [];
    let error = "";
    try {
      const res = await fetch(`/api/projects/${projectId}/research`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const ctype = res.headers.get("content-type") || "";
      if (!res.body || !ctype.includes("ndjson")) {
        const json = await res.json().catch(() => ({}));
        error = json.error || "research failed";
      } else {
        await streamNdjson(res, (ev) => {
          if (ev.phase === "result") {
            if (Array.isArray(ev.createdIds)) newIds.push(...(ev.createdIds as number[]));
          } else if (ev.phase === "error") {
            error = (ev.error as string) || "research failed";
          } else {
            const label = progressLabel(ev as { phase: string });
            setScan((prev) => ({
              convIndex: 1,
              convTotal: 1,
              label,
              stepStart: prev && prev.label === label ? prev.stepStart : Date.now(),
            }));
          }
        });
      }
    } catch {
      error = "research request failed";
    }

    const fresh = await refetch();
    setRecentlyAdded(new Set(newIds));
    setScan(null);
    setResearchBusy(false);
    setShowResearch(false);
    if (!error) setActive("research"); // surface the results
    setSummary(error ? `Research error: ${error}` : buildSummary(fresh, newIds, 0, "Research"));
  }

  const byKind = (kind: ItemKind) =>
    items.filter((i) => i.kind === kind && i.status !== "dismissed");
  // Client-side text filter (title + detail). Empty query = no filtering; tab counts stay unfiltered.
  const q = query.trim().toLowerCase();
  const matchesQuery = (i: ItemWithSource) =>
    !q || i.title.toLowerCase().includes(q) || (i.detail ?? "").toLowerCase().includes(q);
  const isError = summary?.includes("error:");
  const selected = selectedId != null ? items.find((i) => i.id === selectedId) ?? null : null;
  const dismissed = items.filter((i) => i.status === "dismissed");

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
            <div className="flex items-center gap-2">
              <button
                onClick={() => runScan(conversationIds, { full: true })}
                disabled={busy}
                title="Re-read every conversation in full (ignore checkpoints) to catch completed tasks the incremental scan missed"
                className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-black/5 disabled:opacity-60 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/10"
              >
                Full rescan
              </button>
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
                  ? "Scanning…"
                  : pending.length > 0
                    ? `Scan ${pending.length} pending`
                    : "Rescan"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Live progress (streamed step-by-step) — shared by scan + research */}
      {(busy || researchBusy) && scan && (
        <div className="mb-4 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm dark:border-indigo-500/30 dark:bg-indigo-500/10">
          <div className="flex items-center gap-2 font-medium text-indigo-800 dark:text-indigo-300">
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
            {researchBusy ? "Researching the web" : `Scanning conversation ${scan.convIndex}/${scan.convTotal}`}
          </div>
          <div className="mt-1 flex items-center gap-2 pl-[1.375rem] text-indigo-700/80 dark:text-indigo-300/80">
            <span>{scan.label}</span>
            <span className="tabular-nums text-xs text-indigo-600/70 dark:text-indigo-300/60">
              {Math.max(0, Math.round((now - scan.stepStart) / 1000))}s
            </span>
          </div>
        </div>
      )}

      {/* Post-scan summary banner */}
      {summary && !busy && !researchBusy && (
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

      {/* Use Internet for Research */}
      <div className="mb-4">
        {!showResearch ? (
          <button
            onClick={() => {
              setTopic(derivedTopic);
              setShowResearch(true);
            }}
            disabled={busy || researchBusy}
            title="Search the web (Reddit, forums, …) for features people are requesting for a project like this"
            className="rounded-lg border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60 dark:border-indigo-500/30 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
          >
            🌐 Use Internet for Research
          </button>
        ) : (
          <div className="rounded-lg border border-indigo-300 bg-indigo-50/50 p-2 dark:border-indigo-500/30 dark:bg-indigo-500/5">
            <label className="text-xs text-zinc-500">What to research (edit as needed):</label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. a grocery-deals mobile app"
                className="min-w-0 flex-1 rounded-lg border border-black/15 bg-white px-2.5 py-1.5 text-sm focus:border-indigo-400 focus:outline-none dark:border-white/15 dark:bg-zinc-900"
              />
              <button
                onClick={runResearch}
                disabled={researchBusy || !topic.trim()}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {researchBusy ? "Researching…" : "Run"}
              </button>
              <button
                onClick={() => setShowResearch(false)}
                disabled={researchBusy}
                className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-black/5 disabled:opacity-60 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/10"
              >
                Cancel
              </button>
            </div>
            <p className="mt-1 text-[11px] text-zinc-400">
              Finds features people request on the web; results land in the Research tab to triage.
            </p>
          </div>
        )}
      </div>

      {/* Tabs + search */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2 border-b border-black/10 dark:border-white/10">
        <nav className="flex flex-wrap gap-1">
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
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search items…"
          aria-label="Search items"
          className="mb-1.5 w-40 rounded-lg border border-black/15 bg-transparent px-2.5 py-1 text-sm placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none dark:border-white/15 sm:w-56"
        />
      </div>

      {/* Content */}
      {active === "task" ? (
        <div>
          {showAddForm ? (
            <AddTaskForm
              projectId={projectId}
              onCreated={handleCreated}
              onCancel={() => setShowAddForm(false)}
            />
          ) : (
            <div className="mb-3 flex justify-end">
              <button
                onClick={() => setShowAddForm(true)}
                className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-black/5 dark:border-white/15 dark:text-zinc-200 dark:hover:bg-white/10"
              >
                ＋ Add task
              </button>
            </div>
          )}
          <KanbanBoard
            tasks={items.filter((i) => i.kind === "task" && matchesQuery(i))}
            recentlyAdded={recentlyAdded}
            onMove={moveTask}
            onConfirm={confirmDone}
            onDismissSuggestion={dismissSuggestion}
            onPriorityChange={setPriority}
            onOpenDetail={setSelectedId}
          />
        </div>
      ) : (
        <ItemList
          items={items.filter((i) => i.kind === active && matchesQuery(i))}
          emptyLabel={TABS.find((t) => t.key === active)!.empty}
          recentlyAdded={recentlyAdded}
          onSetStatus={setStatus}
          onOpenDetail={setSelectedId}
          onPromote={promote}
        />
      )}

      {/* Dismissed items — tombstoned (won't reappear on a scan) but restorable here. */}
      {dismissed.length > 0 && (
        <details className="mt-6 text-sm">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            Dismissed ({dismissed.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {dismissed.map((it) => (
              <li
                key={it.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 rounded bg-black/10 px-1.5 py-0.5 text-[10px] capitalize text-zinc-500 dark:bg-white/10">
                    {KIND_NOUN[it.kind]}
                  </span>
                  <span className="truncate text-zinc-500 line-through">{it.title}</span>
                </span>
                <button
                  onClick={() => setStatus(it.id, "todo")}
                  title="Restore this item (move back to To Do)"
                  className="shrink-0 rounded-lg border border-black/15 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-black/5 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/10"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <ItemDetail
        key={selected?.id ?? "none"}
        item={selected}
        onClose={() => setSelectedId(null)}
        onSetStatus={setStatus}
        onConfirm={confirmDone}
        onDismissSuggestion={dismissSuggestion}
        onPriorityChange={setPriority}
        onImplement={implement}
        onApply={apply}
        onPromote={promote}
      />
    </div>
  );
}
