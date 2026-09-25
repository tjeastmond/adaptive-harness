import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { LoadHarnessConfigOptions } from "../src/index.ts";
import { loadHarnessConfig as load, ProviderSchema } from "../src/index.ts";

const dirs: string[] = [];
const repo = resolve(import.meta.dir, "../../..");
const yamlExample = await readFile(join(repo, "harness.example.yaml"), "utf8");
const tomlExample = await readFile(join(repo, "harness.example.toml"), "utf8");
const loadHarnessConfig = (options: LoadHarnessConfigOptions = {}) =>
  load({ ...options, env: { TYPESAFE_API_KEY: "test-key", ...options.env } });

async function fixture(name = "harness.yaml", content = yamlExample): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp("/private/tmp/adaptive-harness-config-");
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, content);
  return { dir, path };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadHarnessConfig", () => {
  test("defaults Cursor to the cursor-agent executable", () => {
    expect(ProviderSchema.parse({ kind: "cursor-cli" }).command).toBe("cursor-agent");
  });
  test("normalizes equivalent YAML and TOML examples to the same config and hash", async () => {
    const { dir } = await fixture();
    await writeFile(join(dir, "harness.toml"), tomlExample);
    const yaml = await loadHarnessConfig({ cwd: dir, configPath: "harness.yaml" });
    const toml = await loadHarnessConfig({ cwd: dir, configPath: "harness.toml" });
    expect(yaml.config).toEqual(toml.config);
    expect(yaml.hash).toBe(toml.hash);
    expect(yaml.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(yaml.config.project.workspace).toBe(dir);
    expect(yaml.config.storage.database).toBe(join(dir, ".harness/harness.sqlite"));
    expect(yaml.config.providers.codex?.model).toBeNull();
  });

  test("discovers each default extension and rejects ambiguity", async () => {
    const { dir } = await fixture("harness.yml");
    expect((await loadHarnessConfig({ cwd: dir })).path).toBe(join(dir, "harness.yml"));
    await writeFile(join(dir, "harness.toml"), tomlExample);
    await expect(loadHarnessConfig({ cwd: dir })).rejects.toThrow("Multiple default config files");
    expect((await loadHarnessConfig({ cwd: dir, configPath: "harness.toml" })).path).toBe(join(dir, "harness.toml"));
  });

  test("reports missing and unsupported explicit config paths", async () => {
    const { dir } = await fixture("custom.yaml");
    await expect(loadHarnessConfig({ cwd: dir })).rejects.toThrow("No config file found");
    await expect(loadHarnessConfig({ cwd: dir, configPath: "missing.yaml" })).rejects.toThrow("Config file not found");
    await writeFile(join(dir, "custom.json"), "{}");
    await expect(loadHarnessConfig({ cwd: dir, configPath: "custom.json" })).rejects.toThrow("Cannot parse");
  });

  test("interpolates ordinary env placeholders and rejects missing or unsupported syntax", async () => {
    const { dir, path } = await fixture();
    await writeFile(path, yamlExample.replace("name: adaptive-harness", "name: ${" + "PROJECT_NAME}"));
    expect((await loadHarnessConfig({ cwd: dir, env: { PROJECT_NAME: "demo" } })).config.project.name).toBe("demo");
    await expect(loadHarnessConfig({ cwd: dir, env: {} })).rejects.toThrow(
      "config.project.name: missing environment variable PROJECT_NAME",
    );
    await writeFile(path, yamlExample.replace("name: adaptive-harness", "name: $PROJECT_NAME"));
    await expect(loadHarnessConfig({ cwd: dir })).rejects.toThrow(
      "config.project.name: unsupported environment interpolation syntax",
    );
    await writeFile(path, yamlExample.replace("name: adaptive-harness", "name: project-$5"));
    expect((await loadHarnessConfig({ cwd: dir })).config.project.name).toBe("project-$5");
    await writeFile(path, yamlExample.replace("name: adaptive-harness", "name: project-${" + "bad-name}"));
    await expect(loadHarnessConfig({ cwd: dir })).rejects.toThrow(
      "config.project.name: unsupported environment interpolation syntax",
    );
  });

  test("keeps secret values out of the config and diagnostics", async () => {
    const { dir, path } = await fixture();
    const env = { TYPESAFE_API_KEY: "very-secret-value" };
    await writeFile(path, yamlExample.replace("name: adaptive-harness", "name: ${" + "TYPESAFE_API_KEY}"));
    try {
      await loadHarnessConfig({ cwd: dir, env });
      throw new Error("Expected rejection");
    } catch (error) {
      expect(String(error)).toContain("config.project.name: secret environment variable cannot be interpolated");
      expect(String(error)).not.toContain(env.TYPESAFE_API_KEY);
    }
    await writeFile(path, yamlExample.replace("name: adaptive-harness", `name: ${env.TYPESAFE_API_KEY}`));
    await expect(loadHarnessConfig({ cwd: dir, env })).rejects.toThrow("secret environment value");
    await writeFile(path, yamlExample.replace("name: adaptive-harness", `name: before-${env.TYPESAFE_API_KEY}-after`));
    await expect(loadHarnessConfig({ cwd: dir, env })).rejects.toThrow("secret environment value");
    await writeFile(path, yamlExample);
    await expect(load({ cwd: dir, env: {} })).rejects.toThrow("missing secret environment variable TYPESAFE_API_KEY");
    expect((await load({ cwd: dir, env: {}, requireSecrets: false })).config.project.name).toBe("adaptive-harness");
    await expect(loadHarnessConfig({ cwd: dir, env: { TYPESAFE_API_KEY: basename(dir) } })).rejects.toThrow(
      "secret environment value",
    );
  });

  test("reports unknown keys and invalid provider or routing references with paths", async () => {
    const { dir, path } = await fixture();
    await writeFile(path, yamlExample.replace("workspace: .", "workspace: .\n  surprise: true"));
    await expect(loadHarnessConfig({ cwd: dir })).rejects.toThrow("config.project.surprise: unknown key");
    await writeFile(path, yamlExample.replace("provider: composer", "provider: missing"));
    await expect(loadHarnessConfig({ cwd: dir })).rejects.toThrow(
      "config.agents.implementer.provider: Unknown provider reference",
    );
    await writeFile(path, yamlExample.replace("reviewerAgent: reviewer", "reviewerAgent: missing"));
    await expect(loadHarnessConfig({ cwd: dir })).rejects.toThrow(
      "config.routing.reviewerAgent: Unknown agent reference",
    );
  });

  test("parser errors do not include source text", async () => {
    const { dir } = await fixture("harness.yaml", "[very-secret-value");
    await expect(loadHarnessConfig({ cwd: dir })).rejects.toThrow("Cannot parse");
    try {
      await loadHarnessConfig({ cwd: dir });
    } catch (error) {
      expect(String(error)).not.toContain("very-secret-value");
    }
  });

  test("resolves paths relative to explicit config location", async () => {
    const { dir, path } = await fixture("custom.yaml");
    const result = await loadHarnessConfig({ cwd: dirname(dir), configPath: path });
    expect(result.config.project.workspace).toBe(dir);
  });
});
