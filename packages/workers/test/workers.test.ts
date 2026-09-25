import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerRequest, WorkerStreamEvent } from "@adaptive-harness/core";
import { BoundedJsonlParser, CodexWorkerAdapter, CursorWorkerAdapter, runProcess } from "../src/index.ts";

const dirs: string[] = [];
async function fixture(mode: string, version = "fake-agent 1.0") {
  const dir = await mkdtemp("/private/tmp/harness-worker-test-");
  dirs.push(dir);
  const git = Bun.spawn(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
  expect(await git.exited).toBe(0);
  const command = join(dir, ".git", "fake-agent");
  await writeFile(
    command,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log(${JSON.stringify(version)}); process.exit(0); }
writeFileSync(${JSON.stringify(join(dir, ".git", "args.json"))}, JSON.stringify(process.argv.slice(2)));
let prompt = ""; for await (const chunk of Bun.stdin.stream()) prompt += new TextDecoder().decode(chunk);
writeFileSync(${JSON.stringify(join(dir, ".git", "stdin.txt"))}, prompt);
if (${JSON.stringify(mode)} === "env") writeFileSync(${JSON.stringify(join(dir, ".git", "env.json"))}, JSON.stringify({ jev: process.env.HARNESS_TEST_JEV_KEY ?? null, worker: process.env.TEST_SECRET ?? null }));
if (${JSON.stringify(mode)} === "timeout") await new Promise((resolve) => setTimeout(resolve, 30_000));
if (${JSON.stringify(mode)} === "invalid") { console.log("{invalid"); process.exit(0); }
if (${JSON.stringify(mode)} === "longexit") { console.error("x".repeat(600) + "\\x1b]0;title\\x07 tail-end"); process.exit(3); }
if (${JSON.stringify(mode)} === "exit") { console.error("\\x1b[33mfailure\\x1b[0m\\n  needs secret-value\\n"); process.exit(7); }
if (${JSON.stringify(mode)} === "write") writeFileSync(${JSON.stringify(join(dir, "worker-change.txt"))}, "changed");
if (${JSON.stringify(mode)} === "callback") { writeFileSync(${JSON.stringify(join(dir, ".git", "pid"))}, String(process.pid)); console.log("event"); await new Promise((resolve) => setTimeout(resolve, 30_000)); }
if (${JSON.stringify(mode)} === "oversize") console.log(JSON.stringify({type:"unknown",payload:"x".repeat(100_000)}));
if (${JSON.stringify(mode)} === "secret") { console.log(JSON.stringify({type:"unknown",value:"secret-value"})); console.log(JSON.stringify({type:"tool_call",item:{name:"secret-value"}})); }
console.log(JSON.stringify({type:"thread.started",thread_id:${JSON.stringify(mode)} === "secret" ? "secret-value" : "session-1"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({summary:${JSON.stringify(mode)} === "secret" ? "secret-value" : "done",completed:true,filesChanged:[],checksRun:[],concerns:[]})}}));
`,
  );
  await chmod(command, 0o755);
  return { dir, command };
}
function request(dir: string): WorkerRequest {
  const at = new Date().toISOString();
  return {
    runId: "run",
    agentName: "tester",
    instructions: "Read this repository",
    workspace: dir,
    timeoutMs: 500,
    environment: { TEST_SECRET: "secret-value" },
    task: {
      id: "task",
      runId: "run",
      kind: "review",
      objective: { text: "read", acceptanceCriteria: [] },
      attempt: 1,
      access: { mode: "read" },
      status: "running",
      createdAt: at,
      updatedAt: at,
    },
  };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.each([CodexWorkerAdapter, CursorWorkerAdapter])("%p", (Adapter) => {
  test("preflights and runs a read-only task against a fixture repository", async () => {
    const { dir, command } = await fixture("ok");
    const adapter = new Adapter({ command });
    expect(await adapter.preflight()).toMatchObject({ ok: true, version: "fake-agent 1.0" });
    const events: WorkerStreamEvent[] = [];
    const result = await adapter.execute(request(dir), (event) => {
      events.push(event);
    });
    expect(result.status).toBe("succeeded");
    expect(result.report?.summary).toBe("done");
    expect(result.sessionId).toBe("session-1");
    expect(events.some((event) => event.type === "message")).toBe(true);
    const args = JSON.parse(await readFile(join(dir, ".git", "args.json"), "utf8")) as string[];
    expect(args).toContain(dir);
    if (adapter.kind === "codex-cli") {
      expect(args).toContain("read-only");
      expect(await readFile(join(dir, ".git", "stdin.txt"), "utf8")).toBe("Read this repository");
    } else expect(args.at(-1)).toContain("Read this repository");
  });

  test("derives write permission from the task access mode", async () => {
    const { dir, command } = await fixture("ok");
    const base = request(dir);
    const result = await new Adapter({ command }).execute(
      { ...base, instructions: "Change this repository", task: { ...base.task, access: { mode: "write" } } },
      () => {},
    );
    expect(result.status).toBe("succeeded");
    const args = JSON.parse(await readFile(join(dir, ".git", "args.json"), "utf8")) as string[];
    if (Adapter === CodexWorkerAdapter) {
      expect(args).toContain("workspace-write");
      expect(args).not.toContain("read-only");
    } else expect(args.at(-1)).toBe("Change this repository");
  });

  test.each([
    ["timeout", "timed-out"],
    ["invalid", "failed"],
    ["exit", "failed"],
  ] as const)("types %s as %s", async (mode, expected) => {
    const { dir, command } = await fixture(mode);
    const result = await new Adapter({ command }).execute(request(dir), () => {});
    expect(result.status).toBe(expected);
    if (mode === "exit") {
      expect(result.exitCode).toBe(7);
      expect(result.error).toBe("Provider exited with code 7: failure needs [REDACTED]");
    }
    if (mode === "invalid") expect(result.error).toBe("Invalid provider JSONL");
  });

  test("keeps only the end of a long stderr without terminal escapes", async () => {
    const { dir, command } = await fixture("longexit");
    const result = await new Adapter({ command }).execute(request(dir), () => {});
    expect(result.status).toBe("failed");
    const tail = result.error?.replace("Provider exited with code 3: ", "") ?? "";
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("x tail-end")).toBe(true);
    expect(tail).toHaveLength(501);
    expect(tail).not.toContain("title");
  });

  test("cancels an active process by emitted call ID", async () => {
    const { dir, command } = await fixture("timeout");
    const adapter = new Adapter({ command });
    const input = { ...request(dir), timeoutMs: 5000 };
    const result = await adapter.execute(input, async (event) => {
      if (event.type === "session.started" && event.callId) {
        const callId = event.callId;
        setTimeout(() => void adapter.cancel(callId), 50);
      }
    });
    expect(result.status).toBe("cancelled");
  });

  test("redacts configured values from results and raw events", async () => {
    const { dir, command } = await fixture("secret");
    const events: WorkerStreamEvent[] = [];
    const result = await new Adapter({ command }).execute(request(dir), (event) => {
      events.push(event);
    });
    expect(JSON.stringify({ result, events })).not.toContain("secret-value");
    expect(result.report?.summary).toBe("[REDACTED]");
    expect(result.sessionId).toBe("[REDACTED]");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.started", name: "[REDACTED]" }));
  });

  test("withholds harness-only secrets from the worker environment", async () => {
    const { dir, command } = await fixture("env");
    process.env.HARNESS_TEST_JEV_KEY = "jev-secret";
    try {
      const adapter = new Adapter({ command, withheldEnvironment: ["HARNESS_TEST_JEV_KEY"] });
      const withJevKey = {
        ...request(dir),
        environment: { TEST_SECRET: "secret-value", HARNESS_TEST_JEV_KEY: "jev-secret" },
      };
      expect((await adapter.execute(withJevKey, () => {})).status).toBe("succeeded");
    } finally {
      delete process.env.HARNESS_TEST_JEV_KEY;
    }
    expect(JSON.parse(await readFile(join(dir, ".git", "env.json"), "utf8"))).toEqual({
      jev: null,
      worker: "secret-value",
    });
  });

  test("skips an oversized JSONL event without failing the call", async () => {
    const { dir, command } = await fixture("oversize");
    const events: WorkerStreamEvent[] = [];
    const result = await new Adapter({ command }).execute(request(dir), (event) => {
      events.push(event);
    });
    expect(result.status).toBe("succeeded");
    expect(result.report?.summary).toBe("done");
    expect(result.finalOutput.length).toBeLessThanOrEqual(8000);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "system",
        text: "Skipped 1 provider output line(s) over 64000 bytes",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("x".repeat(1000));
  });

  test("detects files changed during a read-only worker call", async () => {
    const { dir, command } = await fixture("write");
    const result = await new Adapter({ command }).execute(request(dir), () => {});
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Read-only worker changed files");
    expect(result.report?.filesChanged).toContainEqual({ path: "worker-change.txt", status: "added" });
  });

  test("attributes only status entries that change during the call in a dirty workspace", async () => {
    const { dir, command } = await fixture("write");
    await writeFile(join(dir, "user-change.txt"), "present before worker");
    const result = await new Adapter({ command }).execute(request(dir), () => {});
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Read-only worker changed files");
    expect(result.report?.filesChanged).toEqual([{ path: "worker-change.txt", status: "added" }]);
  });

  test("runs in a workspace whose pre-existing changes stay untouched", async () => {
    const { dir, command } = await fixture("ok");
    await writeFile(join(dir, "user-change.txt"), "present before worker");
    const result = await new Adapter({ command }).execute(request(dir), () => {});
    expect(result.status).toBe("succeeded");
    expect(result.report?.filesChanged).toEqual([]);
  });
});

test("Cursor preflight rejects an explicitly configured Grok CLI", async () => {
  const { command } = await fixture("ok", "grok 1.0.40");
  expect(await new CursorWorkerAdapter({ command }).preflight()).toMatchObject({
    ok: false,
    details: ["Configured Cursor command resolves to Grok CLI"],
  });
});

test("JSONL parser drops oversized lines, counts invalid ones, accepts split UTF-8, and continues", async () => {
  const values: unknown[] = [];
  const parser = new BoundedJsonlParser((value) => {
    values.push(value);
  }, 32);
  const encoded = new TextEncoder().encode(`{"x":"é"}\n${"x".repeat(100)}\n{bad\n{"ok":true}\n${"y".repeat(100)}`);
  for (let i = 0; i < encoded.length; i += 3) await parser.write(encoded.subarray(i, i + 3));
  await parser.finish();
  expect(values).toEqual([{ x: "é" }, { ok: true }]);
  expect(parser.oversizedCount).toBe(2);
  expect(parser.invalidCount).toBe(1);
});

test("process runner removes withheld variables from inherited and given environments", async () => {
  process.env.HARNESS_TEST_INHERITED = "inherited";
  try {
    const result = await runProcess({
      command: ["sh", "-c", 'printf "%s|%s|%s" "$HARNESS_TEST_INHERITED" "$HARNESS_TEST_GIVEN" "$HARNESS_TEST_KEPT"'],
      env: { HARNESS_TEST_GIVEN: "given", HARNESS_TEST_KEPT: "kept" },
      withheldEnv: ["HARNESS_TEST_INHERITED", "HARNESS_TEST_GIVEN"],
      timeoutMs: 5000,
    });
    expect(result.stdout).toBe("||kept");
  } finally {
    delete process.env.HARNESS_TEST_INHERITED;
  }
});

test("process runner reports a missing executable without leaking a system error", async () => {
  const result = await runProcess({ command: ["/definitely/missing/binary"], timeoutMs: 100 });
  expect(result.status).toBe("spawn-error");
  expect(result.error).toBe("Could not start process");
});

test("process runner kills and reaps a child when a stdout callback throws", async () => {
  const { dir, command } = await fixture("callback");
  await expect(
    runProcess({
      command: [command],
      cwd: dir,
      timeoutMs: 5000,
      onStdout: () => {
        throw new Error("event sink failed");
      },
    }),
  ).rejects.toThrow("event sink failed");
  const pid = Number(await readFile(join(dir, ".git", "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
