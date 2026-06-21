"use client";

import { useState } from "react";
import ItemList from "./ItemList";
import KanbanBoard from "./KanbanBoard";
import type { ItemKind, ItemRow } from "@/lib/types";

const TABS: { key: ItemKind; label: string; empty: string }[] = [
  { key: "task", label: "Board", empty: "" },
  {
    key: "recommendation",
    label: "Recommendations",
    empty: "No recommendations captured yet.",
  },
  { key: "next_step", label: "Next Steps", empty: "No next steps captured yet." },
  { key: "learning", label: "Learnings", empty: "No learnings captured yet." },
];

export default function ProjectDashboard({ items }: { items: ItemRow[] }) {
  const [active, setActive] = useState<ItemKind>("task");

  const byKind = (kind: ItemKind) =>
    items.filter((i) => i.kind === kind && i.status !== "dismissed");

  return (
    <div>
      <nav className="mb-5 flex flex-wrap gap-1 border-b border-black/10 dark:border-white/10">
        {TABS.map((tab) => {
          const count = byKind(tab.key).length;
          const selected = active === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActive(tab.key)}
              className={`relative -mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                selected
                  ? "border-indigo-600 text-indigo-600 dark:text-indigo-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {tab.label}
              <span className="ml-1.5 rounded-full bg-black/10 px-1.5 text-xs dark:bg-white/10">
                {count}
              </span>
            </button>
          );
        })}
      </nav>

      {active === "task" ? (
        <KanbanBoard tasks={items.filter((i) => i.kind === "task")} />
      ) : (
        <ItemList
          items={items.filter((i) => i.kind === active)}
          emptyLabel={TABS.find((t) => t.key === active)!.empty}
        />
      )}
    </div>
  );
}
