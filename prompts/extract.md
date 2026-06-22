# Extraction contract

This is the instruction Claude follows when turning a conversation transcript into
structured dashboard data. The headless path (`src/lib/claude.ts`) and the live
`/sync-board` slash command both follow this same shape. Keep them in sync.

Return **only** a JSON object with this exact shape:

```json
{
  "tasks":       [{"title": "", "detail": "", "status_guess": "todo|in_progress|done", "priority": "urgent|high|medium|low", "source_quote": ""}],
  "suggestions": [{"title": "", "detail": "", "source_quote": ""}],
  "learnings":   [{"title": "", "detail": "", "source_quote": ""}],
  "completed":   [{"existing_id_or_title": "", "evidence_quote": ""}]
}
```

## Categories

- **tasks** — concrete, actionable work for the user (build / fix / configure / test). Set
  `priority`: urgent (blockers/security/broken builds), high, medium (default), low (nice-to-have).
- **suggestions** — advice, ideas, or optional next steps the assistant proposed that are NOT
  already concrete committed tasks ("you should", "I recommend", "consider", "Optional Next Step:").
- **learnings** — teachable, transferable concepts worth remembering.
- **completed** — items from the supplied EXISTING OPEN ITEMS list that the conversation
  shows are now finished. Reference the existing item by its exact title (or id) and quote
  the evidence.

## Rules

- Titles are short and actionable (≤ ~10 words). Put detail/context in `detail`.
- Never duplicate something already in EXISTING OPEN ITEMS — only emit genuinely new items.
- Never list the same item as both a task and a suggestion — concrete committed work is a task.
- Only add to `completed` when there is explicit evidence the work was done.
- `source_quote` is a short verbatim snippet from the transcript supporting the item.
- Empty arrays are fine. Never invent items.
