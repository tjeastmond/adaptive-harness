import { loadHarnessConfig } from "@adaptive-harness/config";
import type { HarnessRun, RunId, RunPlan } from "@adaptive-harness/core";
import type { ApprovalRequest, EventEnvelope, HarnessEvent } from "@adaptive-harness/protocol";
import { nonnegativeInteger, type ParsedOptions, parseOptions } from "./options.ts";
import type { CliRuntime, OpenRuntime } from "./runtime.ts";

export interface CommandContext {
  openRuntime: OpenRuntime;
  env: Record<string, string | undefined>;
}

const line = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max = 160) => {
  const flat = line(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One line summarizing a dry run's plan. */
export function describePlan(plan: RunPlan): string {
  const route = plan.route ? `${plan.route.taskKind} task` : "no route";
  if (plan.unresolved) {
    const { reason, detail } = plan.unresolved;
    return `${route}, unresolved: ${reason}${detail ? ` (${detail})` : ""}`;
  }
  if (!plan.agentName) return `${route}, no agent selected`;
  const provider = plan.provider;
  const ready = !provider
    ? "no provider"
    : provider.preflight.ok
      ? // A ready provider can still carry advice, such as Cursor's workspace trust.
        `${provider.name} ready${provider.preflight.details.length ? ` (${clip(provider.preflight.details.join("; "))})` : ""}`
      : `${provider.name} not ready: ${clip(provider.preflight.details.join("; "))}`;
  return `${route} -> agent ${plan.agentName} (${plan.access ?? "unknown"} access), ${ready}`;
}

/** One human-readable line per event; worker chatter is reduced to assistant messages and tool starts. */
export function describeEvent(event: HarnessEvent): string | undefined {
  switch (event.type) {
    case "run.created":
      return `run created: ${clip(event.run.objective.text)}`;
    case "run.status-changed":
      return `status: ${event.from} -> ${event.to}`;
    case "decision.requested":
      return `decision requested: ${event.phase}`;
    case "decision.completed":
      return `decision completed: ${event.decision.model} (${event.decision.durationMs}ms)`;
    case "decision.bypassed":
      return `decision bypassed: ${event.reason}`;
    case "worker.started":
      return `worker started: task ${event.taskId}`;
    case "worker.event":
      if (event.event.type === "message") {
        // System messages are notices from the adapter, not provider output.
        return `${event.event.role === "system" ? "worker notice" : "worker"}: ${clip(event.event.text)}`;
      }
      if (event.event.type === "tool.started") return `worker tool: ${event.event.name}`;
      return undefined;
    case "worker.completed": {
      const detail = event.result.report?.summary ?? event.result.error ?? "";
      return `worker ${event.result.status}${detail ? `: ${clip(detail)}` : ""}${event.result.usage.estimated ? " (usage estimated)" : ""}`;
    }
    case "verification.completed": {
      const failed = event.result.commands
        .filter((command) => command.exitCode !== 0 || command.timedOut)
        .map((command) => command.name);
      return `verification ${event.result.ok ? "passed" : `failed${failed.length ? `: ${failed.join(", ")}` : ""}`}`;
    }
    case "policy.action":
      return `next action: ${event.action}${event.reasonCodes.length ? ` (${event.reasonCodes.join(", ")})` : ""}`;
    case "approval.requested":
      return `approval requested ${event.request.id}: ${clip(event.request.prompt, 400)}`;
    case "approval.answered":
      return `approval answered ${event.request.id}: ${event.request.answer ?? ""}`;
    case "run.paused":
      return `run paused: ${event.reason}`;
    case "run.resumed":
      return "run resumed";
    case "run.cancelled":
      return `run cancelled${event.reason ? `: ${event.reason}` : ""}`;
    case "run.planned":
      return `dry-run plan: ${describePlan(event.plan)}`;
    case "run.completed":
      return "run completed";
    case "run.failed":
      return `run failed: ${clip(event.error, 400)}`;
  }
}

function printEvent(envelope: EventEnvelope, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(envelope));
    return;
  }
  const text = describeEvent(envelope.payload);
  if (text) console.log(`#${envelope.sequence}\t${text}`);
}

/** Tracks the approval a run is waiting for, and a dry run's plan, as seen on its event stream. */
class ApprovalTracker {
  pending: ApprovalRequest | undefined;
  plan: RunPlan | undefined;
  observe(event: HarnessEvent): void {
    if (event.type === "run.planned") this.plan = event.plan;
    else if (event.type === "approval.requested") this.pending = event.request;
    else if (event.type === "approval.answered" && event.request.id === this.pending?.id) this.pending = undefined;
  }
}

/** Sequence of the last persisted event, read by draining the stream with an already-aborted signal. */
async function lastSequence(session: CliRuntime, runId: RunId, tracker: ApprovalTracker): Promise<number> {
  const signal = AbortSignal.abort();
  let sequence = 0;
  for await (const event of session.runtime.subscribe(runId, 0, { signal })) {
    tracker.observe(event.payload);
    sequence = event.sequence;
  }
  return sequence;
}

