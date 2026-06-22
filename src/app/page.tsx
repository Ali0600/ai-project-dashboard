import Link from "next/link";
import { listProjects } from "@/lib/store";

export const dynamic = "force-dynamic";

export default function Home() {
  const projects = listProjects();

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Projects</h1>
        <p className="mt-1 text-sm text-zinc-500">
          A visual board of tasks, suggestions & learnings from your Claude Code
          conversations.
        </p>
      </div>

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
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
          ))}
        </div>
      )}
    </div>
  );
}
