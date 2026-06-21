@AGENTS.md

# AI Project Dashboard

Visualizes Claude Code conversations as per-project Kanban boards + Recommendations / Next Steps
/ Learnings tabs. Extraction is done by Claude itself (no API key) via the `/sync-board` slash
command (live) or headless `claude -p` (backfill + UI "Scan"). See `README.md` and
`docs/learnings.md`.

## Architecture

- **Data source:** Claude Code transcripts at `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.
- `src/lib/` — `db.ts` (better-sqlite3 + inline schema), `transcripts.ts` (parse/clean/checkpoint),
  `claude.ts` (headless `claude -p` wrapper + JSON repair), `store.ts` (all CRUD),
  `ingest.ts` (dedup/tombstone/completion), `scan.ts` (read → extract → ingest pipeline),
  `types.ts` (zod extraction contract + row types).
- `src/app/api/` — `items/[id]` (PATCH: status / confirm / dismiss), `conversations/[id]/scan` (POST).
- `src/app/` pages are server components reading the DB directly (`force-dynamic`);
  `src/components/` are the client-side Kanban + lists.
- `scripts/` — `backfill.ts`, `ingest-cli.ts`, `flag-hook.ts`, `install.ts`.

## Conventions

- All DB writes go through `store.ts` / `ingest.ts` (shared by CLI, hooks, and API) — never
  open the DB ad hoc.
- De-dup is enforced by `UNIQUE(project_id, kind, norm_key)`; dismissed rows are tombstones.
- Keep the headless instruction in `claude.ts` and `prompts/extract.md` and the `/sync-board`
  command in sync.
- Mark native packages in `serverExternalPackages` (next.config.ts).

## Commands

- `npm run dev` · `npm run build`
- `npm run backfill [-- --project <name>] [--full]`
- `npm run install-hooks [-- --dry-run]`
- Typecheck: `npx tsc --noEmit`
