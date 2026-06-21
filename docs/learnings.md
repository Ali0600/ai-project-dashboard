# Learnings

Teachable, transferable concepts that came up building this project.

## Claude Code hooks (event-driven automation)
Hooks are shell commands Claude Code runs on lifecycle events (`SessionEnd`, `Stop`,
`PreToolUse`, …); the event payload arrives as JSON on **stdin** (`session_id`,
`transcript_path`, `cwd`, …).
- **Why it came up:** we needed future conversations captured automatically without relying on
  the model "remembering" — a `SessionEnd` hook flags each conversation for scanning.
- **Takeaway:** for "do X every time Y happens" in Claude Code, reach for a hook, not a prompt
  instruction. Keep hook scripts cheap and exit 0 so they never block the session.

## Headless Claude as an LLM engine (no API key)
`claude -p "<prompt>" --output-format json` runs a one-shot query using your existing Claude
Code login — no separate `ANTHROPIC_API_KEY`. The JSON envelope has the model's text in
`.result` (often wrapped in ```json fences).
- **Why it came up:** the goal was LLM-quality extraction "without the API"; headless Claude
  reuses the subscription you already pay for.
- **Takeaway:** scripts/servers can shell out to `claude -p` for AI features; pipe large prompts
  via **stdin**, cap spend with `--max-budget-usd`, and pick a cheap model with `--model haiku`.

## SQLite UNIQUE + ON CONFLICT as dedup *and* tombstone
A `UNIQUE(project, kind, norm_key)` constraint with `INSERT … ON CONFLICT DO NOTHING` makes
re-inserts idempotent: re-scans can't create duplicates, and a row left in a `dismissed` state
acts as a tombstone (its key is taken, so the item never comes back).
- **Why it came up:** conversations get re-scanned repeatedly; we needed stable de-duplication
  and a way to keep dismissed items from reappearing.
- **Takeaway:** model "don't show this again" as a normal row in a terminal state, not a delete —
  the unique key does the suppression for free.

## Incremental processing via checkpoints
Store the last-processed record id (here, the last transcript `uuid`) and resume after it on the
next run, instead of reprocessing the whole input.
- **Why it came up:** transcripts are append-only and one was 79 MB — reprocessing every time
  would be slow and costly.
- **Takeaway:** for append-only/streaming sources, persist a high-water mark and only handle
  what's new.

## Native modules in Next.js: `serverExternalPackages`
Native addons (e.g. `better-sqlite3`) can't be bundled by the build tool; list them under
`serverExternalPackages` so Next keeps them external and loads them at runtime.
- **Why it came up:** the build broke trying to bundle the SQLite native binary.
- **Takeaway:** any package with a `.node` binary almost always needs to be marked external.

## Defensive parsing of LLM JSON
Models return *mostly* valid JSON — expect ```json fences, surrounding prose, and unescaped
quotes/newlines inside string values. Strip fences, slice to the outer `{…}`, drop control
chars, validate with a schema (zod), and retry once with a corrective nudge.
- **Why it came up:** Haiku emitted an unescaped quote inside a `source_quote`, breaking
  `JSON.parse`.
- **Takeaway:** never trust LLM output as well-formed — wrap parsing in repair + schema
  validation + a bounded retry.

## Next.js standalone output for Docker
`output: "standalone"` emits a self-contained `server.js` plus only the traced dependencies,
yielding a much smaller runtime image (copy `.next/standalone`, `.next/static`, `public`).
- **Why it came up:** containerizing the dashboard for the resume.
- **Takeaway:** use standalone output for Docker; remember file-tracing pulls in native modules
  too, so build and run on the same base image/arch.

## Additive SQLite migrations (`PRAGMA table_info` + `ALTER`)
`CREATE TABLE IF NOT EXISTS` only creates *new* tables — it never adds a column to a table that
already exists. To evolve a live DB, check `PRAGMA table_info(<table>)` for the column and run
`ALTER TABLE … ADD COLUMN … DEFAULT …` only if it's missing (idempotent on every boot).
- **Why it came up:** adding `priority` to `items` when the DB already held 43 rows; the schema's
  `CREATE TABLE IF NOT EXISTS` was a no-op so existing rows never got the column.
- **Takeaway:** keep schema creation idempotent *and* add a tiny guarded-`ALTER` migration step
  per new column; give it a `DEFAULT` so existing rows backfill instantly.

## Keep server-only deps out of the client bundle
A value imported into a Client Component is bundled for the browser. Importing constants from a
module that also imports `zod` (or `better-sqlite3`, `fs`, …) drags that dependency client-side.
Split shared constants into a dependency-free module both sides can import.
- **Why it came up:** the priority enum/labels were needed by both the zod schema (server) and the
  Kanban card (client); putting them in `lib/priority.ts` (no zod) keeps zod server-only.
- **Takeaway:** put cross-boundary constants in a leaf module with zero heavy imports; let the
  server file re-export them for convenience.

## Self-triggering automation (hook/feedback loops)
Automation that fires on an event will also fire for work the tool *itself* generates. Our global
`SessionEnd` hook captured every Claude session — including the headless `claude -p` subprocesses
the dashboard spawns to do extraction — creating junk "conversations" and malformed projects.
- **Why it came up:** after installing the hook, `backfill`/`prioritize` runs polluted the
  homepage with empty projects named after `.jsonl` files.
- **Takeaway:** when a process triggers the same automation it depends on, tag its children with a
  marker (we set `DASHBOARD_EXTRACTION=1` in the spawn env) and have the hook **no-op** when it
  sees the marker. Also validate inputs at the sink (skip transcripts with no `cwd`; never derive a
  key from a filename) so one missed guard doesn't create garbage.

## React hydration mismatch from non-deterministic ids
SSR fails to hydrate when an attribute differs between the server HTML and the first client render.
A common cause is an auto-generated id from a module-level counter (dnd-kit's `aria-describedby`):
the dev server's counter advances across requests while the client starts fresh, so they disagree.
- **Why it came up:** `<DndContext>` rendered `DndDescribedBy-4` on the server but `-0` on the client.
- **Takeaway:** feed such libraries a hydration-stable id from React's `useId()` (e.g.
  `<DndContext id={useId()}>`). `useId` is guaranteed identical on server and client. Same fix
  applies to any "random/counter id, date, or `window` check" hydration warning.

## `useState(props)` ignores prop changes (and why `router.refresh()` "did nothing")
`const [x, setX] = useState(props.x)` seeds state **once**, on mount; later prop changes are
ignored. So a child seeded from props won't update when the parent re-renders with new data.
`router.refresh()` re-runs the server component and passes fresh props, but a child holding its own
`useState(props)` keeps the stale copy — only a full reload (remount) reflects the change.
- **Why it came up:** the Scan button extracted items, but the Kanban only showed them after a
  hard refresh — `KanbanBoard`/`ItemList` each did `useState(tasks)`.
- **Takeaway:** pick one source of truth. Make children **controlled** (render straight from
  props + callbacks) and keep mutable state in one owner; after a server-side change, update that
  owner explicitly (we refetch via an API and `setItems`), rather than relying on prop-sync.
