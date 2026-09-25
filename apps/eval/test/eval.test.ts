import { expect, test } from "bun:test";
import type { DecisionAnswer, DecisionProvider, DecisionRequest } from "@adaptive-harness/core";
import { formatReport } from "../src/main.ts";
import { runEval } from "../src/runner.ts";
import { EVAL_TASKS } from "../src/tasks.ts";

const choice = (value: string): DecisionAnswer => ({
  type: "choice",
  choice: value,
  confidence: 0.95,
  probabilities: { [value]: 0.95 },
});
const score = (value: number): DecisionAnswer => ({ type: "score", score: value, confidence: 0.95, probabilities: {} });
const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

/** A confident stand-in for Jev: routes to implementation, retries failed checks, and accepts passing work. */
function fakeJev() {
  const requests: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    kind: "jev",
    preflight: async () => ({ ok: true, details: [] }),
    evaluate: async (request) => {
      requests.push(request);
      const latestCheck = request.state.slice(request.state.lastIndexOf("(test-result;"));
      const failed = /"exitCode":(?!0\b)/.test(latestCheck);
      const answers = Object.hasOwn(request.questions, "task_kind")
        ? {
            task_kind: choice("implementation"),
            complexity: score(0),
            requirements_clear: noul(0.95),
            external_research_needed: noul(0),
          }
        : {
            requirements_satisfied: noul(failed ? 0.2 : 0.95),
            implementation_risk: score(0),
            more_work_useful: noul(failed ? 0.9 : 0.05),
            independent_review_needed: noul(0),
            next_action: choice(failed ? "retry" : "done"),
          };
      return { id: crypto.randomUUID(), model: "jev-test", answers, usage: {}, durationMs: 1, raw: {} };
    },
  };
  return { provider, requests };
}

// Each task creates Git repositories and runs verification processes, so these tests need more than the default timeout.
const pick = (...ids: string[]) => EVAL_TASKS.filter((task) => ids.includes(task.id));

test("every task's scripted solution passes its verification", async () => {
  const report = await runEval({
    tasks: EVAL_TASKS,
    arms: ["deterministic"],
    provider: "codex",
    liveWorkers: false,
    env: {},
  });
  expect(report.results.filter((result) => !result.verified).map((result) => result.task)).toEqual([]);
  expect(report.usageEstimated).toBe(true);
}, 60_000);

test("both arms run the same simulated tasks and report comparable metrics", async () => {
  const jev = fakeJev();
  const report = await runEval({
    tasks: pick("settings-port", "notes-typo"),
    arms: ["jev", "deterministic"],
    provider: "cursor",
    liveWorkers: false,
    env: {},
    jev: jev.provider,
  });
  expect(report.skipped).toEqual([]);
  expect(report.results.map((result) => [result.task, result.arm, result.verified])).toEqual([
    ["notes-typo", "jev", true],
    ["notes-typo", "deterministic", true],
    ["settings-port", "jev", true],
    ["settings-port", "deterministic", true],
  ]);
  expect(jev.requests.length).toBeGreaterThan(0);

  const [withJev, deterministic] = report.summaries;
  expect(withJev).toMatchObject({ arm: "jev", tasks: 2, verified: 2, interventions: 0, reviewCalls: 0 });
  // The deterministic bypass asks for clarification and completion, and requests review of every attempt.
  expect(deterministic).toMatchObject({ arm: "deterministic", tasks: 2, verified: 2 });
  expect(deterministic?.reviewCalls).toBeGreaterThanOrEqual(2);
  expect(deterministic?.interventions).toBeGreaterThanOrEqual(4);
  // The partial first attempt of notes-typo fails verification and is retried in both arms.
  expect(report.results.filter((result) => result.task === "notes-typo").every((result) => result.retries >= 1)).toBe(
    true,
  );
  expect(withJev?.inputTokens).toBeGreaterThan(0);
  expect(withJev?.inputTokens).toBeLessThan(deterministic?.inputTokens ?? 0);
  expect(formatReport(report)).toContain("simulated cursor (usage estimated)");
}, 30_000);

test("the Jev arm is skipped without an API key", async () => {
  const report = await runEval({
    tasks: pick("settings-port"),
    arms: ["jev"],
    provider: "codex",
    liveWorkers: false,
    env: {},
  });
  expect(report.results).toEqual([]);
  expect(report.skipped).toEqual([{ arm: "jev", reason: expect.stringContaining("TYPESAFE_API_KEY") }]);
});
