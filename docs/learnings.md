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

## Stream large files instead of `readFileSync`
`fs.readFileSync(path)` + `split("\n")` loads the **whole file** (and a per-line array) into
memory; `readline.createInterface({ input: fs.createReadStream(path) })` yields one line at a time
so memory is bounded by the largest line + whatever you choose to keep.
- **Why it came up:** a 79 MB transcript (single lines up to 733 KB) where only ~0.5% of bytes is
  the text we keep — streaming parsed it in ~200 ms with no memory blow-up.
- **Takeaway:** for inputs that can grow without bound (logs, transcripts, exports), stream and
  retain only the extracted result; never `readFileSync` an open-ended file.

## Incremental checkpoints need a "not-found" fallback
When resuming from a saved position (here, the last-processed `uuid`), the marker can be missing —
the file was rotated, compacted, or the checkpoint is stale. If "start after the marker" is the
only path, a missing marker silently processes **nothing**.
- **Why it came up:** `started = !sinceUuid` meant a not-found checkpoint left `started=false` for
  the whole file → a scan that extracted zero items.
- **Takeaway:** always handle "marker not found" explicitly — fall back to processing everything
  (idempotent dedup downstream makes the re-process safe).

## Resume a Claude Code session for context; restrict tools to bound side effects
`claude -p --resume <session-id> "…"` continues an *existing* conversation, so the model already
has all the prior context — no need to re-explain. Pair it with `--disallowed-tools "Write Edit
MultiEdit NotebookEdit Bash"` to make the run effectively **read-only** (it can Read/Grep/Glob to
inform an answer but can't change anything).
- **Why it came up:** the dashboard's "Implement" button drafts a plan by resuming the task's
  source conversation — the plan came back referencing the exact prior discussion (`eas
  channel:edit …`), which a fresh run wouldn't know; disallowing edit/shell tools guaranteed it
  only *planned*.
- **Takeaway:** for a context-rich one-shot, resume the original session instead of rebuilding
  context; gate autonomy with `--disallowed-tools` / `--permission-mode` and cap cost with
  `--max-budget-usd`. (Don't resume a session that's currently open — appends can clobber.)

## Compute liveness from the filesystem, not just event flags
When an event (a hook) may fire late or never, derive the state from a cheap source-of-truth check
instead of trusting a cached flag. We flag "needs scan" by comparing the transcript's `mtime` to
`last_scanned_at`, so an active conversation surfaces even though the `SessionEnd` hook only fires
when the session ends.
- **Why it came up:** a still-open session was never flagged `needs_scan` (SessionEnd hadn't fired),
  so new work never showed up in the UI.
- **Takeaway:** prefer recomputing derived state from the underlying artifact (file mtime/size/hash)
  over relying solely on an event that can be missed or delayed — `fs.stat` is cheap enough per render.

## Headless browser end-to-end checks via Chrome DevTools Protocol (no Playwright)
Launch `chrome --headless --remote-debugging-port=9222 <url>`, then drive it from Node with the
built-in global `WebSocket` (get the page target from `http://localhost:9222/json`): `Runtime.evaluate`
to inspect/act, `Input.dispatchMouseEvent` to click, `Page.captureScreenshot` for proof. Gotcha: a
programmatic `element.click()` may not trigger React handlers on a dnd-kit draggable, but a real
`Input.dispatchMouseEvent` (press+release at coordinates) does.
- **Why it came up:** the preview server and the Chrome extension were unavailable, but I needed to
  *prove* the Scan button updated the board in place — measured 4→3 cards with `navigations:1` (no reload).
- **Takeaway:** CDP + Node's global `WebSocket` is a zero-dependency way to script a real browser for
  verification. For ordinary buttons prefer `element.click()` (scroll-independent); reserve
  `Input.dispatchMouseEvent` for elements that swallow synthetic events (dnd-kit draggables) — and
  remember coordinate clicks miss anything **below the fold**, so `scrollIntoView()` first (a
  bottom-of-page "Restore" button silently no-op'd until I switched to `element.click()`).

## Long-running processes freeze their auth env at launch
A process captures a snapshot of environment variables when it starts. If those include a
short-lived token (e.g. one injected by a desktop app / IDE integrated terminal), the process keeps
using that stale value after the token expires — and every subprocess it spawns inherits the dead
credential, so calls fail with 401 even though an interactive session right next to it still works.
- **Why it came up:** the dashboard dev server, started from the Claude desktop app's terminal,
  captured an ephemeral auth token; hours later its headless `claude -p` scan failed with
  `401 Invalid authentication credentials` while the interactive app (which refreshes its own token)
  was fine.
- **Takeaway:** for headless/automation auth use a *durable* credential (`claude setup-token`, a
  service account, a refreshed secret) rather than an interactive session's injected env; restart
  long-running servers from an environment with persistent auth, and turn raw provider errors
  (401/403) into an actionable message instead of dumping the response.

## HMR prop-drift in long-lived dev tabs
During heavy live-editing, a browser tab can end up running a client bundle that expects props an
older cached server payload never sent → a runtime crash (e.g. `Cannot read properties of undefined
(reading 'length')`) that silently breaks interactivity until a hard reload.
- **Why it came up:** after ~a dozen edits to one component, the open tab threw on
  `conversationIds.length` and the Scan button stopped updating in place.
- **Takeaway:** default array/object props (`x = []`) so a transient prop-shape mismatch can't
  hard-crash; when "it only works after a hard refresh," suspect bundle drift, not your logic.

## Backing up a SQLite DB in WAL mode needs more than `cp`
In WAL journal mode, recent (committed) writes live in a side-car `-wal` file and aren't folded
into the main `.db` until a checkpoint. So `cp dashboard.db backup.db` can capture a **stale**
snapshot missing most rows. Copy `*.db` + `*.db-wal` + `*.db-shm` together, run
`PRAGMA wal_checkpoint(TRUNCATE)` first, or use the online backup API (`better-sqlite3`'s
`db.backup(path)`), which produces a consistent standalone copy.
- **Why it came up:** before a data migration I `cp`'d the DB and the "backup" showed 23 items vs
  110 live — the rest were sitting in the `-wal` file; `db.backup()` captured the full set.
- **Takeaway:** never back up a live WAL database with a plain file copy — checkpoint first or use
  the engine's backup API, or the restore will silently lose recent data.

## A parser that scans for a delimiter will match the doc that *documents* the delimiter
If you extract content between markers (`<!-- backlog:start/end -->`), any file that *describes* the
marker syntax inline — docs, a plan that explains the feature — contains those markers in prose and
your "first start…end" match grabs the example, not the real section.
- **Why it came up:** `extractBacklog` pulled `" … "` from a plan whose prose said "prefer a fence
  `<!-- backlog:start -->` … `<!-- backlog:end -->`"; the real fenced backlog below it was never reached.
- **Takeaway:** make structural delimiters unambiguous vs. prose — require them on their **own line**
  (anchor with `^…$` + multiline), or use a token unlikely to appear in writing. Test with a fixture
  that mentions the marker inline *and* uses it for real.

## Stream progress for long server ops instead of one opaque request
A request that does minutes of server work (here, N×`claude -p` per scan) looks frozen — the user
can't tell "working" from "stuck". Return a **`ReadableStream`** of newline-delimited JSON instead:
the handler emits `{phase:"extracting",index,total}` events as it goes, then a terminal
`{phase:"result",…}`/`{phase:"error",…}`. The client reads `res.body.getReader()`, splits on `\n`,
and updates the UI live. No SSE/WebSocket needed; works over a normal `fetch` POST.
- **Why it came up:** the Scan button gave no feedback during long headless extraction; a streamed
  step + per-step elapsed timer makes it obvious it's alive (verified non-buffered via
  `curl -N` timestamps — set `cache-control: no-transform` to avoid proxy buffering).
- **Takeaway:** for any operation longer than ~1–2s, stream coarse progress; a **per-step timer**
  (reset on each step) is the cheapest "is it stuck?" signal — a frozen number means trouble.

## Kill dev servers by port, not by `pkill -f` on the command
A stale server kept serving an old build, so verification screenshots showed pre-change behavior.
`pkill -f "next start"` and `pkill -f "PORT=3100"` both missed it: the actual listener was a child
`next-server` worker (different argv), and `PORT=3100` is an **environment variable, not part of the
command line**, so `-f` never matches it. Two `next start` on one port also silently no-op the second
(first keeps the socket), so you keep hitting the old one.
- **Why it came up:** an opt-in/overview change looked broken in a CDP screenshot until I realized
  the previous `npm start` was still bound to :3100 with the old bundle.
- **Takeaway:** target the thing holding the socket — `lsof -ti tcp:3100 | xargs kill -9` — then
  confirm the port is free before restarting. Env vars and child workers make name-based kills
  unreliable; and when "the fix isn't showing," suspect a stale process before suspecting the code.

## Reconciling LLM references back to your records needs fuzzy matching
When an LLM reports "this existing item is now done", it paraphrases the title ("Basket feature")
rather than echoing your stored one ("Build in-app basket optimizer (Basket feature)"). Exact /
normalized-string matching then silently fails and the completion is never recorded. Match by
**token-set containment** instead — share of the smaller token set that overlaps (1.0 when one ⊆
the other), after dropping generic stop-words — and only accept a hit that's both strong (≥0.7) and
**unambiguous** (clear margin over the 2nd-best) to avoid false positives.
- **Why it came up:** a built feature stayed "todo" because the basket task was *created and
  completed in the same scan* (so it wasn't in the pre-scan open-items list), and even a re-scan
  couldn't match the paraphrased reference. Fix = a **full rescan** (re-read all content with current
  open items) + fuzzy matching.
- **Pick the metric to fit the question.** *Reference → record* ("is this open task the one the
  model says is done?") wants **containment** (the model's short paraphrase is a *subset* of your
  longer stored title) + an ambiguity guard. *Record ↔ record* ("are these two tasks the same thing
  reworded?", i.e. de-dup) wants **Jaccard** (|∩|/|∪|): it requires the token *sets* to largely
  coincide, so "Add EXPO_TOKEN GitHub secret" dedups against "Add EXPO_TOKEN secret to GitHub" but a
  short task isn't swallowed by a longer superset. Containment for dedup over-matches ("Deploy to
  Render" ⊆ "Enable gated Render deploy via hook"); Jaccard keeps them distinct.
- **Takeaway:** any LLM-extraction-into-DB flow that links model output to existing rows should
  fuzzy-match — containment for ref→record, Jaccard for dedup — and dedup must span **every status**
  (done/dismissed too) **and every overlapping kind** (e.g. a "suggestion" can be a reworded copy of
  a "task"); a within-one-bucket dedup silently lets the dup back in via another bucket. Offer a
  "reprocess everything" path, since incremental passes only ever see each piece of content once.

## Build a clean env for spawned subprocesses; don't forward `...process.env` blindly
A child process inherits whatever's in the parent's environment — including ambient credentials/config
that can silently override its intended behaviour (an expired `ANTHROPIC_*` token, a proxy `*_BASE_URL`,
`NODE_OPTIONS`). Passing `{ ...process.env }` to `spawn` makes the child's behaviour depend on *how the
parent happened to be launched*, which is invisible and non-reproducible.
- **Why it came up:** the dashboard's headless `claude -p` inherited an expired token from the shell
  that started the dev server and 401'd; the fix (`DASHBOARD_FORCE_SUBSCRIPTION_AUTH`) strips inherited
  `ANTHROPIC_*` from the child env so the CLI falls back to its own persistent login.
- **Takeaway:** when you spawn a tool that has its *own* auth/config source, curate the child env —
  drop the ambient vars that could poison it — so its behaviour is deterministic regardless of the
  parent's launch context. Gate the stripping behind a flag if some users legitimately rely on those vars.

## An external "single source" analyzer may only handle one unit per call — discover, fan out, merge
Delegating to an external service as the single source of truth doesn't mean one call covers a
*composite* input. Two traps hit at once here: (1) we looked for manifests only at the repo **root**, so
a monorepo showed "no manifest"; (2) once found, Preflight's `/api/scan` scans exactly **one ecosystem
per call** — sending a `package.json` **and** a `requirements.txt` together returned only PyPI (13 deps),
silently hiding 943 npm deps **and 2 CVEs**.
- **Why it came up:** grocery-helper (Expo `mobile/` + FastAPI `backend/`) — nested manifests + two
  ecosystems. Fix: BFS shallow subdirs for manifests, then one scan **per ecosystem group** and merge
  (sum summaries, concat findings) → 956 deps, 2 CVEs surfaced.
- **Takeaway:** (1) discover inputs where they actually live — search subdirs, don't assume the root
  (monorepos nest under `mobile/`, `backend/`, `packages/*`). (2) **Probe the service's real behavior on a
  composite input** before trusting it; if it's one-unit-per-call, fan out and merge rather than shipping a
  misleadingly-partial (and falsely reassuring) result.

## Adapt a copy-paste integration to the host app's real model — don't paste it verbatim
A vendor/companion "drop-in" integration snippet encodes the *other* app's assumptions. Preflight's
doc fetched each project's manifest **from GitHub** (`api.github.com/repos/<owner>/<name>/contents/…`)
and opened its own DB (`new Database('data.db')`). Pasted as-is into this dashboard it would have
**broken twice**: our `projects` store **local `cwd` paths, not GitHub repos** (so there's no
`owner/name` to fetch), and our convention is one shared `getDb()` (a second `data.db` would be a
split-brain DB). The fix was to keep the *contract* (the `POST /api/scan` request/response) and swap
the *plumbing*: read manifests from the local `cwd`, persist via the existing `store.ts`/`getDb()`.
- **Why it came up:** the relayed integration doc assumed a GitHub-repo data model this app never had.
- **Takeaway:** treat an integration doc as a **contract spec, not code** — verify each assumption
  against the host's real schema/conventions (how it identifies entities, how it persists) and rewire
  the data-fetch/storage to match. Also: consume the partner as a **service behind a 24h cache**
  (cache-aside) so its `Report` shape can evolve without touching you, and keep your types tolerant
  (`[k: string]: unknown`) rather than mirroring its internal model.

## A deny-list of named capabilities breaks when a name drifts — prefer an allow-list
Restricting a tool by **naming what to forbid** (`--disallowed-tools "Write Edit MultiEdit …"`)
couples you to exact capability names. When `MultiEdit` was merged into `Edit` in a newer Claude
CLI, the now-unknown name made the CLI reject the *whole* run at startup (`Permission deny rule
"MultiEdit" matches no known tool`) — every headless research/implement call exited 1 before doing
anything. Worse for security: a deny-list also **fails open** — if a new editing tool is added that
you didn't list, it's silently allowed.
- **Why it came up:** the "Use Internet for Research" run died at launch on a stale tool name copied
  from the older read-only Implement command.
- **Takeaway:** to bound an agent/process's capabilities, prefer an **allow-list of what it may do**
  (`--allowed-tools "WebSearch WebFetch Read"`) over a deny-list of what it may not — allow-lists fail
  *safe* (new capabilities are denied by default) and don't break when a forbidden name is renamed or
  removed. Validate name-based rules against the tool's *current* vocabulary, not yesterday's.

## Give an agent the web by toggling its tools, not by wiring a search API
Claude Code already ships `WebSearch` + `WebFetch` tools, so "research the web" needs no third-party
search API or key — run a headless `claude -p` with `--allowed-tools "WebSearch WebFetch"` and have it
return structured JSON. Scope it by *also* disallowing edit/shell tools so the agent can only **read**
the web, never act on what it finds (web pages are untrusted — treat returned titles/URLs as data, and
keep results review-only).
- **Why it came up:** the "Use Internet for Research" feature mines Reddit/forums for requested
  features; the same `spawnClaude` + JSON-repair path as transcript extraction worked, just with the
  tool allowlist flipped from "deny web/edits" (Implement) to "allow web, deny edits".
- **Caveat:** `WebSearch` availability is account/region-dependent and can't be detected statically (it's
  a tool, not a CLI flag) — plan a `WebFetch`-only fallback / clear error, and gate behind a budget cap.
- **Takeaway:** an agent's capabilities are a *tool-allowlist* decision. Reuse one spawn path and vary
  `--allowed-tools`/`--disallowed-tools` to get read-only-plan, sandboxed-edit, or web-research modes —
  no new integration per capability.

## Sandbox an autonomous file-writing agent in a git worktree + branch
To let an AI agent edit a repo without risking the working copy, run it inside a fresh
`git worktree add -b <branch> <tmpdir> HEAD` — an isolated checkout of the same commit. The agent
edits there with auto-accept; you then `add -A` + `diff --cached` to capture the change, commit it on
the branch, and `worktree remove` the temp dir (the branch + commit persist). The main checkout is
never touched, and nothing is pushed — review/push stays manual.
- **Why it came up:** the dashboard's "Apply on a branch" upgrades read-only "Implement" to actually
  apply a plan (`--permission-mode acceptEdits`) — but autonomously editing the user's *other* repos
  needs a blast-radius limit.
- **Two gotchas:** (1) run the agent **fresh, not `--resume`** — a resumed session can carry absolute
  paths from the original cwd and write *outside* the worktree, defeating isolation. (2) Also disallow
  `Bash`/network tools so "edits only" really means edits only.
- **Takeaway:** worktree-per-agent-run is the cheap sandbox for autonomous code changes — isolated,
  reviewable as a branch diff, trivially discardable (`worktree remove` + `branch -D`), main untouched.

## Single-table polymorphism: every kind-specific operation must filter by `kind`
When one table holds several "kinds" of row (`items.kind = task|suggestion|learning`), a query that
implements behaviour meaningful for only **one** kind must say `WHERE kind = '…'`. Omit it and the
operation silently leaks across kinds — no error, just wrong rows.
- **Why it came up:** `flagSuggestedDone` (the "Looks done?" completion flow, a task-only concept)
  had no `kind` filter in any of its 3 lookups, so the model's `completed[]` references matched
  learnings/suggestions too — a live-DB audit found **21 learnings + 7 suggestions** wrongly carrying
  `suggested_done=1`. The bug was invisible in code review but obvious as a data distribution.
- **Takeaway:** in a single-table/`kind`-column schema, audit `SELECT kind, COUNT(*) … GROUP BY kind`
  on the real data — a kind that shouldn't appear in a result set is a missing scope predicate. Add
  the `kind` filter to *every* kind-specific read/write, not just the obvious one.

## Resolve "the current thing" from filesystem state, not a passed-in id
A CLI/command that runs *inside* a live context often can't easily get its own id (here, the
`/sync-board` slash command doesn't know its Claude session id), so work it produces ends up
unattributed. The live session's transcript is simply the **most-recently-modified** file under the
projects dir — pick the newest whose embedded `cwd` matches, and you've found "now" without an id.
- **Why it came up:** `/sync-board` ingested items with `conversation_id = NULL` (90 orphans, all
  showing "Added via /sync-board") because `ingest-cli` only linked a conversation when given an
  explicit `--session`. Resolving the newest matching transcript links them to the real conversation.
- **Takeaway:** when the caller can't name the active entity, derive it from a filesystem signal
  (newest mtime + an embedded identity field like `cwd`) rather than leaving the link empty — same
  "compute liveness from the filesystem" instinct as the needs-scan mtime check.

## Event-driven capture should be opt-in/scoped, not capture-everything
An automation that fires on a generic lifecycle event (here, a global `SessionEnd` hook) captures *all*
of the user's activity, not just what they care about — flooding the system with noise.
- **Why it came up:** the hook turned **every** folder the user ran `claude` in (including `/tmp`) into
  a dashboard "project"; the fix was to only flag sessions whose `cwd` is **already** a tracked project
  (enrolled explicitly via `/sync-board` or backfill), and to collapse empty ones in the UI.
- **Takeaway:** make broad event-driven capture opt-in — act only on entities the user has explicitly
  enrolled (allowlist / "already known") and filter transient/system sources — rather than capturing
  everything and making the user prune. This is the complement of "don't capture your own subprocesses."

## Retiring a value from a polymorphic `kind` column is a coordinated sweep + data migration
Deleting one member of a shared enum (`items.kind`) is not a one-line change: it touches every layer
that enumerates the kind — the LLM extraction contract, the zod schema, ingest, the dedup rules, and
the UI tabs — plus a migration to purge rows that already carry the retired value.
- **Why it came up:** dropped the `learning` item kind (it duplicated `docs/learnings.md` /
  `~/.claude/lessons.md` and wasn't actionable). The edit spanned the 3 synced contract copies
  (`claude.ts` INSTRUCTION + `prompts/extract.md` + `sync-board.md`), `ITEM_KINDS`/zod, `ingest`,
  `dupKinds`, the tab list, and an idempotent `DELETE FROM items WHERE kind='learning'` migration
  (130 live rows) — verified with a before/after `GROUP BY kind` audit around a WAL-safe backup.
- **Takeaway:** narrow the source-of-truth constant first and let the compiler (exhaustive
  `Record<Kind,…>` / switches) point you at every call site; ship the removal *with* an idempotent
  migration that deletes/converts existing rows, and confirm the row distribution before→after. Pairs
  with "every kind-specific operation must filter by `kind`."
