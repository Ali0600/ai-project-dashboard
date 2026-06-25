import { describe, expect, it } from "vitest";
import { ExtractionResult, ResearchResult } from "./types";

describe("ExtractionResult", () => {
  it("folds legacy recommendations/next_steps into suggestions", () => {
    const r = ExtractionResult.parse({
      tasks: [{ title: "Build X" }],
      recommendations: [{ title: "Consider Y" }],
      next_steps: [{ title: "Then Z" }],
      suggestions: [{ title: "Idea W" }],
      learnings: [{ title: "TIL" }],
    });
    expect(r.suggestions.map((s) => s.title).sort()).toEqual([
      "Consider Y",
      "Idea W",
      "Then Z",
    ]);
    // Legacy keys are dropped from the output shape.
    expect((r as Record<string, unknown>).recommendations).toBeUndefined();
    expect((r as Record<string, unknown>).next_steps).toBeUndefined();
    expect(r.tasks).toHaveLength(1);
    expect(r.learnings).toHaveLength(1);
  });

  it("defaults missing arrays (including suggestions) to empty", () => {
    const r = ExtractionResult.parse({});
    expect(r.suggestions).toEqual([]);
    expect(r.tasks).toEqual([]);
    expect(r.learnings).toEqual([]);
    expect(r.completed).toEqual([]);
  });
});

describe("ResearchResult", () => {
  it("parses ideas and tolerates missing detail/source_quote", () => {
    const r = ResearchResult.parse({
      ideas: [{ title: "Add barcode scanner", source_url: "https://reddit.com/r/x/1" }],
    });
    expect(r.ideas).toHaveLength(1);
    expect(r.ideas[0].detail).toBe("");
    expect(r.ideas[0].source_quote).toBe("");
    expect(r.ideas[0].source_url).toBe("https://reddit.com/r/x/1");
  });

  it("defaults to an empty ideas array", () => {
    expect(ResearchResult.parse({}).ideas).toEqual([]);
  });
});
