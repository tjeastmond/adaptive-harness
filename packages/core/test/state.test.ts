import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { StateChunk } from "../src/index.ts";
import { DeterministicContextAssembler, InMemoryStateStore } from "../src/index.ts";

const chunk = (id: string, runId = "run-1", content: unknown = id): StateChunk => ({
  id,
  runId,
  type: "observation",
  source: "test",
  createdAt: "2026-09-23T00:00:00.000Z",
  metadata: {},
  content,
});

const request = {
  runId: "run-1",
  purpose: "decision" as const,
  objective: { text: "Complete issue one", acceptanceCriteria: ["Keep context bounded"] },
};

describe("InMemoryStateStore", () => {
  test("isolates runs, preserves append order, filters types, and limits to recent chunks", async () => {
    const store = new InMemoryStateStore();
    await store.append(chunk("first"));
    await store.append({ ...chunk("second"), type: "test-result" });
    await store.append(chunk("other", "run-2"));
    await store.append(chunk("third"));

    expect((await store.list("run-1")).map(({ id }) => id)).toEqual(["first", "second", "third"]);
    expect((await store.list("run-1", { types: ["test-result"] })).map(({ id }) => id)).toEqual(["second"]);
    expect((await store.list("run-1", { limit: 2 })).map(({ id }) => id)).toEqual(["second", "third"]);
    expect((await store.list("run-1", { ids: ["third", "first", "other"] })).map(({ id }) => id)).toEqual([
      "first",
      "third",
    ]);
    expect(await store.list("run-1", { limit: 0 })).toEqual([]);
    expect(await store.get("missing")).toBeUndefined();
  });

  test("rejects duplicate IDs and shields stored chunks from caller mutation", async () => {
    const store = new InMemoryStateStore();
    const input = chunk("one", "run-1", { value: "original" });
    await store.append(input);
    (input.content as { value: string }).value = "changed";
    const retrieved = await store.get("one");
    if (!retrieved) throw new Error("Expected stored chunk");
    expect(retrieved.content).toEqual({ value: "original" });
    (retrieved.content as { value: string }).value = "changed again";
    expect((await store.get("one"))?.content).toEqual({ value: "original" });
    expect(store.append(chunk("one", "run-2"))).rejects.toThrow("already exists");
    expect(store.list("run-1", { limit: -1 })).rejects.toThrow("nonnegative");
  });
});

describe("DeterministicContextAssembler", () => {
  test("renders empty state with a stable hash", async () => {
    const assembler = new DeterministicContextAssembler(new InMemoryStateStore());
    const first = await assembler.assemble(request);
    const second = await assembler.assemble(request);

    expect(first).toEqual(second);
    expect(first.chunks).toEqual([]);
    expect(first.summary).toContain("Complete issue one");
    expect(first.renderedContentHash).toBe(createHash("sha256").update(first.summary).digest("hex"));
  });

  test("selects recent candidate chunks in append order and excludes other runs", async () => {
    const store = new InMemoryStateStore();
    for (const id of ["a", "b", "c", "d"]) await store.append(chunk(id));
    await store.append(chunk("foreign", "run-2"));
    const assembler = new DeterministicContextAssembler(store, { maxChunks: 2 });
    const result = await assembler.assemble({ ...request, candidateChunkIds: ["foreign", "d", "b", "c"] });

    expect(result.chunks.map(({ chunk, visibility }) => [chunk.id, visibility])).toEqual([
      ["c", "full"],
      ["d", "full"],
    ]);
    expect(result.summary.indexOf("STATE CHUNK c")).toBeLessThan(result.summary.indexOf("STATE CHUNK d"));
    expect(result.summary).not.toContain("foreign");
    expect(result.summary).not.toContain("STATE CHUNK b");
  });

  test("bounds rendered context and marks a truncated chunk as short", async () => {
    const store = new InMemoryStateStore();
    await store.append(chunk("large", "run-1", "x".repeat(1_000)));
    const assembler = new DeterministicContextAssembler(store, { maxCharacters: 128 });
    const result = await assembler.assemble(request);

    expect(result.summary.length).toBe(128);
    expect(result.chunks.map(({ chunk, visibility }) => [chunk.id, visibility])).toEqual([["large", "short"]]);
    expect(result.renderedContentHash).toBe(createHash("sha256").update(result.summary).digest("hex"));
  });

  test("keeps the newest chunk when an older chunk is larger than the budget", async () => {
    const store = new InMemoryStateStore();
    await store.append(chunk("old", "run-1", "x".repeat(1_000)));
    await store.append(chunk("new", "run-1", "latest result"));
    const assembler = new DeterministicContextAssembler(store, { maxCharacters: 128 });
    const result = await assembler.assemble(request);

    expect(result.chunks[0]?.chunk.id).toBe("new");
    expect(result.summary).toContain("latest result");
    expect(result.summary.length).toBeLessThanOrEqual(128);
  });
});
