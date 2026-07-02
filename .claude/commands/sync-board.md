---
description: Sync THIS conversation's tasks & suggestions into the AI Project Dashboard.
allowed-tools: Bash, Read
---

You are syncing the **current Claude Code conversation** into the **AI Project Dashboard**.

Steps:

1. Run `pwd` to get the current project directory — these items belong to that project.
2. Review the current conversation and extract its actionable knowledge as a single JSON
   object with EXACTLY this shape (use empty arrays when a category has nothing; never
   invent items):

   ```json
   {
     "tasks":       [{"title": "", "detail": "", "status_guess": "todo", "priority": "urgent|high|medium|low", "source_quote": ""}],
     "suggestions": [{"title": "", "detail": "", "source_quote": ""}],
     "completed":   [{"existing_id_or_title": "", "evidence_quote": ""}]
   }
   ```

   - **tasks**: concrete things to build / fix / configure / test. Set `priority`: urgent
     (blockers/security), high, medium (default), or low (nice-to-have).
   - **suggestions**: advice, ideas, or optional next steps you proposed that aren't already
     concrete committed tasks ("you should", "I recommend", "consider", "Optional Next Step:").
   - **completed**: tasks discussed earlier in this conversation that are now finished
     (quote the evidence).
   - Keep titles short (≤ 10 words); put context in `detail`. Never list the same item as both
     a task and a suggestion.

3. Write that JSON to `/tmp/sync-board.json`.
4. Ingest it into the dashboard (replace `<PWD>` with the directory from step 1):

   ```bash
   cd "__DASHBOARD_DIR__" && DASHBOARD_DB="__DASHBOARD_DIR__/data/dashboard.db" \
     npx tsx scripts/ingest-cli.ts --cwd "<PWD>" --file /tmp/sync-board.json
   ```

   Items auto-link to the current conversation (resolved from the newest transcript matching
   `<PWD>`), so they show "From <title> · <date>" on the board — no extra flag needed.

5. Report a short summary of what was added (counts per category) and remind me I can
   view it by running `npm run dev` in the dashboard (http://localhost:3000).
