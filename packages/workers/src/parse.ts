import type { Usage, WorkerReport } from "@adaptive-harness/core";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function safeString(value: unknown, max = 4000): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

export function reportFrom(value: unknown): WorkerReport | undefined {
  const object = record(value);
  if (!object || typeof object.summary !== "string" || typeof object.completed !== "boolean") return;
  const strings = (input: unknown) =>
    Array.isArray(input)
      ? input
          .filter((v): v is string => typeof v === "string")
          .slice(0, 50)
          .map((v) => v.slice(0, 1000))
      : [];
  return {
    summary: object.summary.slice(0, 8000),
    completed: object.completed,
    filesChanged: [], // Git, rather than provider claims, supplies this field.
    checksRun: strings(object.checksRun),
    concerns: strings(object.concerns),
    ...(typeof object.requestedHelp === "string" ? { requestedHelp: object.requestedHelp.slice(0, 2000) } : {}),
  };
}

export function redact(value: string, environment: Record<string, string>): string {
  let result = value;
  for (const secret of Object.values(environment).filter((v) => v.length >= 4))
    result = result.replaceAll(secret, "[REDACTED]");
  return result;
}

/** The redacted end of a failed provider's stderr, on one line, where CLIs usually explain the failure. */
export function stderrTail(stderr: string, environment: Record<string, string>): string {
  const text = redact(stderr, environment)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips CSI and OSC terminal escapes and control characters.
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 500 ? `…${text.slice(-500)}` : text;
}

export function usageFrom(value: unknown): Usage | undefined {
  const object = record(value);
  if (!object) return;
  const usage: Usage = {};
  for (const [source, target] of [
    ["input_tokens", "inputTokens"],
    ["cached_input_tokens", "cachedInputTokens"],
    ["output_tokens", "outputTokens"],
    ["inputTokens", "inputTokens"],
    ["outputTokens", "outputTokens"],
  ] as const) {
    const number = object[source];
    if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) usage[target] = number;
  }
  return Object.keys(usage).length ? usage : undefined;
}