/** Runs `action`, which drives the run in this process, while streaming the events it persists. */
async function drive(
  session: CliRuntime,
  runId: RunId,
  afterSequence: number,
  tracker: ApprovalTracker,
  stream: boolean,
  action: () => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const watching = (async () => {
    for await (const event of session.runtime.subscribe(runId, afterSequence, { signal: controller.signal })) {
      tracker.observe(event.payload);
      if (stream) printEvent(event, false);
    }
  })();
  // Settle the stream before reporting, but never let a stream error mask the action's own failure.
  watching.catch(() => {});
  try {
    await action();
  } catch (error) {
    controller.abort();
    await watching.catch(() => {});
    throw error;
  }
  controller.abort();
  await watching;
}

function summarize(run: HarnessRun, tracker: ApprovalTracker, json: boolean): number {
  const { pending, plan } = tracker;
  if (json) {
    console.log(JSON.stringify({ run, ...(pending ? { approval: pending } : {}), ...(plan ? { plan } : {}) }, null, 2));
  } else {
    console.log(`Run ${run.id}: ${run.status}${run.dryRun ? " (dry run)" : ""}`);
    if (plan) {
      console.log(`Plan: ${describePlan(plan)}`);
    } else if (pending) {
      console.log(`Waiting for approval ${pending.id}: ${pending.prompt}`);
      if (pending.choices?.length) console.log(`Choices: ${pending.choices.join(", ")}`);
      console.log(`Answer with: harness approvals answer ${pending.id} <answer>`);
    } else if (run.status === "paused") {
      console.log(`Resume with: harness resume ${run.id}`);
    }
  }
  return run.status === "failed" ? 1 : 0;
}

/**
 * `observe` only reads the run; `control` changes run state; `drive` also executes the run in this process and needs
 * decisions. Only commands that change run state recover runs interrupted by a stopped owner.
 */
type RuntimeAccess = "observe" | "control" | "drive";

async function withRuntime(
  context: CommandContext,
  options: ParsedOptions,
  access: RuntimeAccess,
  body: (session: CliRuntime) => Promise<number>,
): Promise<number> {
  const mode = options.values.get("decision-mode");
  if (mode !== undefined && mode !== "jev" && mode !== "deterministic") {
    console.error("--decision-mode must be jev or deterministic");
    return 2;
  }
  let session: CliRuntime | undefined;
  try {
    const configPath = options.values.get("config");
    session = await context.openRuntime({
      ...(configPath === undefined ? {} : { configPath }),
      ...(mode === undefined ? {} : { decisionMode: mode }),
      requireDecisions: access === "drive",
      env: context.env,
    });
    for (const runId of access === "observe" ? [] : await session.recoverInterruptedRuns()) {
      console.error(`Recovered interrupted run ${runId}; it is paused. Resume with: harness resume ${runId}`);
    }
    return await body(session);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    session?.close();
  }
}

function usage(message: string): number {
  console.error(message);
  return 2;
}

export async function runCommand(args: string[], context: CommandContext): Promise<number> {
  const options = parseOptions(args, {
    values: ["config", "workspace", "decision-mode"],
    flags: ["json", "dry-run"],
  });
  if ("error" in options) return usage(options.error);
  const [objective, ...extra] = options.positional;
  if (!objective?.trim() || extra.length) {
    return usage(
      "Usage: harness run <objective> [--config path] [--workspace path] [--decision-mode jev|deterministic] [--dry-run] [--json]",
    );
  }
  const dryRun = options.flags.has("dry-run");
  const json = options.flags.has("json");
  return withRuntime(context, options, "drive", async (session) => {
    const run = await session.runtime.createRun({
      objective: { text: objective.trim(), acceptanceCriteria: [] },
      workspace: options.values.get("workspace") ?? session.config.project.workspace,
      configPath: session.configPath,
      ...(dryRun ? { dryRun } : {}),
    });
    if (!json) {
      console.log(`Run ${run.id} started${dryRun ? " as a dry run" : ""} (decision mode: ${session.decisionMode})`);
    }
    const tracker = new ApprovalTracker();
    await drive(session, run.id, 0, tracker, !json, () => session.runtime.startRun(run.id));
    return summarize(await session.runtime.getRun(run.id), tracker, json);
  });
}

export async function watchCommand(args: string[], context: CommandContext): Promise<number> {
  const options = parseOptions(args, { values: ["config", "after"], flags: ["json"] });
  if ("error" in options) return usage(options.error);
  const after = options.values.has("after") ? nonnegativeInteger(options.values.get("after")) : 0;
  const [runId, ...extra] = options.positional;
  if (!runId || extra.length || after === undefined) {
    return usage("Usage: harness runs watch <run-id> [--after sequence] [--config path] [--json]");
  }
  const json = options.flags.has("json");
  return withRuntime(context, options, "observe", async (session) => {
    await session.runtime.getRun(runId);
    for await (const event of session.runtime.subscribe(runId, after)) printEvent(event, json);
    if (!json) console.log(`Run ${runId}: ${(await session.runtime.getRun(runId)).status}`);
    return 0;
  });
}

