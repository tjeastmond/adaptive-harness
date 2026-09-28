import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderPreflight,
  Usage,
  WorkerAdapter,
  WorkerReport,
  WorkerRequest,
  WorkerResult,
  WorkerStreamEvent,
} from "@adaptive-harness/core";
import { BoundedJsonlParser } from "./jsonl.ts";
import { runProcess } from "./process.ts";

type Emit = (event: WorkerStreamEvent) => void | Promise<void>;
type CodexConfig = {
  command?: string;
  model?: string | null;
  extraArgs?: string[];
  /** Harness-only variables, such as the Jev API key, that no process started by the adapter may see. */
  withheldEnvironment?: string[];
};

const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "completed", "filesChanged", "checksRun", "concerns"],
  properties: {
    summary: { type: "string" },
    completed: { type: "boolean" },
    filesChanged: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "status"],
        properties: {
          path: { type: "string" },
          status: { type: "string", enum: ["added", "modified", "deleted", "renamed", "unknown"] },
        },
      },
    },
    checksRun: { type: "array", items: { type: "string" } },
    concerns: { type: "array", items: { type: "string" } },
  },
};

/** Write permission comes only from the task's declared access mode. */
function isReadOnly(request: WorkerRequest): boolean {
  return request.task.access.mode === "read";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeString(value: unknown, max = 4000): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function reportFrom(value: unknown): WorkerReport | undefined {
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

function redact(value: string, environment: Record<string, string>): string {
  let result = value;
  for (const secret of Object.values(environment).filter((v) => v.length >= 4))
    result = result.replaceAll(secret, "[REDACTED]");
  return result;
}

/** The redacted end of a failed provider's stderr, on one line, where CLIs usually explain the failure. */
function stderrTail(stderr: string, environment: Record<string, string>): string {
  const text = redact(stderr, environment)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips CSI and OSC terminal escapes and control characters.
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 500 ? `…${text.slice(-500)}` : text;
}

function usageFrom(value: unknown): Usage | undefined {
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

abstract class CliWorker implements WorkerAdapter {
  abstract readonly kind: "codex-cli" | "cursor-cli";
  private readonly active = new Map<string, AbortController>();
  constructor(protected readonly config: CodexConfig) {}
  private get withheld(): readonly string[] {
    return this.config.withheldEnvironment ?? [];
  }
  protected abstract args(request: WorkerRequest, reportPath?: string): string[];
  protected abstract executable(): string;
  /** A remediation for a provider failure this adapter recognizes from its stderr. */
  protected failureHint(_stderr: string): string | undefined {
    return undefined;
  }

  async preflight(): Promise<ProviderPreflight> {
    const result = await runProcess({
      command: [this.executable(), "--version"],
      withheldEnv: this.withheld,
      timeoutMs: 5000,
      maxCaptureBytes: 1024,
    });
    const wrongExecutable = this.kind === "cursor-cli" && /^grok\b/i.test(result.stdout.trim());
    return {
      ok: result.status === "exited" && result.exitCode === 0 && !wrongExecutable,
      ...(result.status === "exited" && result.exitCode === 0 ? { version: result.stdout.trim().slice(0, 200) } : {}),
      details: wrongExecutable
        ? ["Configured Cursor command resolves to Grok CLI"]
        : result.status === "exited" && result.exitCode === 0
          ? []
          : ["Provider executable unavailable or version check failed"],
    };
  }

  async cancel(callId: string): Promise<void> {
    this.active.get(callId)?.abort();
  }

  async execute(request: WorkerRequest, emit: Emit): Promise<WorkerResult> {
    const id = randomUUID();
    const started = Date.now();
    const controller = new AbortController();
    this.active.set(id, controller);
    let temp: string | undefined;
    let sessionId: string | undefined;
    let finalOutput = "";
    let report: WorkerReport | undefined;
    let usage: Usage = {};
    let rawEventCount = 0;
    let eventLimitReached = false;
    const emitSafe = async (event: WorkerStreamEvent) => {
      if (rawEventCount > 1000) {
        eventLimitReached = true;
        return;
      }
      await emit(event);
    };
    const parser = new BoundedJsonlParser(async (value) => {
      rawEventCount++;
      if (rawEventCount > 1000) {
        eventLimitReached = true;
        return;
      }
      const object = record(value);
      const type = object?.type;
      const at = new Date().toISOString();
      const payload = record(object?.item) ?? record(object?.message) ?? object;
      const rawId = safeString(object?.thread_id ?? object?.session_id ?? object?.sessionId, 200);
      const idValue = rawId ? redact(rawId, request.environment) : undefined;
      if (idValue && !sessionId) {
        sessionId = idValue;
        await emitSafe({ type: "session.started", sessionId, at });
      }
      const foundUsage = usageFrom(object?.usage ?? record(object?.total_token_usage) ?? record(object?.result)?.usage);
      if (foundUsage) {
        usage = { ...usage, ...foundUsage };
        await emitSafe({ type: "usage", usage, at });
      }
      const text = safeString(payload?.text ?? object?.result ?? object?.message, 8000);
      if (
        text &&
        (type === "item.completed" || type === "assistant" || type === "result" || payload?.type === "agent_message")
      ) {
        finalOutput = redact(text, request.environment);
        await emitSafe({ type: "message", role: "assistant", text: finalOutput, at });
        try {
          report = reportFrom(JSON.parse(redact(text, request.environment))) ?? report;
        } catch {
          /* ordinary prose */
        }
        return;
      }
      if (type === "tool_call" || payload?.type === "command_execution") {
        const name = safeString(payload?.name ?? payload?.type, 100) ?? "tool";
        await emitSafe({ type: "tool.started", name: redact(name, request.environment), at });
        return;
      }
      const raw = redact(JSON.stringify(value), request.environment).slice(0, 4000);
      await emitSafe({ type: "provider.raw", value: raw, at });
    });
    try {
      await emit({ type: "session.started", callId: id, at: new Date(started).toISOString() });
      const gitStatus = () =>
        runProcess({
          command: ["git", "status", "--porcelain=v1", "-z"],
          cwd: request.workspace,
          withheldEnv: this.withheld,
          timeoutMs: 5000,
          maxCaptureBytes: 64_000,
        });
      // The runtime owns repository policy. Adapters only attribute status entries that change during the call.
      const before = await gitStatus();
      const beforeValid = before.status === "exited" && before.exitCode === 0 && !before.truncated;
      if (!beforeValid) {
        return {
          id,
          provider: this.kind,
          status: "failed",
          startedAt: new Date(started).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          exitCode: null,
          finalOutput: "",
          usage: {},
          rawEventCount: 0,
          error: "Workspace Git status unavailable",
        };
      }
      if (this.kind === "codex-cli") {
        temp = await mkdtemp(join(tmpdir(), "harness-worker-"));
        await writeFile(join(temp, "report-schema.json"), JSON.stringify(reportSchema), { mode: 0o600 });
      }
      const result = await runProcess({
        command: [this.executable(), ...this.args(request, temp ? join(temp, "report-schema.json") : undefined)],
        cwd: request.workspace,
        env: request.environment,
        withheldEnv: this.withheld,
        ...(this.kind === "codex-cli" ? { stdin: request.instructions } : {}),
        timeoutMs: request.timeoutMs,
        signal: controller.signal,
        onStdout: (chunk) => parser.write(chunk),
      });
      await parser.finish();
      // Providers embed whole files in some events (Cursor's edit results), so a dropped line is not a failure.
      if (parser.oversizedCount) {
        await emitSafe({
          type: "message",
          role: "system",
          text: `Skipped ${parser.oversizedCount} provider output line(s) over ${parser.maxLineBytes} bytes`,
          at: new Date().toISOString(),
        });
      }
      const git = await gitStatus();
      const gitValid = git.status === "exited" && git.exitCode === 0 && !git.truncated;
      const beforeEntries = new Set(before.stdout.split("\0").filter(Boolean));
      const filesChanged = gitValid
        ? git.stdout
            .split("\0")
            .filter((line) => line && !beforeEntries.has(line))
            .slice(0, 100)
            .map((line) => ({
              path: line.slice(3),
              status: line.startsWith("??") ? ("added" as const) : ("unknown" as const),
            }))
        : [];
      if (report) report.filesChanged = filesChanged;
      const status =
        result.status === "timed-out"
          ? "timed-out"
          : result.status === "cancelled"
            ? "cancelled"
            : result.status === "exited" &&
                result.exitCode === 0 &&
                parser.invalidCount === 0 &&
                !eventLimitReached &&
                gitValid &&
                !(isReadOnly(request) && filesChanged.length)
              ? "succeeded"
              : "failed";
      return {
        id,
        provider: this.kind,
        status,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        exitCode: result.exitCode,
        ...(sessionId ? { sessionId } : {}),
        ...(report ? { report } : {}),
        finalOutput,
        usage,
        rawEventCount,
        ...(status === "failed"
          ? {
              error:
                result.status === "spawn-error"
                  ? "Could not start provider"
                  : parser.invalidCount
                    ? "Invalid provider JSONL"
                    : eventLimitReached
                      ? "Provider event limit exceeded"
                      : !gitValid
                        ? "Workspace Git status unavailable after worker"
                        : isReadOnly(request) && filesChanged.length
                          ? "Read-only worker changed files"
                          : [
                              this.failureHint(result.stderr),
                              [
                                `Provider exited with code ${result.exitCode}`,
                                stderrTail(result.stderr, request.environment),
                              ]
                                .filter(Boolean)
                                .join(": "),
                            ]
                              .filter(Boolean)
                              .join(". "),
            }
          : {}),
      };
    } finally {
      this.active.delete(id);
      if (temp) await rm(temp, { recursive: true, force: true });
    }
  }
}

export class CodexWorkerAdapter extends CliWorker {
  readonly kind = "codex-cli" as const;
  protected executable(): string {
    return this.config.command ?? "codex";
  }
  protected args(request: WorkerRequest, reportPath?: string): string[] {
    const model = request.model ?? this.config.model;
    return [
      "exec",
      "--json",
      "--sandbox",
      isReadOnly(request) ? "read-only" : "workspace-write",
      "--cd",
      request.workspace,
      ...(reportPath ? ["--output-schema", reportPath] : []),
      ...(model ? ["--model", model] : []),
      ...(this.config.extraArgs ?? []),
      "-",
    ];
  }
}

/** cursor-agent options that let a headless call run in a workspace the user has not trusted interactively. */
const CURSOR_TRUST_ARGS = new Set(["--trust", "--yolo", "--force", "-f"]);

export class CursorWorkerAdapter extends CliWorker {
  readonly kind = "cursor-cli" as const;
  override async preflight(): Promise<ProviderPreflight> {
    const preflight = await super.preflight();
    const trusted = (this.config.extraArgs ?? []).some((arg) => CURSOR_TRUST_ARGS.has(arg));
    if (!preflight.ok || trusted) return preflight;
    // A version check cannot see workspace trust, so say what a first run in an untrusted workspace needs.
    return {
      ...preflight,
      details: [...preflight.details, "Runs fail in untrusted workspaces unless extraArgs includes --trust"],
    };
  }
  protected executable(): string {
    return this.config.command ?? "cursor-agent";
  }
  protected args(request: WorkerRequest): string[] {
    const model = request.model ?? this.config.model;
    return [
      "--print",
      "--output-format",
      "stream-json",
      "--workspace",
      request.workspace,
      ...(model ? ["--model", model] : []),
      ...(this.config.extraArgs ?? []),
      isReadOnly(request) ? `Read-only task: do not modify files.\n${request.instructions}` : request.instructions,
    ];
  }
  protected override failureHint(stderr: string): string | undefined {
    // Headless Cursor refuses a workspace the user has not trusted; the harness does not trust it on their behalf.
    return /Workspace Trust Required/i.test(stderr)
      ? "Cursor has not trusted this workspace; add --trust to the provider's extraArgs to allow headless runs in it"
      : undefined;
  }
}
