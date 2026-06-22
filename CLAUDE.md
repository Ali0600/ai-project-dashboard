@AGENTS.md

# AI Project Dashboard

Visualizes Claude Code conversations as per-project Kanban boards + Recommendations / Next Steps
/ Learnings tabs. Extraction is done by Claude itself (no API key) via the `/sync-board` slash
command (live) or headless `claude -p` (backfill + UI "Scan"). See `README.md` and
`docs/learnings.md`.

## Architecture

- **Data source:** Claude Code transcripts at `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.
- `src/lib/` — `db.ts` (better-sqlite3 + inline schema + guarded column migrations),
  `transcripts.ts` (streaming parse/clean/checkpoint; has Vitest tests), `claude.ts`
  (`spawnClaude` → extraction, `implementPlan`, `assignPriorities`; JSON repair), `store.ts`
  (all CRUD + `hasUnscannedActivity`), `ingest.ts` (dedup/tombstone/completion), `scan.ts`
  (read → extract → ingest), `priority.ts` (zod-free priority consts), `format.ts`
  (deterministic dates), `types.ts` (zod contract + row types; re-exports priority).
- `src/app/api/` — `items` (POST create), `items/[id]` (PATCH: status / priority / confirm /
  dismiss), `items/[id]/implement` (POST: draft plan), `projects/[id]/items` (GET: client refetch),
  `conversations/[id]/scan` (POST).
- `src/app/` pages are server components reading the DB directly (`force-dynamic`).
  `src/components/` — `ProjectDashboard` owns all item state; `KanbanBoard` / `ItemList` /
  `ItemDetail` (modal) are controlled; plus `PriorityPill`, `AddTaskForm`, `SourceLine`.
- `scripts/` — `backfill.ts`, `prioritize.ts`, `ingest-cli.ts`, `flag-hook.ts`, `install.ts`.

## Conventions

- All DB writes go through `store.ts` / `ingest.ts` (shared by CLI, hooks, and API) — never
  open the DB ad hoc.
- De-dup is enforced by `UNIQUE(project_id, kind, norm_key)`; dismissed rows are tombstones.
- Keep the headless instruction in `claude.ts` and `prompts/extract.md` and the `/sync-board`
  command in sync.
- Mark native packages in `serverExternalPackages` (next.config.ts).
- **Client state = single source of truth in `ProjectDashboard`.** Children are controlled
  (props + callbacks); `useState(props)` does NOT sync on prop changes, so after a scan, call
  `refetch()` (GET `projects/[id]/items`) — don't rely on `router.refresh()` alone.
- **"needs scan" is computed live** via `hasUnscannedActivity` (transcript mtime vs
  `last_scanned_at`), not just the stored flag — the `SessionEnd` hook only fires at session end.
- **Additive DB columns**: guarded `PRAGMA table_info` + `ALTER` in `db.ts` `migrate()` (keep the
  SCHEMA default and the ALTER default identical).
- The dashboard's own headless `claude -p` runs set `DASHBOARD_EXTRACTION=1` so `flag-hook` ignores
  them (don't capture our subprocesses as conversations).
- **Capture is opt-in.** A folder becomes a project only via `/sync-board` or `npm run backfill`
  (both call `getOrCreateProject`). `flag-hook` only flags sessions whose `cwd` is **already** a
  project (`getProjectByCwd`), so one-off sessions never auto-create projects. The overview
  (`page.tsx`) shows projects with `total_items > 0` and collapses empty ones into a `<details>`.
- Priority is stored as an INTEGER rank (1=urgent…4=low); consts live in `priority.ts` (no zod).
- Pass a stable `useId()` to `<DndContext id=…>` (avoids hydration mismatch); format dates via
  `lib/format.ts` (locale-free) for the same reason.
- **Plan-file backlog capture** (`plans.ts`): scans fold the **Backlog** section of any
  `~/.claude/plans/*.md` the transcript references (`readTranscript` returns `planRefs`; `scan.ts`
  reads + injects it as an extraction chunk). `extractBacklog` returns `null` unless the plan has a
  `<!-- backlog:start/end -->` fence or a backlog-keyword heading/bold-label — no section → no noise.
  Scan/backfill only (not live `/sync-board`); off via `SCAN_PLAN_FILES=0`. Keep your own plan files'
  backlog inside the fence so they're captured cleanly.

## Commands

- `npm run dev` · `npm run build` · `npm run lint` · `npm test` (Vitest)
- `npm run backfill [-- --project <name>] [--full]` · `npm run prioritize [-- --project <name>]`
- `npm run install-hooks [-- --dry-run]`
- Typecheck: `npx tsc --noEmit`
- CI (`.github/workflows/ci.yml`) runs typecheck · lint · test · build on push/PR.
