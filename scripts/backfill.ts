/**
 * Scan existing Claude Code transcripts and populate the dashboard.
 *
 *   npx tsx scripts/backfill.ts                 # incremental scan of every transcript
 *   npx tsx scripts/backfill.ts --project foo   # only transcripts whose path contains "foo"
 *   npx tsx scripts/backfill.ts --full          # re-scan from scratch (ignore checkpoints)
 *   npx tsx scripts/backfill.ts --limit 3       # cap number of transcripts
 *
 * Uses headless Claude (claude -p) under the hood — requires the `claude` CLI.
 */
import { ClaudeUnavailableError } from "../src/lib/claude";
import { scanTranscript } from "../src/lib/scan";
import { listTranscripts } from "../src/lib/transcripts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const filter = arg("--project");
  const full = process.argv.includes("--full");
  const limit = arg("--limit") ? Number(arg("--limit")) : Infinity;

  let transcripts = listTranscripts();
  if (filter) transcripts = transcripts.filter((t) => t.transcriptPath.includes(filter));
  transcripts = transcripts.slice(0, limit);

  if (transcripts.length === 0) {
    console.log("No matching transcripts found under ~/.claude/projects.");
    return;
  }

  let totalCreated = 0;
  let totalFlagged = 0;
  for (let i = 0; i < transcripts.length; i++) {
    const t = transcripts[i];
    process.stdout.write(`[${i + 1}/${transcripts.length}] ${t.sessionId} ... `);
    try {
      const r = await scanTranscript(t.transcriptPath, { incremental: !full });
      totalCreated += r.created;
      totalFlagged += r.flaggedDone;
      console.log(
        r.skipped
          ? "no new content"
          : `+${r.created} items, ${r.flaggedDone} done-flag(s) over ${r.chunks} chunk(s)`,
      );
    } catch (e) {
      if (e instanceof ClaudeUnavailableError) {
        console.error("\n`claude` CLI not found on PATH — cannot run extraction. Aborting.");
        process.exit(1);
      }
      console.log(`error: ${(e as Error).message}`);
    }
  }

  console.log(
    `\nDone. ${totalCreated} new item(s), ${totalFlagged} completion flag(s) across ${transcripts.length} transcript(s).`,
  );
}

main();
