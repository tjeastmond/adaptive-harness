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

The Jev contract tests use a sanitized recorded API fixture. To run the live smoke test with `TYPESAFE_API_KEY` set:

```bash
JEV_LIVE_SMOKE=1 bun test packages/decisions/test/jev.live.test.ts
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

### Running agents

```bash
export TYPESAFE_API_KEY=...
bun run apps/cli/src/cli.ts run "Add cursor pagination to the users endpoint" --config harness.yaml
```

`run` creates a run in the configured workspace (or `--workspace`), streams its events, and prints the final status. If Jev asks for input, the run pauses and prints the approval ID and its choices:

```bash
bun run apps/cli/src/cli.ts approvals answer <request-id> <answer> --config harness.yaml
```

Headless `cursor-agent` refuses to run in a workspace you have not trusted, and the harness does not trust one on your behalf. To run Cursor workers in a new checkout or worktree, add `--trust` to the Cursor provider's `extraArgs`. `providers doctor` notes when it is missing, and a refused call reports the same remedy.

Other run controls:

- `runs watch <run-id> [--after sequence]` follows a run's events until it finishes.
- `pause <run-id>` and `cancel <run-id>` request a control change. A run driven by another process applies it at its next poll.
- `resume <run-id>` continues a paused run in the current process.
- `agents list` shows the configured agents and their routing roles.
- `providers doctor` checks the Jev key and each worker CLI, and exits non-zero if any check fails.

Driving commands (`run`, `resume`, `approvals answer`) need the Jev API key. The exception is a deterministic decision mode, selected with `--decision-mode deterministic` or the config's bypass variable (`HARNESS_DECISION_MODE=deterministic` by default). That mode is recorded as a `decision.bypassed` event. On startup these commands pause any run whose previous process stopped renewing its lease; resume it with `resume`.

The run database must not appear as an untracked file in the workspace repository. The default `storage.database` is `.harness/harness.sqlite` next to the config. If that location is inside the workspace, add `.harness/` to the workspace's `.gitignore`; otherwise the run fails before any worker starts.

### Evaluating Jev

`bun run eval` runs a fixed set of small tasks twice with the same worker. One arm uses Jev decisions and the other uses the deterministic bypass. The report compares the arms on:

- Verified results.
- Interventions: approvals the eval answered as the user.
- Worker, review, and retry calls.
- Worker tokens.
- Whether the route chose the expected task kind.

```bash
bun run eval                       # simulated workers; Jev is the only real service called
bun run eval --arms deterministic  # no network calls at all
bun run eval --live-workers --provider cursor --tasks settings-port,notes-typo
bun run eval --list                # task ids
```

By default, workers are simulated: each task's scripted change is applied without calling Codex or Cursor, and worker usage is estimated from text length. `--live-workers` (or `HARNESS_EVAL_LIVE_WORKERS=1`) calls the real worker CLI instead; start with a few tasks, because live workers spend real tokens.

Other behavior:

- **Missing key:** the Jev arm is skipped if `TYPESAFE_API_KEY` is not set. Bun loads it from `.env.local` in the repository root.
- **Workspaces:** each task runs in a fresh temporary Git repository, deleted afterward unless you pass `--keep`.
- **Results:** written to `.harness/eval/` as JSON.

The eval compares Jev with the bypass. It does not benchmark worker providers against each other.

## Tracking work

Bugs, features, deferred tasks, and agent handoff notes live in **[GitHub Issues](https://github.com/tjeastmond/adaptive-harness/issues)**. Use the Bug, Feature, or Task / follow-up templates when creating issues.

See [.github/ISSUE_GUIDANCE.md](./.github/ISSUE_GUIDANCE.md) for labels, CLI examples, and conventions for humans and bots.
