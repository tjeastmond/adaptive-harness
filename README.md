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
