import { expect, test } from "bun:test";
import { JevHttpProvider } from "../src/jev.ts";
import { routeRequest } from "../src/questions.ts";

const liveTest = process.env.JEV_LIVE_SMOKE === "1" ? test : test.skip;

liveTest("opt-in Jev route smoke", async () => {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("JEV_LIVE_SMOKE requires TYPESAFE_API_KEY");
  const provider = new JevHttpProvider({ apiKey, timeoutMs: 15_000, maxRetries: 1 });
  const response = await provider.evaluate(
    routeRequest("A small, clear coding task: rename one local helper and run the existing unit tests."),
  );
  expect(response.model).toStartWith("jev-");
  expect(response.answers.task_kind?.type).toBe("choice");
  expect(response.answers.complexity?.type).toBe("score");
  expect(response.usage.inputTokens).toBeGreaterThan(0);
  console.log(
    `Jev smoke passed: model=${response.model}; inputTokens=${response.usage.inputTokens}; outputTokens=${response.usage.outputTokens}`,
  );
});
