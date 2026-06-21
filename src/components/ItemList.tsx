"use client";

import { useState } from "react";
import type { ItemRow } from "@/lib/types";

async function patchItem(id: number, body: Record<string, unknown>) {
  await fetch(`/api/items/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Generic list for recommendations / next steps / learnings. */
export default function ItemList({
  items,
  emptyLabel,
}: {
  items: ItemRow[];
  emptyLabel: string;
}) {
  const [list, setList] = useState<ItemRow[]>(items);
  const visible = list.filter((i) => i.status !== "dismissed");

  function setStatus(id: number, status: ItemRow["status"]) {
    setList((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
    patchItem(id, { status });
  }

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
        return (
          <li
            key={item.id}
            className="flex items-start gap-3 rounded-lg border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-zinc-800"
          >
            <button
              title={done ? "Mark as not done" : "Mark as done"}
              onClick={() => setStatus(item.id, done ? "todo" : "done")}
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                done
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-zinc-400 text-transparent hover:border-emerald-600"
              }`}
            >
              ✓
            </button>
            <div className="min-w-0 flex-1">
              <p
                className={`text-sm font-medium leading-snug ${
                  done ? "text-zinc-400 line-through dark:text-zinc-500" : ""
                }`}
              >
                {item.title}
              </p>
              {item.detail && (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{item.detail}</p>
              )}
              {item.source_quote && (
                <p className="mt-1.5 border-l-2 border-zinc-300 pl-2 text-[11px] italic text-zinc-400 dark:border-zinc-600">
                  “{item.source_quote}”
                </p>
              )}
            </div>
            <button
              title="Dismiss"
              onClick={() => setStatus(item.id, "dismissed")}
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
