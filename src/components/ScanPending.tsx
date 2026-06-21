"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Scans every "needs_scan" conversation for a project via headless Claude. */
export default function ScanPending({ conversationIds }: { conversationIds: number[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  if (conversationIds.length === 0) return null;

  async function scanAll() {
    setBusy(true);
    let created = 0;
    let error = "";
    for (let i = 0; i < conversationIds.length; i++) {
      setMsg(`Scanning ${i + 1}/${conversationIds.length}…`);
      try {
        const res = await fetch(`/api/conversations/${conversationIds[i]}/scan`, {
          method: "POST",
        });
        const json = await res.json();
        if (!res.ok) error = json.error || "scan failed";
        else created += json.created ?? 0;
      } catch {
        error = "scan request failed";
      }
    }
    setMsg(error ? error : `Added ${created} item(s)`);
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      onClick={scanAll}
      disabled={busy}
      className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
    >
      {busy ? msg || "Scanning…" : `Scan ${conversationIds.length} pending`}
    </button>
  );
}