/** `pause` and `cancel` request a control change; `resume` drives the run in this process until it settles. */
export async function controlCommand(
  command: "pause" | "resume" | "cancel",
  args: string[],
  context: CommandContext,
): Promise<number> {
  const options = parseOptions(args, {
    values: command === "resume" ? ["config", "decision-mode"] : ["config"],
    flags: ["json"],
  });
  if ("error" in options) return usage(options.error);
  const [runId, ...extra] = options.positional;
  if (!runId || extra.length) {
    return usage(
      `Usage: harness ${command} <run-id> [--config path]${command === "resume" ? " [--decision-mode jev|deterministic]" : ""} [--json]`,
    );
  }
  const json = options.flags.has("json");
  return withRuntime(context, options, command === "resume" ? "drive" : "control", async (session) => {
    const tracker = new ApprovalTracker();
    if (command === "resume") {
      const after = await lastSequence(session, runId, tracker);
      await drive(session, runId, after, tracker, !json, () => session.runtime.resumeRun(runId));
      return summarize(await session.runtime.getRun(runId), tracker, json);
    }
    await (command === "pause" ? session.runtime.pauseRun(runId) : session.runtime.cancelRun(runId));
    const run = await session.runtime.getRun(runId);
    if (json) console.log(JSON.stringify({ run }, null, 2));
    else {
      const settled = command === "pause" ? run.status === "paused" : run.status === "cancelled";
      console.log(settled ? `Run ${runId}: ${run.status}` : `${command} requested for run ${runId} (${run.status})`);
    }
    return 0;
  });
}

export async function approvalsCommand(args: string[], context: CommandContext): Promise<number> {
  const options = parseOptions(args.slice(1), { values: ["config", "decision-mode"], flags: ["json"] });
  if ("error" in options) return usage(options.error);
  const [requestId, answer, ...extra] = options.positional;
  if (args[0] !== "answer" || !requestId || answer === undefined || extra.length) {
    return usage(
      "Usage: harness approvals answer <request-id> <answer> [--config path] [--decision-mode jev|deterministic] [--json]",
    );
  }
  const json = options.flags.has("json");
  return withRuntime(context, options, "drive", async (session) => {
    const approval = await session.runtime.getApproval(requestId);
    if (!approval) throw new Error(`Approval not found: ${requestId}`);
    const runId = approval.runId;
    const tracker = new ApprovalTracker();
    const after = await lastSequence(session, runId, tracker);
    await drive(session, runId, after, tracker, !json, () => session.runtime.answerApproval(requestId, answer));
    return summarize(await session.runtime.getRun(runId), tracker, json);
  });
}

export async function agentsCommand(args: string[], context: CommandContext): Promise<number> {
  const options = parseOptions(args.slice(1), { values: ["config"], flags: ["json"] });
  if ("error" in options) return usage(options.error);
  if (args[0] !== "list" || options.positional.length)
    return usage("Usage: harness agents list [--config path] [--json]");
  try {
    const configPath = options.values.get("config");
    const { config } = await loadHarnessConfig({
      ...(configPath === undefined ? {} : { configPath }),
      env: context.env,
      requireSecrets: false,
    });
    const roles = (name: string) =>
      (["defaultAgent", "complexAgent", "reviewerAgent"] as const).filter((role) => config.routing[role] === name);
    const agents = Object.entries(config.agents).map(([name, agent]) => ({
      name,
      provider: agent.provider,
      kind: config.providers[agent.provider]?.kind ?? "unknown",
      purpose: agent.purpose,
      readOnly: agent.readOnly,
      routing: roles(name),
    }));
    if (options.flags.has("json")) console.log(JSON.stringify(agents, null, 2));
    else
      for (const agent of agents)
        console.log(
          [agent.name, agent.provider, agent.kind, agent.purpose, agent.readOnly ? "read-only" : "read-write"]
            .concat(agent.routing.length ? [agent.routing.join(",")] : [])
            .join("\t"),
        );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function providersCommand(args: string[], context: CommandContext): Promise<number> {
  const options = parseOptions(args.slice(1), { values: ["config"], flags: ["json"] });
  if ("error" in options) return usage(options.error);
  if (args[0] !== "doctor" || options.positional.length) {
    return usage("Usage: harness providers doctor [--config path] [--json]");
  }
  let session: CliRuntime | undefined;
  try {
    const configPath = options.values.get("config");
    session = await context.openRuntime({
      ...(configPath === undefined ? {} : { configPath }),
      requireDecisions: false,
      env: context.env,
    });
    const checks = await session.preflight();
    if (options.flags.has("json")) console.log(JSON.stringify(checks, null, 2));
    else
      for (const check of checks)
        console.log(
          [check.name, check.kind, check.ok ? "ok" : "failed", check.version ?? "", check.details.join("; ")].join(
            "\t",
          ),
        );
    return checks.every((check) => check.ok) ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    session?.close();
  }
}
