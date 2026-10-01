import { expect, test } from "bun:test";
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  HarnessRun,
  VerificationResult,
} from "@adaptive-harness/core";
import { DeterministicDecisionProvider } from "../src/deterministic.ts";
import { type DecisionAudit, DecisionHandoffError, DefaultDecisionGateway } from "../src/gateway.ts";
import { JevUnavailableError } from "../src/jev.ts";
import {
  exhaustedBudget,
  normalizeCompletionDecision,
  normalizeRouteDecision,
  selectInitialAgent,
  selectNextAction,
  uncachedInputTokens,
} from "../src/policy.ts";
import { completionRequest, routeRequest } from "../src/questions.ts";

const route = routeRequest("Implement a small, clear fix");
const context = { runId: "run-1", phase: "route" as const };
const routing = {
  defaultAgent: "implementer",
  complexAgent: "reasoner",
  complexTaskScore: 3,
  requireReviewRiskScore: 3,
  autoProceedConfidence: 0.85,
  askUserBelowConfidence: 0.5,
};

function routeResponse(confidence = 0.9): DecisionResponse {
  return {
    id: "decision-1",
    model: "jev-1.13.0",
    answers: {
      task_kind: { type: "choice", choice: "implementation", confidence, probabilities: { implementation: 1 } },
      complexity: { type: "score", score: 1, confidence: 0.9, probabilities: { "1": 1 } },
      requirements_clear: { type: "noul", noul: 0.95 },
      external_research_needed: { type: "noul", noul: 0.05 },
    },
    usage: { inputTokens: 30, outputTokens: 8 },
    durationMs: 42,
    raw: { model: "jev-1.13.0" },
  };
}

function provider(evaluate: (request: DecisionRequest) => Promise<DecisionResponse>): DecisionProvider {
  return { kind: "jev", preflight: async () => ({ ok: true, details: [] }), evaluate };
}

function harness(jev: DecisionProvider, fallback: "deterministic" | "ask-user" | "fail" = "deterministic") {
  const audits: DecisionAudit[] = [];
  const bypasses: Array<{ runId: string; reason: string }> = [];
  const gateway = new DefaultDecisionGateway({
    jev,
    deterministic: new DeterministicDecisionProvider(),
    allowBypass: true,
    fallback: { onUnavailable: fallback, onLowConfidence: fallback },
    minConfidence: 0.6,
    record: async (audit) => {
      audits.push(audit);
    },
    emitBypass: async (event) => {
      bypasses.push(event);
    },
  });
  return { gateway, audits, bypasses };
}

test("Jev is the default and records exact model, usage, latency, response, and selected mode", async () => {
  const response = routeResponse();
  const { gateway, audits, bypasses } = harness(provider(async () => response));
  expect(await gateway.evaluate(context, route)).toEqual(response);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    requestedMode: "jev",
    selectedMode: "jev",
    response: { model: "jev-1.13.0", durationMs: 42, usage: { inputTokens: 30, outputTokens: 8 } },
  });
  expect(audits[0]?.requestStateHash).toMatch(/^[a-f0-9]{64}$/);
  expect(bypasses).toEqual([]);
});

test("explicit deterministic bypass emits an event and records its reason", async () => {
  const { gateway, audits, bypasses } = harness(
    provider(async () => {
      throw new Error("must not call Jev");
    }),
  );
  const response = await gateway.evaluate(
    { ...context, mode: "deterministic", reason: "controlled comparison" },
    route,
  );
  expect(response.model).toBe("deterministic-bypass");
  expect(bypasses).toEqual([{ runId: "run-1", reason: "controlled comparison" }]);
  expect(audits[0]).toMatchObject({
    requestedMode: "deterministic",
    selectedMode: "deterministic",
    fallbackReason: "controlled comparison",
  });
});

test("only exhausted transient Jev failures use the configured fallback", async () => {
  const { gateway, audits, bypasses } = harness(
    provider(async () => {
      throw new JevUnavailableError("temporary", 503);
    }),
  );
  const response = await gateway.evaluate(context, route);
  expect(response.model).toBe("deterministic-bypass");
  expect(bypasses).toEqual([{ runId: "run-1", reason: "jev-unavailable" }]);
  expect(audits[0]).toMatchObject({
    requestedMode: "jev",
    selectedMode: "deterministic",
    fallbackReason: "jev-unavailable",
  });
  const invalid = harness(
    provider(async () => {
      throw new Error("malformed response");
    }),
  );
  await expect(invalid.gateway.evaluate(context, route)).rejects.toThrow("malformed response");
  expect(invalid.bypasses).toEqual([]);
  expect(invalid.audits[0]?.errorCode).toBe("jev-invalid");
});

test("low confidence records the Jev answer and requests a human when configured", async () => {
  const response = routeResponse(0.3);
  const { gateway, audits, bypasses } = harness(
    provider(async () => response),
    "ask-user",
  );
  const outcome = gateway.evaluate(context, route);
  await expect(outcome).rejects.toBeInstanceOf(DecisionHandoffError);
  await expect(outcome).rejects.toThrow("low-confidence");
  expect(audits[0]).toMatchObject({ selectedMode: "jev", fallbackReason: "low-confidence", response });
  expect(bypasses).toEqual([]);
});

