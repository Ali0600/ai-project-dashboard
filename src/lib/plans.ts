import os from "node:os";
import path from "node:path";

/** Where Claude Code stores plan-mode documents. */
export const PLANS_DIR = path.join(os.homedir(), ".claude", "plans");

/**
 * Find plan files referenced in some text (e.g. a transcript line that mentions the path
 * Claude Code saved a plan to). We match the filename only and rebuild the path under
 * `PLANS_DIR`, so it's robust to `~`/absolute/relative forms and can never resolve to a file
 * outside the plans directory.
 */
export function findPlanRefs(text: string): string[] {
  const re = /\.claude\/plans\/([A-Za-z0-9._-]+\.md)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(path.join(PLANS_DIR, m[1]));
  return [...out];
}

// A section "label" is a backlog-ish word at the START of a heading/bold-label (anchored, so a
// heading that merely *mentions* "backlog" mid-sentence is not treated as the backlog section).
const SECTION_LABEL = /^\s*(backlog|not[ -]?built|open items?|remaining|to-?do|next up)\b/i;
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
// A bold run at the START of a line; trailing content allowed (e.g. "**Env knobs:** FOO").
// A list item like "- **Foo** bar" starts with "-", so it isn't matched (stays content).
const BOLD_LABEL = /^\*\*\s*([^*]+?)\s*\*\*/;

/**
 * Extract a plan's Backlog section, or `null` when the plan has no recognizable one (the noise
 * guard — an unstructured plan contributes nothing rather than flooding the board with its
 * already-done / in-design content). Resolution order:
 *   1. An explicit `<!-- backlog:start -->` … `<!-- backlog:end -->` fence (canonical).
 *   2. The first `#`-heading or `**bold**` label that *starts with* a backlog keyword, taken up to
 *      the next heading of the same-or-higher level (for a heading) or the next heading/bold label
 *      (for a bold label).
 */
export function extractBacklog(md: string): string | null {
  // Markers must be on their OWN line — so a plan that *documents* the syntax inline
  // (e.g. "prefer a `<!-- backlog:start -->` … `<!-- backlog:end -->` fence") isn't matched.
  const fence = md.match(
    /^[ \t]*<!--\s*backlog:start\s*-->[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<!--\s*backlog:end\s*-->[ \t]*$/im,
  );
  if (fence) return fence[1].trim() || null;

  const lines = md.split(/\r?\n/);
  let start = -1;
  let startLevel = 0;
  let startIsHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEADING);
    if (h && SECTION_LABEL.test(h[2])) {
      start = i;
      startLevel = h[1].length;
      startIsHeading = true;
      break;
    }
    const b = lines[i].match(BOLD_LABEL);
    if (b && SECTION_LABEL.test(b[1])) {
      start = i;
      startIsHeading = false;
      break;
    }
  }
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(HEADING);
    if (h) {
      if (!startIsHeading || h[1].length <= startLevel) break; // heading ends the section
    } else if (!startIsHeading && BOLD_LABEL.test(lines[i])) {
      break; // a bold-label section ends at the next bold label
    }
    body.push(lines[i]);
  }
  return body.join("\n").trim() || null;
}
