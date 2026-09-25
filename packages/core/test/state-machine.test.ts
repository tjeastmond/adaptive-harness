import { expect, test } from "bun:test";
import { assertTransition, canTransition, isTerminalStatus, RUN_TRANSITIONS } from "../src/index.ts";

test("terminal statuses have no exits and active statuses can always stop", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    expect(isTerminalStatus(status)).toBe(true);
    expect(() => assertTransition(status, "running")).toThrow(`Illegal run transition from ${status} to running`);
  }
  for (const status of ["created", "routing", "running", "reviewing", "verifying", "paused"] as const) {
    expect(isTerminalStatus(status)).toBe(false);
    expect(canTransition(status, "failed")).toBe(true);
    expect(canTransition(status, "cancelled")).toBe(true);
  }
});

test("runs complete only after verification or an approved pause", () => {
  const into = Object.entries(RUN_TRANSITIONS)
    .filter(([, targets]) => targets.includes("completed"))
    .map(([from]) => from);
  expect(into.sort()).toEqual(["paused", "verifying"]);
  expect(canTransition("created", "running")).toBe(false);
});
