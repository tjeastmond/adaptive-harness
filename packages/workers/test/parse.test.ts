import { describe, expect, test } from "bun:test";
import { record, redact, reportFrom, safeString, stderrTail, usageFrom } from "../src/parse.ts";

describe("record and safeString", () => {
  test("accepts only non-null objects that are not arrays", () => {
    const value = { key: "value" };
    expect(record(value)).toBe(value);
    for (const invalid of [null, undefined, 1, "text", [1]]) expect(record(invalid)).toBeUndefined();
  });

  test("accepts only strings and applies default and explicit limits", () => {
    expect(safeString("x".repeat(4001))).toHaveLength(4000);
    expect(safeString("abcdef", 3)).toBe("abc");
    expect(safeString("abcdef", 0)).toBe("");
    expect(safeString(123)).toBeUndefined();
  });
});

describe("reportFrom", () => {
  test("rejects non-records and reports without typed required fields", () => {
    for (const value of [
      null,
      [],
      "report",
      {},
      { summary: 1, completed: true },
      { summary: "ok", completed: "yes" },
    ]) {
      expect(reportFrom(value)).toBeUndefined();
    }
  });

  test("bounds strings and ignores mistyped optional fields and provider file claims", () => {
    expect(
      reportFrom({
        summary: "s".repeat(8001),
        completed: false,
        filesChanged: [{ path: "claimed", status: "added" }],
        checksRun: ["c".repeat(1001), 42, ...Array(50).fill("later")],
        concerns: "wrong type",
        requestedHelp: "h".repeat(2001),
      }),
    ).toEqual({
      summary: "s".repeat(8000),
      completed: false,
      filesChanged: [],
      checksRun: ["c".repeat(1000), ...Array(49).fill("later")],
      concerns: [],
      requestedHelp: "h".repeat(2000),
    });
    expect(
      reportFrom({ summary: "ok", completed: true, checksRun: [false], concerns: [null], requestedHelp: 1 }),
    ).toEqual({
      summary: "ok",
      completed: true,
      filesChanged: [],
      checksRun: [],
      concerns: [],
    });
  });
});

test("usageFrom accepts only nonnegative safe integers from known fields", () => {
  expect(usageFrom(null)).toBeUndefined();
  expect(usageFrom([])).toBeUndefined();
  expect(usageFrom({ input_tokens: -1, output_tokens: 1.5, cached_input_tokens: Infinity })).toBeUndefined();
  expect(
    usageFrom({ input_tokens: "3", output_tokens: NaN, cached_input_tokens: Number.MAX_SAFE_INTEGER + 1 }),
  ).toBeUndefined();
  expect(usageFrom({ input_tokens: 2, cached_input_tokens: 0, output_tokens: 3, inputTokens: 4, ignored: 5 })).toEqual({
    inputTokens: 4,
    cachedInputTokens: 0,
    outputTokens: 3,
  });
});

test("redact replaces repeated secrets but leaves values shorter than four characters", () => {
  expect(
    redact("long-secret, long-secret; abc; xy", { LONG: "long-secret", SHORT: "abc", TINY: "xy", EMPTY: "" }),
  ).toBe("[REDACTED], [REDACTED]; abc; xy");
});

describe("usageFrom Cursor cache tokens", () => {
  test("folds cache reads into total input and reports them as cached", () => {
    expect(usageFrom({ inputTokens: 85, outputTokens: 35, cacheReadTokens: 52049, cacheWriteTokens: 0 })).toEqual({
      inputTokens: 52134,
      cachedInputTokens: 52049,
      outputTokens: 35,
    });
  });

  test("counts cache writes in inputTokens only", () => {
    expect(usageFrom({ inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 5 })).toEqual({
      inputTokens: 115,
      cachedInputTokens: 100,
    });
  });

  test("ignores invalid cache values", () => {
    expect(usageFrom({ inputTokens: 10, cacheReadTokens: -1, cacheWriteTokens: 1.5 })).toEqual({ inputTokens: 10 });
    expect(usageFrom({ inputTokens: 10, cacheReadTokens: "7", cacheWriteTokens: "2" })).toEqual({ inputTokens: 10 });
  });

  test("does not invent inputTokens from cache fields", () => {
    expect(usageFrom({ cacheReadTokens: 50, cacheWriteTokens: 3, outputTokens: 1 })).toEqual({
      cachedInputTokens: 50,
      outputTokens: 1,
    });
  });

  test("keeps the unfolded input when the sum is not a safe integer", () => {
    expect(usageFrom({ inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 1 })).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: 1,
    });
  });
});

describe("stderrTail", () => {
  test("redacts secrets and strips ANSI, OSC, and control characters", () => {
    expect(
      stderrTail("\x1b[31mError\x1b[0m\x1b]0;hidden\x07\nsecret-value\tbad\x00end\x7f", { TOKEN: "secret-value" }),
    ).toBe("Error [REDACTED] bad end");
    expect(stderrTail("before\x1b]2;hidden\x1b\\after", {})).toBe("before after");
  });

  test("keeps the final 500 sanitized characters of long stderr", () => {
    const tail = stderrTail(`${"x".repeat(600)}\nlast`, {});
    expect(tail).toHaveLength(501);
    expect(tail).toBe(`…${"x".repeat(495)} last`);
    expect(stderrTail("short", {})).toBe("short");
  });
});