test("typed policy keeps routing and completion authority in TypeScript", async () => {
  const routeDecision = normalizeRouteDecision(routeResponse(), routing);
  expect(routeDecision.selectedAgent).toBe("implementer");
  expect(selectInitialAgent(routeDecision, { routing })).toBe("implementer");
  expect(selectInitialAgent({ ...routeDecision, requirementsClear: 0.1 }, { routing })).toBe("ask-user");

  const deterministic = new DeterministicDecisionProvider();
  const completion = normalizeCompletionDecision(await deterministic.evaluate(completionRequest("Checks failed")));
  const run = {
    id: "run-1",
    currentStep: 8,
    budget: { workerCalls: 1, inputTokens: 100, outputTokens: 10, elapsedMs: 1 },
  } as HarnessRun;
  const verification = { ok: true, commands: [], gitDiffStat: "", filesChanged: [] } satisfies VerificationResult;
  const config = {
    routing,
    limits: { maxSteps: 8, maxWorkerCalls: 5, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxElapsedMs: 60_000 },
  };
  const beforeReview = { reviewCompletedForAttempt: false, editsSinceReview: false };
  expect(selectNextAction(completion, verification, run, config, beforeReview)).toBe("fail");
  const activeRun = { ...run, currentStep: 1 };
  expect(selectNextAction(completion, { ...verification, ok: false }, activeRun, config, beforeReview)).toBe("review");
  expect(
    selectNextAction(completion, verification, activeRun, config, {
      reviewCompletedForAttempt: true,
      editsSinceReview: false,
    }),
  ).toBe("ask-user");
  expect(
    selectNextAction(completion, verification, activeRun, config, {
      reviewCompletedForAttempt: true,
      editsSinceReview: true,
    }),
  ).toBe("review");
  const satisfied = {
    ...completion,
    requirementsSatisfied: 0.95,
    implementationRiskScore: 1,
    moreWorkUseful: 0.1,
    needsIndependentReview: 0.1,
    nextAction: "done" as const,
  };
  const spent = { ...activeRun, budget: { ...activeRun.budget, elapsedMs: 60_000 } };
  expect(selectNextAction(satisfied, verification, spent, config, beforeReview)).toBe("done");
  // Failed verification never completes the run, whether or not budget remains.
  expect(selectNextAction(satisfied, { ...verification, ok: false }, spent, config, beforeReview)).toBe("ask-user");
  expect(selectNextAction(satisfied, { ...verification, ok: false }, activeRun, config, beforeReview)).toBe("ask-user");
  expect(
    selectNextAction(
      { ...satisfied, moreWorkUseful: 0.9 },
      { ...verification, ok: false },
      spent,
      config,
      beforeReview,
    ),
  ).toBe("fail");
  // A failed worker call never completes the run: a failed implementation retries while it can.
  const failedImplementation = { ...beforeReview, failedCall: "implementation" as const };
  expect(selectNextAction(satisfied, verification, activeRun, config, failedImplementation)).toBe("retry");
  expect(
    selectNextAction(satisfied, verification, activeRun, config, { ...failedImplementation, retryAvailable: false }),
  ).toBe("ask-user");
  expect(selectNextAction(satisfied, verification, spent, config, failedImplementation)).toBe("ask-user");
  expect(selectNextAction(satisfied, verification, activeRun, config, { ...beforeReview, failedCall: "review" })).toBe(
    "ask-user",
  );
  expect(exhaustedBudget(spent, config.limits)).toBe("time-limit");
});

test("the token limit counts uncached input only", () => {
  const limits = {
    maxSteps: 8,
    maxWorkerCalls: 5,
    maxInputTokens: 100_000,
    maxOutputTokens: 5_000,
    maxElapsedMs: 60_000,
  };
  const spend = (budget: object) =>
    ({
      id: "run-1",
      currentStep: 1,
      budget: { workerCalls: 1, outputTokens: 10, elapsedMs: 1, ...budget },
    }) as HarnessRun;
  expect(exhaustedBudget(spend({ inputTokens: 1_287_980, cachedInputTokens: 1_214_976 }), limits)).toBeUndefined();
  expect(exhaustedBudget(spend({ inputTokens: 200_000, cachedInputTokens: 100_000 }), limits)).toBe("token-limit");
  // Budgets stored before cached input was recorded behave as before.
  expect(exhaustedBudget(spend({ inputTokens: 99_999 }), limits)).toBeUndefined();
  expect(exhaustedBudget(spend({ inputTokens: 100_000 }), limits)).toBe("token-limit");
});

test("the output token limit counts reported output tokens", () => {
  const limits = {
    maxSteps: 8,
    maxWorkerCalls: 5,
    maxInputTokens: 100_000,
    maxOutputTokens: 5_000,
    maxElapsedMs: 60_000,
  };
  const spend = (outputTokens: number) =>
    ({
      id: "run-1",
      currentStep: 1,
      budget: { workerCalls: 1, inputTokens: 10, outputTokens, elapsedMs: 1 },
    }) as HarnessRun;
  expect(exhaustedBudget(spend(4_999), limits)).toBeUndefined();
  expect(exhaustedBudget(spend(5_000), limits)).toBe("output-token-limit");
});

test("uncachedInputTokens clamps at zero and treats missing fields as zero", () => {
  expect(uncachedInputTokens({ inputTokens: 100, cachedInputTokens: 30 })).toBe(70);
  expect(uncachedInputTokens({ inputTokens: 100, cachedInputTokens: 150 })).toBe(0);
  expect(uncachedInputTokens({ inputTokens: 100 })).toBe(100);
  expect(uncachedInputTokens({ cachedInputTokens: 5 })).toBe(0);
  expect(uncachedInputTokens({})).toBe(0);
});
