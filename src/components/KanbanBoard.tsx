"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useId, useState } from "react";
import type { ItemRow, ItemStatus } from "@/lib/types";
import PriorityPill from "./PriorityPill";

const COLUMNS: { id: Exclude<ItemStatus, "dismissed">; title: string }[] = [
  { id: "todo", title: "To Do" },
  { id: "in_progress", title: "In Progress" },
  { id: "done", title: "Done" },
];

async function patchItem(id: number, body: Record<string, unknown>) {
  await fetch(`/api/items/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function TaskCard({
  item,
  onConfirm,
  onDismissSuggestion,
  onPriorityChange,
}: {
  item: ItemRow;
  onConfirm: (id: number) => void;
  onDismissSuggestion: (id: number) => void;
  onPriorityChange: (id: number, rank: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(item.id),
  });
  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="cursor-grab touch-none rounded-lg border border-black/10 bg-white p-3 shadow-sm active:cursor-grabbing dark:border-white/10 dark:bg-zinc-800"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{item.title}</p>
        <PriorityPill
          itemId={item.id}
          rank={item.priority}
          onChanged={(r) => onPriorityChange(item.id, r)}
        />
      </div>
      {item.detail && (
        <p className="mt-1 line-clamp-3 text-xs text-zinc-500 dark:text-zinc-400">{item.detail}</p>
      )}

      {item.suggested_done === 1 && item.status !== "done" && (
        <div className="mt-2 rounded-md bg-amber-100 p-2 dark:bg-amber-500/15">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
            Looks done?
          </p>
          {item.done_evidence && (
            <p className="mt-0.5 line-clamp-2 text-[11px] italic text-amber-700/80 dark:text-amber-300/70">
              “{item.done_evidence}”
            </p>
          )}
          <div className="mt-1.5 flex gap-1.5">
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onConfirm(item.id)}
              className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700"
            >
              ✓ Done
            </button>
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onDismissSuggestion(item.id)}
              className="rounded bg-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200"
            >
              Not yet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Column({
  id,
  title,
  children,
  count,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  count: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-[60vh] flex-1 flex-col rounded-xl border p-3 transition-colors ${
        isOver
          ? "border-indigo-400 bg-indigo-50 dark:border-indigo-500 dark:bg-indigo-500/10"
          : "border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.02]"
      }`}
    >
      <div className="mb-3 flex items-center justify-between px-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-black/10 px-2 text-xs text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
          {count}
        </span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

export default function KanbanBoard({ tasks }: { tasks: ItemRow[] }) {
  const [items, setItems] = useState<ItemRow[]>(tasks);
  const [activeId, setActiveId] = useState<number | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  // Stable, hydration-safe id so dnd-kit's accessibility element ids match between
  // server and client (otherwise its internal counter drifts -> hydration mismatch).
  const dndContextId = useId();

  const visible = items.filter((i) => i.status !== "dismissed");
  const activeItem = activeId != null ? items.find((i) => i.id === activeId) : null;

  function onDragStart(e: DragStartEvent) {
    setActiveId(Number(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const id = Number(active.id);
    const newStatus = String(over.id) as ItemStatus;
    setItems((prev) =>
      prev.map((i) =>
        i.id === id ? { ...i, status: newStatus, suggested_done: 0 } : i,
      ),
    );
    patchItem(id, { status: newStatus });
  }

  function confirm(id: number) {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, status: "done", suggested_done: 0 } : i)),
    );
    patchItem(id, { suggestion: "confirm" });
  }

  function dismissSuggestion(id: number) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, suggested_done: 0 } : i)));
    patchItem(id, { suggestion: "dismiss" });
  }

  // PriorityPill issues the PATCH; we just update local state so the column re-sorts.
  function changePriority(id: number, rank: number) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, priority: rank } : i)));
  }

  if (visible.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-black/15 p-8 text-center text-sm text-zinc-500 dark:border-white/15">
        No tasks yet. Scan a conversation or run <code>/sync-board</code> to populate the board.
      </p>
    );
  }

  return (
    <DndContext id={dndContextId} sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex flex-col gap-3 md:flex-row">
        {COLUMNS.map((col) => {
          const colItems = visible
            .filter((i) => i.status === col.id)
            .sort((a, b) => a.priority - b.priority || b.id - a.id);
          return (
            <Column key={col.id} id={col.id} title={col.title} count={colItems.length}>
              {colItems.map((item) => (
                <TaskCard
                  key={item.id}
                  item={item}
                  onConfirm={confirm}
                  onDismissSuggestion={dismissSuggestion}
                  onPriorityChange={changePriority}
                />
              ))}
            </Column>
          );
        })}
      </div>
      <DragOverlay>
        {activeItem ? (
          <div className="cursor-grabbing rounded-lg border border-indigo-400 bg-white p-3 text-sm font-medium shadow-lg dark:bg-zinc-800">
            {activeItem.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
