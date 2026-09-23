import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { type HarnessConfig, HarnessConfigSchema } from "./schema.ts";

export type { HarnessConfig, ProviderConfig } from "./schema.ts";
export { HarnessConfigSchema, ProviderSchema } from "./schema.ts";
export const CONFIG_SCHEMA_VERSION = 1 as const;

export interface LoadHarnessConfigOptions {
  cwd?: string;
  configPath?: string;
  env?: Record<string, string | undefined>;
}

const defaultFiles = ["harness.yaml", "harness.yml", "harness.toml"] as const;

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw new Error(`Cannot inspect config file: ${path}`);
  }
}

async function discover(cwd: string, configPath?: string): Promise<string> {
  if (configPath !== undefined) {
    const path = resolve(cwd, configPath);
    if (!(await exists(path))) throw new Error(`Config file not found: ${path}`);
    return path;
  }
  const paths = defaultFiles.map((name) => resolve(cwd, name));
  const found: string[] = [];
  for (const path of paths) if (await exists(path)) found.push(path);
  if (found.length === 0)
    throw new Error(`No config file found in ${cwd}; expected harness.yaml, harness.yml, or harness.toml`);
  if (found.length > 1) throw new Error(`Multiple default config files found in ${cwd}; select one with --config`);
  const only = found[0];
  if (!only) throw new Error(`No config file found in ${cwd}`);
  return only;
}

function parseSource(source: string, path: string): unknown {
  try {
    switch (extname(path).toLowerCase()) {
      case ".yaml":
      case ".yml":
        return parseYaml(source, { uniqueKeys: true });
      case ".toml":
        return parseToml(source);
      default:
        throw new Error("unsupported extension");
    }
  } catch {
    throw new Error(`Cannot parse ${path}: invalid YAML or TOML syntax`);
  }
}

function atPath(path: readonly PropertyKey[]): string {
  return path.length ? `config.${path.map(String).join(".")}` : "config";
}

function secretNames(raw: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return names;
  const root = raw as Record<string, unknown>;
  const decision = root.decision as Record<string, unknown> | undefined;
  const jev = decision?.jev as Record<string, unknown> | undefined;
  if (typeof jev?.apiKeyEnv === "string") names.add(jev.apiKeyEnv);
  else names.add("TYPESAFE_API_KEY");
  const telemetry = root.telemetry as Record<string, unknown> | undefined;
  if (Array.isArray(telemetry?.redactEnvironment)) {
    for (const item of telemetry.redactEnvironment) if (typeof item === "string") names.add(item);
  }
  return names;
}

function interpolate(
  raw: unknown,
  env: Record<string, string | undefined>,
  secrets: Set<string>,
  path: (string | number)[] = [],
): unknown {
  if (typeof raw === "string") {
    if (!raw.includes("$")) return raw;
    if (path.join(".") === "decision.jev.apiKeyEnv" || path.slice(0, 2).join(".") === "telemetry.redactEnvironment") {
      throw new Error(`${atPath(path)}: secret environment variable names cannot be interpolated`);
    }
    let result = "";
    for (let index = 0; index < raw.length;) {
      if (raw[index] !== "$") {
        result += raw[index++];
        continue;
      }
      if (raw[index + 1] !== "{") {
        if (/^[A-Za-z_]/.test(raw[index + 1] ?? "")) {
          throw new Error(`${atPath(path)}: unsupported environment interpolation syntax`);
        }
        result += "$";
        index++;
        continue;
      }
      const match = /^\$\{([A-Z_][A-Z0-9_]*)\}/.exec(raw.slice(index));
      if (!match) throw new Error(`${atPath(path)}: unsupported environment interpolation syntax`);
      const name = match[1];
      if (!name) throw new Error(`${atPath(path)}: unsupported environment interpolation syntax`);
      if (secrets.has(name)) throw new Error(`${atPath(path)}: secret environment variable cannot be interpolated`);
      const value = env[name];
      if (value === undefined) throw new Error(`${atPath(path)}: missing environment variable ${name}`);
      result += value;
      index += match[0].length;
    }
    return result;
  }
  if (Array.isArray(raw)) return raw.map((item, index) => interpolate(item, env, secrets, [...path, index]));
  if (typeof raw === "object" && raw !== null) {
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, interpolate(value, env, secrets, [...path, key])]),
    );
  }
  return raw;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secret));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, item]) => key.includes(secret) || containsSecret(item, secret));
  }
  return false;
}

/** Load, validate, normalize and fingerprint a version 1 harness configuration. */
export async function loadHarnessConfig(
  options: LoadHarnessConfigOptions = {},
): Promise<{ path: string; config: HarnessConfig; hash: string }> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const path = await discover(cwd, options.configPath);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(`Cannot read config file: ${path}`);
  }
  const raw = parseSource(source, path);
  const env = options.env ?? process.env;
  const names = secretNames(raw);
  const expanded = interpolate(raw, env, names);
  const parsed = HarnessConfigSchema.safeParse(expanded);
  if (!parsed.success) {
    const sensitive = [...names].map((name) => env[name]).filter((value): value is string => Boolean(value));
    const issues = parsed.error.issues.flatMap((issue) => {
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => {
          const safeKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !sensitive.some((value) => key.includes(value));
          return `${atPath(safeKey ? [...issue.path, key] : issue.path)}: unknown key`;
        });
      }
      return [`${atPath(issue.path)}: ${issue.code === "custom" ? issue.message : "invalid value"}`];
    });
    throw new Error(`Invalid config in ${path}:\n${issues.join("\n")}`);
  }
  const config: HarnessConfig = {
    ...parsed.data,
    project: { ...parsed.data.project, workspace: resolve(dirname(path), parsed.data.project.workspace) },
    storage: { ...parsed.data.storage, database: resolve(dirname(path), parsed.data.storage.database) },
  };
  const declaredSecrets = new Set([config.decision.jev.apiKeyEnv, ...config.telemetry.redactEnvironment]);
  for (const name of declaredSecrets) {
    const value = env[name];
    if (!value) throw new Error(`Invalid config in ${path}: missing secret environment variable ${name}`);
    if (containsSecret(config, value)) {
      throw new Error(`Invalid config in ${path}: secret environment value for ${name} must not be stored in config`);
    }
  }
  const hash = createHash("sha256").update(canonicalJson(config)).digest("hex");
  return { path, config, hash };
}
