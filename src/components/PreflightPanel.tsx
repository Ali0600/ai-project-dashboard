"use client";

import { useState } from "react";
// type-only import — erased at build, so lib/preflight's node deps never reach the client bundle
import type { PreflightReport } from "@/lib/preflight";

const VERDICT_STYLE: Record<string, string> = {
  cve: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  malware: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  stale: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
};

function Chip({ label, n, danger }: { label: string; n: number; danger?: boolean }) {
  const hot = danger && n > 0;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        hot
          ? "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
          : "bg-black/5 text-zinc-600 dark:bg-white/10 dark:text-zinc-300"
      }`}
    >
      {n} {label}
    </span>
  );
}

/**
 * "Scan deps" button + expandable dependency-health panel for a project page. Clicking loads the
 * Preflight Report (`/api/preflight`, 24h-cached) and renders it above the board. Preflight stays the
 * source of truth; this is our own thin UI over its `summary` + `findings`.
 */
export default function PreflightPanel({
  projectId,
  initial,
}: {
  projectId: number;
  initial: PreflightReport | null;
}) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<PreflightReport | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function load(refresh: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/preflight?projectId=${projectId}${refresh ? "&refresh=1" : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "scan failed");
      if (json.skipped) {
        setReport(null);
        setError("No package.json / requirements.txt found in this project's folder.");
      } else if (json.report) {
        setReport(json.report as PreflightReport);
        setStale(Boolean(json.stale));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !report && !busy) load(false); // lazy-load on first open
  }

  const summary = report?.summary ?? {};
  const findings = report?.findings ?? [];
  const flagged = findings.filter((f) => f.verdict && f.verdict !== "safe");
  const total = report?.total ?? findings.length;
  const hot = (summary.cve ?? 0) + (summary.malware ?? 0) > 0;

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        <button
          onClick={toggle}
          className="rounded-lg border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-500/30 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
        >
          🛡 {open ? "Hide dependency health" : "Scan deps"}
        </button>
        {!open && report && hot && (
          <span className="text-xs font-medium text-rose-600 dark:text-rose-400">
            {summary.cve ?? 0} CVE · {summary.malware ?? 0} malware
          </span>
        )}
      </div>

      {open && (
        <div className="mt-3 rounded-xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-zinc-900">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">
              Dependency health <span className="font-normal text-zinc-400">· via Preflight</span>
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => load(true)}
                disabled={busy}
                className="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-black/5 disabled:opacity-60 dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/10"
              >
                {busy ? "Scanning…" : "Re-scan"}
              </button>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded px-2 text-zinc-400 hover:bg-black/5 hover:text-zinc-700 dark:hover:bg-white/10"
              >
                ✕
              </button>
            </div>
          </div>

          {busy && !report && <p className="mt-3 text-sm text-zinc-500">Scanning dependencies…</p>}
          {error && <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          {stale && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Preflight was unreachable — showing the last cached scan.
            </p>
          )}

          {report && (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Chip label="CVE" n={summary.cve ?? 0} danger />
                <Chip label="malware" n={summary.malware ?? 0} danger />
                <Chip label="stale" n={summary.stale ?? 0} />
                <Chip label="pinned" n={summary.pinned ?? 0} />
                <Chip label="safe" n={summary.safe ?? 0} />
                <span className="ml-auto text-xs text-zinc-400">
                  {total} deps{report.ecosystem ? ` · ${report.ecosystem}` : ""}
                </span>
              </div>

              {flagged.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {flagged.map((f, i) => (
                    <li
                      key={`${f.name}-${i}`}
                      className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{f.name}</span>
                        {f.version && <span className="text-xs text-zinc-400">{f.version}</span>}
                        {f.verdict && (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                              VERDICT_STYLE[f.verdict] ?? "bg-black/10 text-zinc-500 dark:bg-white/10 dark:text-zinc-400"
                            }`}
                          >
                            {f.verdict}
                          </span>
                        )}
                      </div>
                      {f.reason && <p className="mt-0.5 text-xs text-zinc-500">{f.reason}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">
                  ✓ All {total} dependencies look safe.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
