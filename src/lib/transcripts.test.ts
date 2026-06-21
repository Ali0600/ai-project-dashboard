import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chunkText, readTranscript } from "./transcripts";

const tmpFiles: string[] = [];

function writeFixture(entries: object[]): string {
  const p = path.join(os.tmpdir(), `transcript-test-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  tmpFiles.push(p);
  return p;
}

const TS = "2026-06-18T10:00:00Z";
const user = (uuid: string, text: unknown, extra: object = {}) => ({
  type: "user",
  uuid,
  cwd: "/proj",
  timestamp: TS,
  message: { role: "user", content: text },
  ...extra,
});
const asst = (uuid: string, text: string, extra: object = {}) => ({
  type: "assistant",
  uuid,
  cwd: "/proj",
  timestamp: TS,
  message: { role: "assistant", content: [{ type: "text", text }] },
  ...extra,
});

afterAll(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe("readTranscript", () => {
  it("extracts cleaned user/assistant text, skips tool noise, and reads meta", async () => {
    const p = writeFixture([
      { type: "ai-title", aiTitle: "My Project Chat", sessionId: "s" },
      user("u1", "Build a todo app"),
      asst("a1", "Sure, here is the plan"),
      {
        type: "assistant",
        uuid: "a2",
        cwd: "/proj",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
      },
      {
        type: "user",
        uuid: "u2",
        cwd: "/proj",
        timestamp: TS,
        message: { role: "user", content: [{ type: "tool_result", content: "SECRET_OUTPUT" }] },
      },
    ]);
    const r = await readTranscript(p);
    expect(r.meta.cwd).toBe("/proj");
    expect(r.meta.title).toBe("My Project Chat");
    expect(r.text).toContain("USER: Build a todo app");
    expect(r.text).toContain("ASSISTANT: Sure, here is the plan");
    expect(r.text).not.toContain("SECRET_OUTPUT");
    expect(r.text).not.toContain("tool_use");
    expect(r.empty).toBe(false);
  });

  it("returns only content after the checkpoint", async () => {
    const p = writeFixture([
      user("u1", "first"),
      asst("a1", "reply one"),
      user("u2", "second"),
      asst("a2", "reply two"),
    ]);
    const r = await readTranscript(p, "a1");
    expect(r.text).not.toContain("first");
    expect(r.text).not.toContain("reply one");
    expect(r.text).toContain("USER: second");
    expect(r.text).toContain("ASSISTANT: reply two");
  });

  it("falls back to the full transcript when the checkpoint is not found", async () => {
    const p = writeFixture([user("u1", "alpha"), asst("a1", "beta")]);
    const r = await readTranscript(p, "missing-uuid");
    expect(r.text).toContain("USER: alpha");
    expect(r.text).toContain("ASSISTANT: beta");
    expect(r.empty).toBe(false);
  });

  it("reports empty when the checkpoint is the last entry", async () => {
    const p = writeFixture([user("u1", "hi"), asst("a1", "bye")]);
    const r = await readTranscript(p, "a1");
    expect(r.empty).toBe(true);
    expect(r.text).toBe("");
  });

  it("skips noise-prefixed user text and sub-agent (sidechain) turns", async () => {
    const p = writeFixture([
      user("u1", "<command-name>foo</command-name>"),
      asst("a1", "real answer"),
      asst("a2", "internal sub-agent chatter", { isSidechain: true }),
      user("u2", "real question"),
    ]);
    const r = await readTranscript(p);
    expect(r.text).not.toContain("command-name");
    expect(r.text).not.toContain("sub-agent chatter");
    expect(r.text).toContain("ASSISTANT: real answer");
    expect(r.text).toContain("USER: real question");
  });
});

describe("chunkText", () => {
  it("returns one chunk when under the limit", () => {
    expect(chunkText("hello world", 100)).toEqual(["hello world"]);
  });

  it("returns an empty array for empty text", () => {
    expect(chunkText("", 100)).toEqual([]);
  });

  it("splits on paragraph boundaries when over the limit", () => {
    const text = ["a".repeat(60), "b".repeat(60)].join("\n\n");
    const chunks = chunkText(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("a".repeat(60));
    expect(chunks.join("")).toContain("b".repeat(60));
  });

  it("hard-splits a single paragraph larger than the limit", () => {
    const chunks = chunkText("x".repeat(250), 100);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });
});
