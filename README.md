# adaptive-harness

Local-first agent harness: Jev for routing and completion decisions, Codex and Cursor for implementation, deterministic verification, and a replayable event stream.

Architecture and Milestone 1 plan: [adaptive-agent-harness-foundation.md](./adaptive-agent-harness-foundation.md).

## Prerequisites

- [Bun](https://bun.sh) >= 1.2.0

## Setup

```bash
bun install
```

## Development

```bash
bun run typecheck   # TypeScript across workspaces
bun run format      # Prettier (120 cols, double quotes, semicolons, trailing commas)
bun run check       # Prettier check + Biome lint
bun test            # Unit tests
bun run build       # Package build checks
bun run validate    # Full local quality gate
```

Example configuration files: `harness.example.yaml`, `harness.example.toml`.

Validate a configuration without starting a run:

```bash
export TYPESAFE_API_KEY=... # required by the example configuration
bun run apps/cli/src/cli.ts config validate --config harness.example.yaml
```

The CLI can also discover `harness.yaml`, `harness.yml`, or `harness.toml` in the current directory. If more than one exists, pass `--config` explicitly.

After a run database exists, inspect persisted runs without provider credentials:

```bash
bun run apps/cli/src/cli.ts runs list --config harness.yaml
bun run apps/cli/src/cli.ts runs show <run-id> --config harness.yaml --events
```

Both commands support `--json`. Use `--limit` to bound results; `runs show --events --after <sequence>` reads the next page of events. These commands read run history and do not start agents.

## Tracking work

Bugs, features, deferred tasks, and agent handoff notes live in **[GitHub Issues](https://github.com/tjeastmond/adaptive-harness/issues)**. Use the Bug, Feature, or Task / follow-up templates when creating issues.

See [.github/ISSUE_GUIDANCE.md](./.github/ISSUE_GUIDANCE.md) for labels, CLI examples, and conventions for humans and bots.
