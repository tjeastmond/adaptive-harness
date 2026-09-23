import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repository = resolve(import.meta.dir, "../../..");
const cli = resolve(repository, "apps/cli/src/cli.ts");

const run = (...args: string[]) =>
  Bun.spawnSync(["bun", cli, ...args], {
    cwd: repository,
    env: { ...process.env, TYPESAFE_API_KEY: "fixture-secret" },
  });

describe("config validate CLI", () => {
  test("validates the example config without printing secrets", () => {
    const result = run("config", "validate", "--config", "harness.example.yaml");
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(output).toContain("Config valid:");
    expect(output).not.toContain("fixture-secret");
  });

  test("rejects incomplete and unsupported commands", () => {
    expect(run("config", "validate", "--config").exitCode).toBe(2);
    expect(run("run", "do something").exitCode).toBe(2);
  });
});
