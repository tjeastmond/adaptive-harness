export interface ParsedOptions {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

/** Parses `--name value`, `--name=value`, and boolean `--flag` options. Each option may appear once. */
export function parseOptions(
  args: string[],
  spec: { values?: readonly string[]; flags?: readonly string[] },
): ParsedOptions | { error: string } {
  const valueNames = new Set(spec.values ?? []);
  const flagNames = new Set(spec.flags ?? []);
  const parsed: ParsedOptions = { positional: [], values: new Map(), flags: new Set() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      parsed.positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      parsed.positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (flagNames.has(name) && equals === -1) {
      if (parsed.flags.has(name)) return { error: `--${name} may only be given once` };
      parsed.flags.add(name);
    } else if (valueNames.has(name)) {
      const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
      if (!value || (equals === -1 && value.startsWith("--")) || parsed.values.has(name)) {
        return { error: `--${name} requires one value` };
      }
      parsed.values.set(name, value);
    } else {
      return { error: `Unknown option: ${arg}` };
    }
  }
  return parsed;
}

export function nonnegativeInteger(value: string | undefined): number | undefined {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
