/**
 * Ingest an extraction JSON object into the dashboard DB.
 * Used by the /sync-board slash command (live Claude writes JSON, we store it).
 *
 *   npx tsx scripts/ingest-cli.ts --cwd <projectDir> [--session <id>] [--file <json>]
 *
 * JSON is read from --file or stdin and must match the ExtractionResult schema.
 */
import fs from "node:fs";
import { ingestExtraction } from "../src/lib/ingest";
import { getConversationBySession, getOrCreateProject } from "../src/lib/store";
import { ExtractionResult } from "../src/lib/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cwd = arg("--cwd") || process.env.PWD;
const session = arg("--session");
const file = arg("--file");

if (!cwd) {
  console.error("ingest-cli: --cwd <projectDir> is required");
  process.exit(1);
}

const raw = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
let json: unknown;
try {
  json = JSON.parse(raw);
} catch {
  console.error("ingest-cli: input is not valid JSON");
  process.exit(1);
}

const parsed = ExtractionResult.safeParse(json);
if (!parsed.success) {
  console.error("ingest-cli: JSON does not match the extraction schema:");
  console.error(parsed.error.message);
  process.exit(1);
}

const project = getOrCreateProject(cwd);
const conv = session ? getConversationBySession(session) : undefined;
const res = ingestExtraction({
  projectId: project.id,
  conversationId: conv?.id ?? null,
  extraction: parsed.data,
});

console.log(
  JSON.stringify({ project: project.name, created: res.created, flaggedDone: res.flaggedDone }),
);
