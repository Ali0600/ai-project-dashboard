"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Shown when a project's folder no longer exists on disk. This is worth interrupting for: capture
 * matches the path exactly, so a moved repo stops being captured silently — no error, just a board
 * that quietly stops updating — and dependency scanning and apply-on-branch fail too. Offers to
 * re-point the project at the new location rather than making the user delete and re-enrol it
 * (which would lose the item history).
 */
export default function ProjectPathNotice({
  projectId,
  cwd,
}: {
  projectId: number;
  cwd: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(cwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = value.trim();
    if (!next || next === cwd) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not update the folder");
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
      <p className="font-medium text-amber-800 dark:text-amber-300">This project&apos;s folder is missing</p>
      <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/80">
        Nothing at <code>{cwd}</code>. New sessions there aren&apos;t being captured, and dependency
        scanning won&apos;t work until this points at the folder&apos;s current location.
      </p>

      {editing ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder="/Users/you/path/to/project"
            className="min-w-0 flex-1 rounded-lg border border-black/15 bg-white px-2 py-1 text-xs dark:border-white/15 dark:bg-zinc-900"
          />
          <button
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => {
              setEditing(false);
              setValue(cwd);
              setError(null);
            }}
            className="rounded-lg border border-black/15 px-2.5 py-1 text-xs dark:border-white/15"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="mt-2 rounded-lg border border-amber-400 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/15"
        >
          Update folder…
        </button>
      )}
      {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
}
