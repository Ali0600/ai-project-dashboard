/**
 * Re-prioritization pass: asks headless Claude to assign a priority to every OPEN task
 * already in the dashboard, per project. Safe to re-run (overwrites with fresh scores).
 *
 *   npx tsx scripts/prioritize.ts                # all projects
 *   npx tsx scripts/prioritize.ts --project foo  # projects whose name/cwd contains "foo"
 *
 * Requires the `claude` CLI (uses claude -p under the hood).
 */
import { assignPriorities, ClaudeUnavailableError } from "../src/lib/claude";
import { listProjects, openTasks, updateItemPriority } from "../src/lib/store";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const filter = arg("--project");
  let projects = listProjects();
  if (filter) projects = projects.filter((p) => p.name.includes(filter) || p.cwd.includes(filter));

  if (projects.length === 0) {
    console.log("No matching projects.");
    return;
  }

  let total = 0;
  for (const p of projects) {
    const tasks = openTasks(p.id);
    if (tasks.length === 0) {
      console.log(`${p.name}: no open tasks`);
      continue;
    }
    process.stdout.write(`${p.name}: prioritizing ${tasks.length} task(s) ... `);
    try {
      const map = await assignPriorities(tasks);
      let n = 0;
      for (const [id, priority] of Object.entries(map)) {
        updateItemPriority(Number(id), priority);
        n++;
      }
      total += n;
      console.log(`set ${n}`);
    } catch (e) {
      if (e instanceof ClaudeUnavailableError) {
        console.error("\n`claude` CLI not found on PATH — cannot prioritize. Aborting.");
        process.exit(1);
      }
      console.log(`error: ${(e as Error).message}`);
    }
  }

  console.log(`\nDone. Updated priority on ${total} task(s).`);
}

main();
