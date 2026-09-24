import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionProvider, HarnessRun } from "@adaptive-harness/core";
import { DeterministicDecisionProvider, routeRequest } from "@adaptive-harness/decisions";
import { SqliteHarnessStore } from "@adaptive-harness/persistence";
import { createPersistentDecisionGateway } from "../src/decision-gateway.ts";

const now = "2026-09-23T12:00:00.000Z";
const run: HarnessRun = {
  id: "run-1",
  status: "created",
  objective: { text: "Test gateway", acceptanceCriteria: [] },
  workspace: "/tmp/work",
  configPath: "/tmp/config.yaml",
  configHash: "hash",
  currentStep: 0,
  budget: { workerCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, elapsedMs: 0 },
  createdAt: now,
  updatedAt: now,
};

test("runtime gateway persists Jev and bypass audit while emitting bypass events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-decision-"));
  const store = new SqliteHarnessStore(join(dir, "harness.sqlite"));
  try {
    await store.createRun(run);
    let calls = 0;
    const jev: DecisionProvider = {
      kind: "jev",
      preflight: async () => ({ ok: true, details: [] }),
      evaluate: async () => {
        calls++;
        return {
          id: "jev-decision",
          model: "jev-1.13.0",
          answers: { task_kind: { type: "noul", noul: 0.9 } },
          usage: { inputTokens: 10, outputTokens: 2 },
          durationMs: 12,
          raw: { value: "bounded" },
        };
      },
    };
    const events: Array<{ type: "decision.bypassed"; runId: string; reason: string }> = [];
    const gateway = createPersistentDecisionGateway(store, {
      jev,
      deterministic: new DeterministicDecisionProvider(),
      allowBypass: true,
      fallback: { onUnavailable: "deterministic", onLowConfidence: "ask-user" },
      minConfidence: 0.5,
      emit: async (event) => {
        events.push(event);
      },
    });
    const request = routeRequest("Implement a small fix");
    expect(gateway.evaluate({ runId: run.id, phase: "tool" }, request)).rejects.toThrow(
      "Unsupported persisted decision phase tool",
    );
    expect(calls).toBe(0);
    await gateway.evaluate({ runId: run.id, phase: "route" }, request);
    expect(await store.getDecision("jev-decision")).toMatchObject({
      runId: run.id,
      requestedMode: "jev",
      selectedMode: "jev",
      questions: request.questions,
      response: { model: "jev-1.13.0", usage: { inputTokens: 10, outputTokens: 2 }, durationMs: 12 },
    });
    await gateway.evaluate({ runId: run.id, phase: "route", mode: "deterministic", reason: "smoke control" }, request);
    expect(events).toEqual([{ type: "decision.bypassed", runId: run.id, reason: "smoke control" }]);
    expect(
      (await store.listDecisions(run.id)).find((decision) => decision.selectedMode === "deterministic"),
    ).toMatchObject({
      requestedMode: "deterministic",
      selectedMode: "deterministic",
      fallbackReason: "smoke control",
      response: { model: "deterministic-bypass" },
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
