import { randomUUID } from "node:crypto";
import type {
  DecisionAnswer,
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
  ProviderPreflight,
} from "@adaptive-harness/core";

export interface JevHttpOptions {
  endpoint?: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

export class JevUnavailableError extends Error {
  override name = "JevUnavailableError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class JevResponseError extends Error {
  override name = "JevResponseError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_RESPONSE_BYTES = 256_000;
const MAX_STATE_CHARACTERS = 32_000;
const MAX_QUESTIONS = 32;
const MAX_RAW_STRING = 16_000;
/**
 * Jev reports probabilities and scores to two decimals, so each may be off by up to half a hundredth. Comparisons
 * add `Number.EPSILON` so a difference exactly at the bound is not rejected by floating-point subtraction error.
 */
const PROBABILITY_ROUNDING = 0.005;
const MIN_TOLERANCE = 0.02;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Jev response shape");
  return value as Record<string, unknown>;
}
function finiteBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validateProbabilities(value: unknown, expectedKeys: string[]): Record<string, number> {
  const probabilities = record(value);
  if (
    Object.keys(probabilities).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(probabilities, key))
  ) {
    throw new Error("Invalid Jev probability keys");
  }
  let total = 0;
  for (const key of expectedKeys) {
    const probability = probabilities[key];
    if (!finiteBetween(probability, 0, 1)) throw new Error("Invalid Jev probability value");
    total += probability;
  }
  const totalTolerance = Math.max(MIN_TOLERANCE, PROBABILITY_ROUNDING * expectedKeys.length);
  if (Math.abs(total - 1) > totalTolerance + Number.EPSILON) throw new Error("Invalid Jev probability total");
  return probabilities as Record<string, number>;
}
function validateAnswer(value: unknown, question: DecisionQuestion): DecisionAnswer {
  const answer = record(value);
  if (answer.type !== question.type) throw new Error("Jev answer type does not match question");
  if (question.type === "noul") {
    if (!finiteBetween(answer.noul, 0, 1)) throw new Error("Invalid Jev noul answer");
    return { type: "noul", noul: answer.noul };
  }
  if (!finiteBetween(answer.confidence, 0, 1)) throw new Error("Invalid Jev confidence");
  if (question.type === "choice") {
    const keys = Object.keys(question.criteria);
    if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
      throw new Error("Invalid Jev choice");
    }
    const probabilities = validateProbabilities(answer.probabilities, keys);
    const choiceProbability = probabilities[answer.choice];
    if (choiceProbability === undefined || choiceProbability < Math.max(...Object.values(probabilities))) {
      throw new Error("Jev choice does not match highest probability");
    }
    return {
      type: "choice",
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities,
    };
  }
  const keys = question.criteria.map((_, index) => String(index));
  if (!finiteBetween(answer.score, 0, question.criteria.length - 1)) throw new Error("Invalid Jev score");
  const legend = record(answer.legend);
  if (
    Object.keys(legend).length !== keys.length ||
    keys.some((key, index) => legend[key] !== question.criteria[index])
  ) {
    throw new Error("Invalid Jev score legend");
  }
  const probabilities = validateProbabilities(answer.probabilities, keys);
  const weightedScore = keys.reduce((sum, key, index) => sum + index * (probabilities[key] ?? 0), 0);
  // Jev computes the score from unrounded probabilities. Each probability's rounding error is weighted by its
  // index, and the `+ 1` covers the rounding of the score itself.
  const indexTotal = keys.reduce((sum, _, index) => sum + index, 0);
  const scoreTolerance = Math.max(MIN_TOLERANCE, PROBABILITY_ROUNDING * (indexTotal + 1));
  if (Math.abs(answer.score - weightedScore) > scoreTolerance + Number.EPSILON) {
    throw new Error("Jev score does not match probability-weighted mean");
  }
  return {
    type: "score",
    score: answer.score,
    confidence: answer.confidence,
    probabilities,
    legend: legend as Record<string, string>,
  };
}
function validateResponse(
  value: unknown,
  request: DecisionRequest,
  durationMs: number,
  apiKey: string,
): DecisionResponse {
  const body = record(value);
  if (
    typeof body.model !== "string" ||
    body.model.length === 0 ||
    body.model.length > 256 ||
    body.model.includes(apiKey)
  ) {
    throw new Error("Invalid Jev model");
  }
  const answers = record(body.answers);
  const questionKeys = Object.keys(request.questions);
  if (Object.keys(answers).length !== questionKeys.length || questionKeys.some((key) => !Object.hasOwn(answers, key))) {
    throw new Error("Jev response questions do not match request");
  }
  const normalized: Record<string, DecisionAnswer> = {};
  for (const key of questionKeys) {
    const question = request.questions[key];
    if (!question) throw new Error("Missing Jev question");
    normalized[key] = validateAnswer(answers[key], question);
  }
  const usage = record(body.usage);
  if (!nonnegativeInteger(usage.input_tokens) || !nonnegativeInteger(usage.output_tokens)) {
    throw new Error("Invalid Jev usage");
  }
  return {
    id: randomUUID(),
    model: body.model,
    answers: normalized,
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    durationMs,
    raw: redactRaw(body, apiKey),
  };
}
function redactRaw(value: unknown, apiKey: string, depth = 0): unknown {
  if (depth > 10) return "[TRUNCATED]";
  if (typeof value === "string") return value.split(apiKey).join("[REDACTED]").slice(0, MAX_RAW_STRING);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactRaw(item, apiKey, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [key.split(apiKey).join("[REDACTED]"), redactRaw(item, apiKey, depth + 1)]),
    );
  }
  return value;
}
async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("Jev response exceeds size limit");
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
function validateRequest(request: DecisionRequest): void {
  if (!request.state || request.state.length > MAX_STATE_CHARACTERS) {
    throw new Error("Jev state must be 1 to 32000 characters");
  }
  const questions = Object.values(request.questions);
  if (questions.length < 1 || questions.length > MAX_QUESTIONS) throw new Error("Jev needs 1 to 32 questions");
  for (const question of questions) {
    if (!question.instructions) throw new Error("Jev question needs instructions");
    if (
      question.type === "choice" &&
      (Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255)
    ) {
      throw new Error("Jev choice needs 2 to 255 options");
    }
    if (question.type === "score" && (question.criteria.length < 2 || question.criteria.length > 10)) {
      throw new Error("Jev score needs 2 to 10 levels");
    }
  }
}
function retryableStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status <= 599);
}
function transientNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
  );
}
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class JevHttpProvider implements DecisionProvider {
  readonly kind = "jev" as const;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: JevHttpOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    } catch {
      throw new Error("Jev endpoint must be an HTTPS URL");
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      throw new Error("Jev endpoint must be HTTPS without URL credentials");
    }
    this.#endpoint = endpoint.toString();
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? "jev-latest";
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) throw new Error("Invalid Jev timeout");
    if (!Number.isSafeInteger(this.#maxRetries) || this.#maxRetries < 0 || this.#maxRetries > 5) {
      throw new Error("Jev maxRetries must be 0 to 5");
    }
  }

  async preflight(): Promise<ProviderPreflight> {
    return {
      ok: this.#apiKey.length > 0,
      details: this.#apiKey ? ["Jev API key configured"] : ["Jev API key missing"],
    };
  }

  async evaluate(request: DecisionRequest): Promise<DecisionResponse> {
    if (!this.#apiKey) throw new Error("Jev API key is not configured");
    validateRequest(request);
    const startedAt = performance.now();
    const body = JSON.stringify({ state: request.state, model: this.#model, questions: request.questions });
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        if (attempt < this.#maxRetries && transientNetworkError(error)) {
          await this.#sleep(Math.min(100 * 2 ** attempt, 1_000));
          continue;
        }
        if (transientNetworkError(error)) throw new JevUnavailableError("Jev network request failed");
        throw new JevResponseError("Jev request failed before a response");
      }
      if (!response.ok) {
        if (attempt < this.#maxRetries && retryableStatus(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          await this.#sleep(Math.min(100 * 2 ** attempt, 1_000));
          continue;
        }
        const message = `Jev request failed with HTTP ${response.status}`;
        if (retryableStatus(response.status)) throw new JevUnavailableError(message, response.status);
        throw new JevResponseError(message, response.status);
      }
      let text: string;
      try {
        text = await readBounded(response);
      } catch (error) {
        if (transientNetworkError(error) && attempt < this.#maxRetries) {
          await this.#sleep(Math.min(100 * 2 ** attempt, 1_000));
          continue;
        }
        if (transientNetworkError(error)) throw new JevUnavailableError("Jev response stream failed");
        throw new JevResponseError("Jev response exceeds size limit");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new JevResponseError("Jev returned invalid JSON");
      }
      try {
        return validateResponse(parsed, request, Math.round(performance.now() - startedAt), this.#apiKey);
      } catch (error) {
        if (error instanceof Error) throw new JevResponseError(error.message);
        throw new JevResponseError("Invalid Jev response");
      }
    }
    throw new JevUnavailableError("Jev request exhausted retries");
  }
}
