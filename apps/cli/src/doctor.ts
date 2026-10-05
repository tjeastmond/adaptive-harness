import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { isTerminalStatus } from "@adaptive-harness/core";
import type { CliRuntime } from "./runtime.ts";

export interface DoctorCheck {
  name: string;
  /** Required failures make `doctor` exit nonzero; advisory ones are reported only. */
  required: boolean;
  ok: boolean;
  detail: string;
}

export interface HarnessWorktree {
  path: string;
  branch?: string;
  runId?: string;
  /** Status of the owning run, or `unknown` when the store has no such run. */
  runStatus: string;
  /** Not owned by a live run: its run is unknown or already finished. */
  stale: boolean;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  worktrees: HarnessWorktree[];
}

const BRANCH = /^refs\/heads\/harness\/([^/]+)\/task-\d+$/;

async function capture(command: string[], cwd?: string): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn(command, { ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  } catch {
    return { code: 127, stdout: "" };
  }
}

/** Resolves a verification command the way the verifier runs it: in the workspace, with the command's environment. */
function resolveExecutable(command: string, workspace: string, env: Record<string, string>): string | null {
  if (command.includes("/")) {
    const path = resolve(workspace, command);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      return null;
    }
  }
  return Bun.which(command, { cwd: workspace, PATH: env.PATH ?? process.env.PATH ?? "" });
}

/** Git added `worktree` in 2.5 and `list --porcelain` in 2.7. */
export function gitSupportsWorktrees(versionOutput: string): boolean {
  const match = /(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 7);
}

export function parseWorktrees(porcelain: string): Array<{ path: string; branch?: string }> {
  const entries: Array<{ path: string; branch?: string }> = [];
  for (const block of porcelain.split(/\n\n+/)) {
    let path: string | undefined;
    let branch: string | undefined;
    for (const row of block.split("\n")) {
      if (row.startsWith("worktree ")) path = row.slice("worktree ".length);
      else if (row.startsWith("branch ")) branch = row.slice("branch ".length);
    }
    if (path) entries.push({ path, ...(branch === undefined ? {} : { branch }) });
  }
  return entries;
}

/** Returns undefined when Git cannot inspect the workspace. */
async function harnessWorktrees(session: CliRuntime, workspace: string): Promise<HarnessWorktree[] | undefined> {
  const listed = await capture(["git", "-C", workspace, "worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return undefined;
  const found: HarnessWorktree[] = [];
  // The first entry is the main checkout.
  for (const entry of parseWorktrees(listed.stdout).slice(1)) {
    const runId = entry.branch ? BRANCH.exec(entry.branch)?.[1] : undefined;
    if (!runId && !entry.path.includes("/.harness/")) continue;
    let runStatus = "unknown";
    if (runId) {
      try {
        runStatus = (await session.runtime.getRun(runId as never)).status;
      } catch {
        // The run is not in this store.
      }
    }
    found.push({
      path: entry.path,
      ...(entry.branch === undefined ? {} : { branch: entry.branch.replace("refs/heads/", "") }),
      ...(runId === undefined ? {} : { runId }),
      runStatus,
      stale: runStatus === "unknown" || isTerminalStatus(runStatus as never),
    });
  }
  return found;
}

/** Reports what would block a multi-agent run, without invoking a worker. */
export async function runDoctor(session: CliRuntime): Promise<DoctorReport> {
  const { config } = session;
  const checks: DoctorCheck[] = [];
  const add = (name: string, required: boolean, ok: boolean, detail: string) =>
    checks.push({ name, required, ok, detail });

  for (const check of await session.preflight()) {
    // Identify the decision provider by kind; worker providers can be named anything.
    const isJev = check.kind === "jev";
    // Deterministic mode bypasses Jev, so an unreachable Jev only blocks Jev-driven runs.
    const required = !isJev || session.decisionMode === "jev";
    add(
      isJev ? "decision:jev" : `provider:${check.name}`,
      required,
      check.ok,
      [check.version, ...check.details].filter(Boolean).join("; "),
    );
  }
  add("decision:mode", true, true, session.decisionMode);

  const git = await capture(["git", "--version"]);
  add("git:worktree", true, git.code === 0 && gitSupportsWorktrees(git.stdout), git.stdout.trim() || "git not found");

  const routed = Object.entries({
    defaultAgent: config.routing.defaultAgent,
    complexAgent: config.routing.complexAgent,
    reviewerAgent: config.routing.reviewerAgent,
  });
  const unresolved = routed.filter(([, agent]) => {
    const definition = config.agents[agent];
    return !definition || !config.providers[definition.provider];
  });
  add(
    "routing:agents",
    true,
    unresolved.length === 0,
    unresolved.length
      ? `unresolved: ${unresolved.map(([role, agent]) => `${role}=${agent}`).join(", ")}`
      : routed.map(([role, agent]) => `${role}=${agent}`).join(", "),
  );

  const { limits } = config;
  const incoherent = [
    limits.workerTimeoutMs > limits.maxElapsedMs && "workerTimeoutMs exceeds maxElapsedMs",
    limits.maxWorkerCalls > limits.maxSteps && "maxWorkerCalls exceeds maxSteps",
  ].filter(Boolean);
  add("limits:coherent", false, incoherent.length === 0, incoherent.join("; ") || "ok");

  for (const command of config.verification.commands) {
    const path = resolveExecutable(command.command, config.project.workspace, command.env);
    add(`verification:${command.name}`, true, path !== null, path ?? `${command.command} not found`);
  }

  const worktrees = await harnessWorktrees(session, config.project.workspace);
  if (!worktrees) {
    add("worktrees:inspect", true, false, `git cannot list worktrees in ${config.project.workspace}`);
  } else {
    const stale = worktrees.filter((worktree) => worktree.stale).length;
    add("worktrees:stale", false, stale === 0, `${worktrees.length} harness worktree(s), ${stale} stale`);
  }

  return { ok: checks.every((check) => check.ok || !check.required), checks, worktrees: worktrees ?? [] };
}
