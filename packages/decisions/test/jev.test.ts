import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DecisionRequest, DecisionResponse } from "@adaptive-harness/core";
import { JevHttpProvider, JevResponseError, JevUnavailableError } from "../src/jev.ts";

const request: DecisionRequest = {
  state: "A focused coding objective",
  questions: {
    kind: {
      type: "choice",
      instructions: "Choose the task kind",
      criteria: { implementation: "Code", review: "Review" },
    },
    complexity: { type: "score", instructions: "Rate complexity", criteria: ["Low", "Medium", "High"] },
    clear: { type: "noul", instructions: "Is this clear?" },
  },
};
function fixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: {
      kind: {
        type: "choice",
        choice: "implementation",
        probabilities: { implementation: 0.9, review: 0.1 },
        confidence: 0.8,
      },
      complexity: {
        type: "score",
        score: 1.1,
        legend: { "0": "Low", "1": "Medium", "2": "High" },
        probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
        confidence: 0.6,
      },
      clear: { type: "noul", noul: 0.95 },
    },
    usage: { input_tokens: 24, output_tokens: 13 },
    ...extra,
  };
}
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

test("validates a sanitized response recorded from the live Jev API", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/route-response.json", import.meta.url), "utf8")) as {
    request: DecisionRequest;
    response: {
      model: string;
      answers: DecisionResponse["answers"];
      usage: { input_tokens: number; output_tokens: number };
    };
  };
  const provider = new JevHttpProvider({ apiKey: "fixture-key", fetch: async () => response(fixture.response) });
  const result = await provider.evaluate(fixture.request);
  expect(result.model).toBe(fixture.response.model);
  expect(result.answers).toEqual(fixture.response.answers);
  expect(result.usage).toEqual({
    inputTokens: fixture.response.usage.input_tokens,
    outputTokens: fixture.response.usage.output_tokens,
  });
});

test("POSTs official request shape and validates typed answers and usage", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return response(fixture({ echo: "secret-key" }));
  };
  const provider = new JevHttpProvider({ apiKey: "secret-key", fetch: mockFetch });
  expect(await provider.preflight()).toEqual({ ok: true, details: ["Jev API key configured"] });
  const result = await provider.evaluate(request);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(calls[0]?.init.method).toBe("POST");
  expect(calls[0]?.init.redirect).toBe("error");
  expect(calls[0]?.init.headers).toEqual({ Authorization: "Bearer secret-key", "Content-Type": "application/json" });
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
    state: request.state,
    model: "jev-latest",
    questions: request.questions,
  });
  expect(result.model).toBe("jev-1.13.0");
  expect(result.answers.kind).toEqual({
    type: "choice",
    choice: "implementation",
    probabilities: { implementation: 0.9, review: 0.1 },
    confidence: 0.8,
  });
  expect(result.answers.complexity?.type).toBe("score");
  expect(result.answers.clear).toEqual({ type: "noul", noul: 0.95 });
  expect(result.usage).toEqual({ inputTokens: 24, outputTokens: 13 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(result.raw)).not.toContain("secret-key");
});

test("rejects insecure or credential-bearing endpoints before sending a key", () => {
  for (const endpoint of [
    "http://api.typesafe.ai/v1/systemone",
    "javascript:alert(1)",
    "https://user:password@api.typesafe.ai/v1/systemone",
    "not-a-url",
  ]) {
    expect(() => new JevHttpProvider({ endpoint, apiKey: "secret-key" })).toThrow("Jev endpoint must be");
  }
});

test("does not follow an HTTP redirect or send the key to its destination", async () => {
  const calls: string[] = [];
  const provider = new JevHttpProvider({
    apiKey: "secret-key",
    maxRetries: 2,
    fetch: async (input, init) => {
      calls.push(String(input));
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/collect" } });
    },
  });
  const failure = provider.evaluate(request);
  await expect(failure).rejects.toBeInstanceOf(JevResponseError);
  await expect(failure).rejects.toThrow("HTTP 302");
  expect(calls).toEqual(["https://api.typesafe.ai/v1/systemone"]);
});

test("retries 429 and 529 with exponential backoff, then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const provider = new JevHttpProvider({
    apiKey: "key",
    maxRetries: 2,
    fetch: async () => {
      calls++;
      return calls === 1
        ? response({ error: "rate limited" }, 429)
        : calls === 2
          ? response({ error: "overloaded" }, 529)
          : response(fixture());
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  expect((await provider.evaluate(request)).model).toBe("jev-1.13.0");
  expect(calls).toBe(3);
  expect(sleeps).toEqual([100, 200]);
});

