import { describe, expect, it } from "vitest";
import { mergeExtractions, spawnEnv } from "./claude";
import { ExtractionResult } from "./types";

describe("spawnEnv", () => {
  // Spread the real env so the object satisfies NodeJS.ProcessEnv, then override the keys we assert.
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: "sk-stale",
    ANTHROPIC_AUTH_TOKEN: "tok",
    ANTHROPIC_BASE_URL: "https://example.test",
    DASHBOARD_KEEP_ME: "keep",
  };

  it("always tags the child with DASHBOARD_EXTRACTION", () => {
    expect(spawnEnv(base, false).DASHBOARD_EXTRACTION).toBe("1");
    expect(spawnEnv(base, true).DASHBOARD_EXTRACTION).toBe("1");
  });

  it("keeps inherited ANTHROPIC_* when force is off", () => {
    const env = spawnEnv(base, false);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-stale");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://example.test");
  });

  it("strips every ANTHROPIC_* when force is on, leaving other vars intact", () => {
    const env = spawnEnv(base, true);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.DASHBOARD_KEEP_ME).toBe("keep");
  });

  it("does not mutate the caller's base env", () => {
    spawnEnv(base, true);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-stale");
  });
});

describe("mergeExtractions carries every category across chunks", () => {
  it("merges failures from separate chunks", () => {
    // A category needs edits in BOTH the initializer and the push loop. Missing the initializer is
    // a compile error; missing the push is silent — every chunk after the first vanishes, and only
    // on multi-chunk (long) transcripts. This test is the guard for that half.
    const chunk = (title: string) =>
      ExtractionResult.parse({ failures: [{ title }], tasks: [{ title: `t-${title}` }] });
    const merged = mergeExtractions([chunk("HTTP 429 from a.example"), chunk("HTTP 500 from b.example")]);
    expect(merged.failures.map((f) => f.title)).toEqual([
      "HTTP 429 from a.example",
      "HTTP 500 from b.example",
    ]);
    expect(merged.tasks).toHaveLength(2);
  });
});
