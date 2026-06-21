# AI Project Dashboard

Turn your Claude Code conversations into a visual project workspace. The dashboard scans
your local conversation transcripts and surfaces, per project, a **Kanban task board** plus
**Recommendations**, **Next Steps**, and **Learnings** — so the suggestions and to‑dos that
normally scroll away in chat don't get lost.

- **Extraction is done by Claude itself** — no separate API key. A live `/sync-board` slash
  command uses your current session; backfill and the dashboard's "Scan" button use headless
  Claude Code (`claude -p`), reusing your existing login.
- **Automatic capture** — a `SessionEnd` hook flags each conversation as `needs_scan`; you run
  the LLM extraction on demand from the UI or with `/sync-board`.
- **Completion tracking** — re-scans flag tasks that look finished ("Looks done?") for you to
  confirm; you can also drag cards across the board.

## Highlights

- Built an **event-driven capture pipeline** using Claude Code **hooks** to flag conversation
  transcripts for ingestion automatically on session end.
- Integrated a **headless LLM extraction stage** (`claude -p`, no API key) that turns raw JSONL
  transcripts into **zod-validated structured data**, with retry/repair for malformed model JSON.
- Designed a **full-stack TypeScript** app — **Next.js (App Router) + SQLite (better-sqlite3, WAL)**
  — with an interactive **drag-and-drop Kanban** board (`dnd-kit`).
- Implemented **incremental scanning** (per-conversation UUID checkpoints) and **idempotent
  de-duplication / tombstoning** via a `UNIQUE(project, kind, norm_key)` constraint.
- Authored an **idempotent installer** that safely merges a hook into `~/.claude/settings.json`,
  installs a slash command, and updates `CLAUDE.md` — preserving existing config.
- **Containerized** with a multi-stage Dockerfile (Next.js standalone output) and a persisted
  SQLite volume.
- **AI-triaged priorities** — tasks are auto-assigned Urgent/High/Medium/Low and the board sorts
  highest-first; shipped behind a guarded, idempotent SQLite column migration over a live DB.

## How it works

```
Conversation ends ──SessionEnd hook──> scripts/flag-hook.ts  ──> mark conversation needs_scan
                                                                  (cheap, no LLM)
Extraction (any of):
  /sync-board (live session)        ─┐
  "Scan" button  -> API route       ─┼─> Claude reads transcript text ─> structured JSON
  npm run backfill (claude -p)      ─┘     (given existing open items for dedup + completion)
                                                     │
                                          lib/ingest.ts (dedup, tombstones, completion)
                                                     │
                                              SQLite (better-sqlite3)
                                                     │
                                   Next.js UI: Projects ▸ Project ▸ Kanban + tabs
```

Data source: Claude Code stores each conversation as append-only JSONL at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The parser strips tool noise and keeps
the user/assistant text.

## Getting started

```bash
npm install
npm run backfill              # scan existing conversations (uses claude -p)
#   npm run backfill -- --project <name>   # limit to matching transcripts
#   npm run backfill -- --full             # ignore checkpoints, re-scan everything
npm run dev                   # http://localhost:3000
```

### Enable automatic capture + the /sync-board command

```bash
npm run install-hooks           # merges into ~/.claude (use --dry-run to preview)
#   npm run install-hooks -- --dry-run
```

This adds a `SessionEnd` hook, installs the `/sync-board` slash command, and appends a nudge
block to your global `CLAUDE.md`. Re-running it is safe (idempotent).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js dev / production build / serve |
| `npm run backfill` | Scan existing transcripts via headless Claude |
| `npm run prioritize` | AI-assign priority (Urgent/High/Medium/Low) to existing tasks |
| `npm run ingest` | Ingest an extraction JSON (used by `/sync-board`) |
| `npm run flag-hook` | Hook target: mark a conversation `needs_scan` |
| `npm run install-hooks` | Idempotent installer for hook + command + CLAUDE.md |

## Configuration (env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DASHBOARD_DB` | `./data/dashboard.db` | SQLite file location |
| `CLAUDE_EXTRACT_MODEL` | `haiku` | Model alias for headless extraction |
| `CLAUDE_MAX_BUDGET_USD` | `0.25` | Per-call spend cap for `claude -p` |
| `SCAN_MAX_CHUNKS` | `12` | Max chunks per conversation scan (bounds cost) |

## Docker

```bash
docker build -t ai-project-dashboard .
docker run -p 3000:3000 -v "$PWD/data:/app/data" ai-project-dashboard
```

> The container serves the UI and manual board use. Automatic capture (hooks) and headless
> scanning need the host's `claude` CLI and `~/.claude` data, so run `backfill`/hooks on the host.

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · SQLite (better-sqlite3) ·
dnd-kit · zod · Claude Code (headless `claude -p`).
