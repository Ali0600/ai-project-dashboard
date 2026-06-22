import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractBacklog, findPlanRefs, PLANS_DIR } from "./plans";

describe("findPlanRefs", () => {
  it("resolves filenames under PLANS_DIR from absolute, ~, and bare forms, deduped", () => {
    const text = [
      "Your plan has been saved to: /Users/ah/.claude/plans/witty-coral.md",
      "see ~/.claude/plans/witty-coral.md again",
      "and .claude/plans/other-plan.md",
    ].join("\n");
    expect(findPlanRefs(text).sort()).toEqual(
      [
        path.join(PLANS_DIR, "other-plan.md"),
        path.join(PLANS_DIR, "witty-coral.md"),
      ].sort(),
    );
    expect(PLANS_DIR).toBe(path.join(os.homedir(), ".claude", "plans"));
  });

  it("returns nothing when no plan path is present", () => {
    expect(findPlanRefs("just some text about plans/ in general")).toEqual([]);
  });
});

describe("extractBacklog", () => {
  it("prefers an explicit fence and ignores headings that merely mention backlog", () => {
    const md = [
      "# Feature: pull the Backlog into the board", // mentions 'backlog' — must NOT match
      "design notes...",
      "<!-- backlog:start -->",
      "- Within-column ordering",
      "- Full-text search",
      "<!-- backlog:end -->",
      "## Done",
      "- shipped thing",
    ].join("\n");
    expect(extractBacklog(md)).toBe("- Within-column ordering\n- Full-text search");
  });

  it("ignores inline-prose mentions of the markers and matches the real own-line fence", () => {
    const md = [
      "Docs: prefer a fence `<!-- backlog:start -->` … `<!-- backlog:end -->` around items.",
      "**Backlog:**",
      "<!-- backlog:start -->",
      "- real item one",
      "- real item two",
      "<!-- backlog:end -->",
    ].join("\n");
    expect(extractBacklog(md)).toBe("- real item one\n- real item two");
  });

  it("falls back to a heading that starts with a backlog keyword, up to the next heading", () => {
    const md = [
      "## Shipped",
      "- thing A",
      "## Backlog",
      "- Within-column ordering",
      "- Apply on a branch",
      "## Env knobs",
      "- FOO",
    ].join("\n");
    expect(extractBacklog(md)).toBe("- Within-column ordering\n- Apply on a branch");
  });

  it("falls back to a bold label and stops at the next bold label", () => {
    const md = [
      "**Shipped:** core stuff",
      "**Backlog (surfaced, not built):**",
      "- Search / filter",
      "- docker-compose",
      "**Env knobs:** FOO, BAR",
    ].join("\n");
    expect(extractBacklog(md)).toBe("- Search / filter\n- docker-compose");
  });

  it("returns null when there is no recognizable backlog section (noise guard)", () => {
    const md = "# Plan\n## Context\nlots of prose\n## Changes\n- edit a file\n## Verification\n- run tests";
    expect(extractBacklog(md)).toBeNull();
  });

  it("returns null for an empty fence", () => {
    expect(extractBacklog("<!-- backlog:start -->\n\n<!-- backlog:end -->")).toBeNull();
  });
});
