import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runVerificationCommands, type VerificationCommand, type VerificationOutputChunk } from "../src/index.ts";

const dirs: string[] = [];

async function fixture() {
  const dir = await mkdtemp("/private/tmp/harness-verification-test-");
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function command(
  name: string,
  executable: string,
  args: string[] = [],
  env: Record<string, string> = {},
): VerificationCommand {
  return { name, command: executable, args, env, timeoutMs: 1000 };
}

describe("runVerificationCommands", () => {
  test("reports mixed passing and failing commands with no shell interpretation", async () => {
    const dir = await fixture();
    const marker = join(dir, "should-not-exist");
    const result = await runVerificationCommands(
      [
        command("pass", "bun", ["-e", "console.log(process.argv[1])", `plain; touch ${marker}`]),
        command("fail", "bun", ["-e", "console.error('bad'); process.exit(7)"]),
        command("pass-again", "bun", ["-e", "console.log('again')"]),
      ],
      dir,
    );
    expect(result.ok).toBe(false);
    expect(result.commands.map((entry) => entry.status)).toEqual(["passed", "failed", "passed"]);
    expect(result.commands.map((entry) => entry.exitCode)).toEqual([0, 7, 0]);
    expect(result.commands[0]?.stdout).toContain(`plain; touch ${marker}`);
    expect(result.commands[1]?.stderr).toContain("bad");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("stops after failure only when configured", async () => {
    const dir = await fixture();
    const result = await runVerificationCommands(
      [command("fail", "bun", ["-e", "process.exit(1)"]), command("skipped", "bun", ["-e", "console.log('run')"])],
      dir,
      { stopOnFailure: true },
    );
    expect(result.commands.map((entry) => entry.name)).toEqual(["fail"]);
  });

  test("types missing executables and timeouts as failed results", async () => {
    const dir = await fixture();
    const result = await runVerificationCommands(
      [
        command("missing", "/definitely/missing/executable"),
        { ...command("slow", "bun", ["-e", "await Bun.sleep(30000)"]), timeoutMs: 50 },
      ],
      dir,
    );
    expect(result.commands[0]).toMatchObject({ status: "spawn-error", exitCode: null, timedOut: false });
    expect(result.commands[1]).toMatchObject({ status: "timed-out", timedOut: true });
  });

  test("retains bounded decision tails and streams full redacted telemetry", async () => {
    const dir = await fixture();
    const script = join(dir, "output.ts");
    await writeFile(
      script,
      "process.stdout.write('prefix-'.repeat(1000)); process.stdout.write(process.env.TEST_SECRET!.slice(0, 4)); await Bun.sleep(20); process.stdout.write(process.env.TEST_SECRET!.slice(4)); process.stderr.write('error-detail');",
    );
    const outputs: VerificationOutputChunk[] = [];
    const result = await runVerificationCommands(
      [command("output", "bun", [script], { TEST_SECRET: "secret-value" })],
      dir,
      {
        maxDecisionOutputBytes: 80,
        onOutput: (output) => {
          outputs.push(output);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.commands[0]?.outputTruncated).toBe(true);
    expect(new TextEncoder().encode(result.commands[0]?.stdout).byteLength).toBeLessThanOrEqual(80);
    expect(
      outputs
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.chunk)
        .join(""),
    ).toContain("prefix-".repeat(1000));
    expect(JSON.stringify({ outputs, result })).not.toContain("secret-value");
    expect(result.commands[0]?.stdout).toContain("[REDACTED]");
    expect(result.commands[0]?.stderr).toContain("error-detail");
  });

  test("marks telemetry sink failures and reaps the process", async () => {
    const dir = await fixture();
    const result = await runVerificationCommands([command("output", "bun", ["-e", "console.log('output')"])], dir, {
      onOutput: () => {
        throw new Error("telemetry unavailable");
      },
    });
    expect(result.commands[0]).toMatchObject({
      status: "telemetry-error",
      error: "Could not retain verification output",
    });
    expect(result.ok).toBe(false);
  });

  test("redacts configured values from recorded command arguments", async () => {
    const dir = await fixture();
    const result = await runVerificationCommands(
      [
        command("argument", "bun", ["-e", "console.log(process.argv[1])", "secret-value"], {
          TEST_SECRET: "secret-value",
        }),
      ],
      dir,
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(result.commands[0]?.args).toContain("[REDACTED]");
  });

  test("redacts inherited named environment values and reports cancellation", async () => {
    const dir = await fixture();
    const controller = new AbortController();
    const previous = process.env.HARNESS_VERIFICATION_TEST_SECRET;
    process.env.HARNESS_VERIFICATION_TEST_SECRET = "inherited-secret";
    try {
      const first = await runVerificationCommands(
        [command("inherited", "bun", ["-e", "console.log(process.env.HARNESS_VERIFICATION_TEST_SECRET)"])],
        dir,
        { redactEnvironment: ["HARNESS_VERIFICATION_TEST_SECRET"] },
      );
      expect(first.commands[0]?.stdout).toContain("[REDACTED]");
      controller.abort();
      const cancelled = await runVerificationCommands([command("cancelled", "bun")], dir, {
        signal: controller.signal,
      });
      expect(cancelled.commands[0]).toMatchObject({ status: "cancelled", exitCode: null });
    } finally {
      if (previous === undefined) delete process.env.HARNESS_VERIFICATION_TEST_SECRET;
      else process.env.HARNESS_VERIFICATION_TEST_SECRET = previous;
    }
  });
});
