"use client";

import { useState } from "react";
// type-only import — erased at build, so lib/preflight's node deps never reach the client bundle
import type { PreflightReport } from "@/lib/preflight";

/** CVE / malware counts (+ total deps) from a Report, computed client-side (no node deps). */
function headline(r: PreflightReport): { cve: number; malware: number; total: number } {
  return {
    cve: r.summary?.cve ?? 0,
    malware: r.summary?.malware ?? 0,
    total: r.total ?? r.findings?.length ?? 0,
  };
}

/**
 * A dependency-health badge on a project card. Renders Preflight's `summary.cve` / `summary.malware`
 * and re-scans on click via `/api/preflight`. Lives as a sibling of (not inside) the card's <Link>,
 * so clicking it never navigates.
 */
export default function PreflightBadge({
  projectId,
  initial,
}: {
  projectId: number;
  initial: PreflightReport | null;
}) {
  const [report, setReport] = useState<PreflightReport | null>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function scan(refresh: boolean) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/preflight?projectId=${projectId}${refresh ? "&refresh=1" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "scan failed");
      if (json.skipped) setNote("no manifest");
      else if (json.report) {
        setReport(json.report as PreflightReport);
        if (json.stale) setNote("Preflight offline — showing stale");
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!report) {
    return (
      <button
        onClick={() => scan(false)}
        disabled={busy}
        title={note ?? "Scan this project's dependencies with Preflight"}
        className="rounded-full border border-black/15 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-zinc-600 shadow-sm backdrop-blur hover:bg-black/5 disabled:opacity-60 dark:border-white/15 dark:bg-zinc-900/80 dark:text-zinc-300 dark:hover:bg-white/10"
      >
        {busy ? "🛡 …" : note === "no manifest" ? "🛡 n/a" : "🛡 Scan deps"}
      </button>
    );
  }

  const { cve, malware, total } = headline(report);
  const danger = cve > 0 || malware > 0;
  return (
    <button
      onClick={() => scan(true)}
      disabled={busy}
      title={`Preflight: ${cve} CVE, ${malware} malware across ${total} deps — click to re-scan${note ? ` · ${note}` : ""}`}
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-sm backdrop-blur disabled:opacity-60 ${
        danger
          ? "bg-rose-100 text-rose-700 hover:bg-rose-200 dark:bg-rose-500/20 dark:text-rose-300"
          : "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300"
      }`}
    >
      🛡 {busy ? "…" : `${cve} CVE · ${malware} malware`}
    </button>
  );
}