test("retries transient network errors but not 401 or malformed successful responses", async () => {
  let calls = 0;
  const transient = new JevHttpProvider({
    apiKey: "key",
    maxRetries: 1,
    fetch: async () => {
      calls++;
      if (calls === 1) throw new TypeError("connection reset");
      return response(fixture());
    },
    sleep: async () => undefined,
  });
  expect((await transient.evaluate(request)).model).toBe("jev-1.13.0");
  expect(calls).toBe(2);
  calls = 0;
  const unauthorized = new JevHttpProvider({
    apiKey: "secret-key",
    maxRetries: 2,
    fetch: async () => {
      calls++;
      return response({ message: "secret-key invalid" }, 401);
    },
    sleep: async () => undefined,
  });
  const unauthorizedFailure = unauthorized.evaluate(request);
  await expect(unauthorizedFailure).rejects.toThrow("HTTP 401");
  await expect(unauthorizedFailure).rejects.toBeInstanceOf(JevResponseError);
  expect(calls).toBe(1);
  calls = 0;
  const malformed = new JevHttpProvider({
    apiKey: "key",
    maxRetries: 2,
    fetch: async () => {
      calls++;
      return response(fixture({ answers: { clear: { type: "noul", noul: 2 } } }));
    },
    sleep: async () => undefined,
  });
  await expect(malformed.evaluate(request)).rejects.toThrow("questions do not match");
  expect(calls).toBe(1);
});

test("classifies exhausted transient HTTP errors as unavailability", async () => {
  let calls = 0;
  const provider = new JevHttpProvider({
    apiKey: "key",
    maxRetries: 1,
    fetch: async () => {
      calls++;
      return response({ error: "temporary" }, 503);
    },
    sleep: async () => undefined,
  });
  await expect(provider.evaluate(request)).rejects.toBeInstanceOf(JevUnavailableError);
  expect(calls).toBe(2);
});

test("rejects invalid typed values and oversized responses", async () => {
  const badProbability = fixture();
  ((badProbability.answers as Record<string, unknown>).kind as Record<string, unknown>).probabilities = {
    implementation: 0.2,
    review: 0.2,
  };
  const provider = new JevHttpProvider({
    apiKey: "key",
    fetch: async () => response(badProbability),
  });
  await expect(provider.evaluate(request)).rejects.toThrow("probability total");
  const huge = new JevHttpProvider({
    apiKey: "key",
    fetch: async () => new Response("x".repeat(256_001)),
  });
  await expect(huge.evaluate(request)).rejects.toThrow("size limit");
  const echoedKey = new JevHttpProvider({
    apiKey: "secret-key",
    fetch: async () => response(fixture({ model: "secret-key" })),
  });
  await expect(echoedKey.evaluate(request)).rejects.toThrow("Invalid Jev model");
});

test("rejects choice and score values inconsistent with their distributions", async () => {
  const wrongChoice = fixture();
  ((wrongChoice.answers as Record<string, unknown>).kind as Record<string, unknown>).choice = "review";
  const choiceProvider = new JevHttpProvider({ apiKey: "key", fetch: async () => response(wrongChoice) });
  await expect(choiceProvider.evaluate(request)).rejects.toThrow("highest probability");

  const wrongScore = fixture();
  const score = (wrongScore.answers as Record<string, unknown>).complexity as Record<string, unknown>;
  score.score = 0;
  score.probabilities = { "0": 0, "1": 0, "2": 1 };
  const scoreProvider = new JevHttpProvider({ apiKey: "key", fetch: async () => response(wrongScore) });
  await expect(scoreProvider.evaluate(request)).rejects.toThrow("probability-weighted mean");

  const tiedChoice = fixture();
  const choice = (tiedChoice.answers as Record<string, unknown>).kind as Record<string, unknown>;
  choice.choice = "review";
  choice.probabilities = { implementation: 0.5, review: 0.5 };
  const tieProvider = new JevHttpProvider({ apiKey: "key", fetch: async () => response(tiedChoice) });
  expect((await tieProvider.evaluate(request)).answers.kind?.type).toBe("choice");
});

test("times out each attempt and reports a secret-safe generic network error", async () => {
  let calls = 0;
  const provider = new JevHttpProvider({
    apiKey: "secret-key",
    timeoutMs: 5,
    maxRetries: 1,
    fetch: async (_url, init) => {
      calls++;
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
      throw new Error("unreachable");
    },
    sleep: async () => undefined,
  });
  let message = "";
  try {
    await provider.evaluate(request);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("Jev network request failed");
  expect(message).not.toContain("secret-key");
  expect(calls).toBe(2);
});
