"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Removes a project (and, via ON DELETE CASCADE, its conversations + items) after a confirm.
 * On success navigates to the overview so we don't sit on a now-deleted project page.
 */
export default function DeleteProjectButton({
  projectId,
  projectName,
  className = "",
}: {
  projectId: number;
  projectName: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (busy) return;
    if (!window.confirm(`Delete "${projectName}" and all its items? This can't be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "delete failed");
      }
      router.push("/");
      router.refresh();
    } catch (e) {
      alert(`Could not delete project: ${(e as Error).message}`);
      setBusy(false);
    }
  }

  return (
    <button
      onClick={remove}
      disabled={busy}
      title="Delete this project and all its captured items"
      className={`rounded-lg border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10 ${className}`}
    >
      {busy ? "Removing…" : "Remove project"}
    </button>
  );
}
