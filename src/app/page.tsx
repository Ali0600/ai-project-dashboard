import Link from "next/link";
import DeleteProjectButton from "@/components/DeleteProjectButton";
import { listAttentionItems, listProjects, type AttentionItem, type ProjectSummary } from "@/lib/store";

export const dynamic = "force-dynamic";

const PRIORITY_LABEL: Record<number, { label: string; className: string }> = {
  1: { label: "urgent", className: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300" },
  2: { label: "high", className: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
};

/** Cross-project list of what's actually waiting on the user (see listAttentionItems). */
function NeedsYou({ items }: { items: AttentionItem[] }) {
  return (
    <div className="mb-8">
      <h2 className="mb-2 text-sm font-semibold text-zinc-600 dark:text-zinc-300">Needs you</h2>
      <ul className="flex flex-col gap-1.5">
        {items.map((i) => {
          const pri = PRIORITY_LABEL[i.priority];
          return (
            <li key={i.id}>
              <Link
                // Deep-link to the right tab: a failure is invisible on the default Board tab.
                href={`/projects/${i.project_id}?tab=${i.kind}`}
                className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm transition-colors hover:border-indigo-400 dark:border-white/10 dark:bg-zinc-900 dark:hover:border-indigo-500"
              >
                {i.suggested_done === 1 ? (
                  <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                    looks done?
                  </span>
                ) : i.kind === "failure" ? (
                  // Failures reach this list by recurring, not by priority — which most of them
                  // don't set, so PRIORITY_LABEL would render nothing at all.
                  <span className="shrink-0 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                    seen {i.times_seen}×
                  </span>
                ) : (
                  pri && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${pri.className}`}
                    >
                      {pri.label}
                    </span>
                  )
                )}
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                <span className="shrink-0 text-xs text-zinc-400">{i.project_name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  return (
    <Link
      href={`/projects/${p.id}`}
      className="group rounded-xl border border-black/10 bg-white p-4 transition-colors hover:border-indigo-400 dark:border-white/10 dark:bg-zinc-900 dark:hover:border-indigo-500"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold leading-tight group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
          {p.name}
        </h2>
        {p.needs_scan > 0 && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
            {p.needs_scan} to scan
          </span>
        )}
      </div>
      <p className="mt-0.5 truncate text-xs text-zinc-400" title={p.cwd}>
        {p.cwd}
      </p>
      <div className="mt-4 flex items-center gap-4 text-sm">
        <span>
          <span className="text-lg font-bold">{p.open_tasks}</span>{" "}
          <span className="text-zinc-500">open task{p.open_tasks === 1 ? "" : "s"}</span>
        </span>
        <span className="text-zinc-300 dark:text-zinc-700">·</span>
        <span className="text-zinc-500">{p.total_items} items</span>
      </div>
    </Link>
  );
}

export default function Home() {
  const projects = listProjects();
  const attention = listAttentionItems();
  // Only surface folders that actually have captured items; folders that were flagged but never
  // produced anything (or were scanned empty) collapse into a disclosure so they don't clutter.
  const withItems = projects.filter((p) => p.total_items > 0);
  const empty = projects.filter((p) => p.total_items === 0);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Projects</h1>
        <p className="mt-1 text-sm text-zinc-500">
          A visual board of tasks & suggestions from your Claude Code
          conversations.
        </p>
      </div>

      {attention.length > 0 && <NeedsYou items={attention} />}

      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-black/15 p-10 text-center dark:border-white/15">
          <p className="text-sm text-zinc-500">No projects yet.</p>
          <p className="mt-2 text-sm text-zinc-500">
            Run <code className="rounded bg-black/10 px-1.5 py-0.5 dark:bg-white/10">npm run backfill</code>{" "}
            to scan your existing conversations, or use{" "}
            <code className="rounded bg-black/10 px-1.5 py-0.5 dark:bg-white/10">/sync-board</code> in a
            live session.
          </p>
        </div>
      ) : (
        <>
          {withItems.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {withItems.map((p) => (
                <ProjectCard key={p.id} p={p} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              No projects with captured items yet — run a scan or <code>/sync-board</code>.
            </p>
          )}

          {empty.length > 0 && (
            <details className="mt-6 text-sm">
              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                {empty.length} folder{empty.length === 1 ? "" : "s"} captured but empty (scan to populate)
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {empty.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-3 rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
                  >
                    <Link
                      href={`/projects/${p.id}`}
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 hover:text-indigo-600 dark:hover:text-indigo-400"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{p.name}</span>
                        <span className="ml-2 truncate text-xs text-zinc-400">{p.cwd}</span>
                      </span>
                      {p.needs_scan > 0 && (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                          {p.needs_scan} to scan
                        </span>
                      )}
                    </Link>
                    <DeleteProjectButton projectId={p.id} projectName={p.name} className="shrink-0" />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
