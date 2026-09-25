import type { VerificationCommandResult } from "@adaptive-harness/core";

/** Structural match for a configured verification command. */
export interface VerificationCommand {
  name: string;
  command: string;
  args: string[];
  timeoutMs: number;
  env: Record<string, string>;
}
export type VerificationStatus = "passed" | "failed" | "timed-out" | "spawn-error" | "cancelled" | "telemetry-error";

export interface VerificationCommandOutcome extends VerificationCommandResult {
  status: VerificationStatus;
  outputTruncated: boolean;
  error?: string;
}

export interface VerificationCommandsResult {
  ok: boolean;
  commands: VerificationCommandOutcome[];
}

export interface VerificationOutputChunk {
  name: string;
  stream: "stdout" | "stderr";
  /** Full stream content, with configured secret values redacted. */
  chunk: string;
}

export interface VerificationOptions {
  stopOnFailure?: boolean;
  /** Maximum UTF-8 bytes retained per stream in each decision result. */
  maxDecisionOutputBytes?: number;
  /** Receives the full redacted output incrementally for optional telemetry. */
  onOutput?: (output: VerificationOutputChunk) => void | Promise<void>;
  /** Additional secret values to redact from both decision and telemetry output. */
  redactValues?: string[];
  /** Environment variable names whose inherited or overridden values must be redacted. */
  redactEnvironment?: string[];
  signal?: AbortSignal;
}

const DEFAULT_DECISION_BYTES = 8_000;
const REDACTED = "[REDACTED]";

function boundedTail(value: string, limit: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) return { text: value, truncated: false };
  const tail = bytes.subarray(bytes.byteLength - limit);
  return { text: new TextDecoder().decode(tail), truncated: true };
}

/** Holds only the suffix needed to detect secrets split across process chunks. */
class StreamRedactor {
  private pending = "";
  private readonly secrets: string[];
  private readonly maxSecretLength: number;

  constructor(values: string[]) {
    this.secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
    this.maxSecretLength = Math.max(1, ...this.secrets.map((value) => value.length));
  }

  write(chunk: string, final = false): string {
    if (this.secrets.length === 0) return chunk;
    this.pending += chunk;
    let output = "";
    const safeLimit = final ? this.pending.length : Math.max(0, this.pending.length - this.maxSecretLength + 1);
    let cursor = 0;
    while (cursor < safeLimit) {
      let nextIndex = this.pending.length;
      let nextSecret = "";
      for (const secret of this.secrets) {
        const index = this.pending.indexOf(secret, cursor);
        if (index >= 0 && index < nextIndex) {
          nextIndex = index;
          nextSecret = secret;
        }
      }
      if (nextIndex >= safeLimit) {
        output += this.pending.slice(cursor, safeLimit);
        cursor = safeLimit;
      } else {
        output += this.pending.slice(cursor, nextIndex) + REDACTED;
        cursor = nextIndex + nextSecret.length;
      }
    }
    this.pending = this.pending.slice(cursor);
    return output;
  }
}

async function runOne(
  command: VerificationCommand,
  workspace: string,
  options: VerificationOptions,
  limit: number,
): Promise<VerificationCommandOutcome> {
  const started = performance.now();
  const secrets = [
    ...Object.values(command.env),
    ...(options.redactValues ?? []),
    ...(options.redactEnvironment ?? []).map((name) => command.env[name] ?? process.env[name] ?? ""),
  ].filter(Boolean);
  const redact = (value: string) => secrets.reduce((output, secret) => output.replaceAll(secret, REDACTED), value);
  const base = { name: redact(command.name), command: redact(command.command), args: command.args.map(redact) };
  if (options.signal?.aborted) {
    return {
      ...base,
      status: "cancelled",
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "",
      outputTruncated: false,
    };
  }

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([command.command, ...command.args], {
      cwd: workspace,
      env: { ...process.env, ...command.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
  } catch {
    return {
      ...base,
      status: "spawn-error",
      error: "Could not start verification command",
      exitCode: null,
      timedOut: false,
      durationMs: performance.now() - started,
      stdout: "",
      stderr: "",
      outputTruncated: false,
    };
  }

  let status: VerificationStatus | undefined;
  const terminate = (reason: VerificationStatus) => {
    if (status) return;
    status = reason;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the signal and the fallback.
      }
    }
  };
  const timer = setTimeout(() => terminate("timed-out"), command.timeoutMs);
  const onAbort = () => terminate("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const readStream = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") => {
    const decoder = new TextDecoder();
    const redactor = new StreamRedactor(secrets);
    const reader = stream.getReader();
    let retained = "";
    let truncated = false;
    const publish = async (chunk: string) => {
      if (!chunk) return;
      const next = boundedTail(retained + chunk, limit);
      retained = next.text;
      truncated ||= next.truncated;
      await options.onOutput?.({ name: base.name, stream: name, chunk });
    };
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      await publish(redactor.write(decoder.decode(next.value, { stream: true })));
    }
    await publish(redactor.write(decoder.decode(), true));
    return { text: retained, truncated };
  };

  const stdout = readStream(child.stdout as ReadableStream<Uint8Array>, "stdout");
  const stderr = readStream(child.stderr as ReadableStream<Uint8Array>, "stderr");
  try {
    const [out, err, exitCode] = await Promise.all([stdout, stderr, child.exited]);
    const finalStatus = status ?? (exitCode === 0 ? "passed" : "failed");
    return {
      ...base,
      status: finalStatus,
      exitCode,
      timedOut: finalStatus === "timed-out",
      durationMs: performance.now() - started,
      stdout: out.text,
      stderr: err.text,
      outputTruncated: out.truncated || err.truncated,
    };
  } catch {
    terminate("telemetry-error");
    const settled = await Promise.allSettled([stdout, stderr, child.exited]);
    return {
      ...base,
      status: "telemetry-error",
      error: "Could not retain verification output",
      exitCode: settled[2]?.status === "fulfilled" ? settled[2].value : null,
      timedOut: false,
      durationMs: performance.now() - started,
      stdout: "",
      stderr: "",
      outputTruncated: false,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Run configured commands directly, preserving each command's result. */
export async function runVerificationCommands(
  commands: VerificationCommand[],
  workspace: string,
  options: VerificationOptions = {},
): Promise<VerificationCommandsResult> {
  const limit = options.maxDecisionOutputBytes ?? DEFAULT_DECISION_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid decision output limit");
  const results: VerificationCommandOutcome[] = [];
  for (const command of commands) {
    const result = await runOne(command, workspace, options, limit);
    results.push(result);
    if (options.stopOnFailure && result.status !== "passed") break;
    if (result.status === "cancelled") break;
  }
  return { ok: results.every((result) => result.status === "passed"), commands: results };
}
