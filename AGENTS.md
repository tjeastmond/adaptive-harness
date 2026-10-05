# Adaptive Harness agent guide

## Source of truth

- Read `adaptive-agent-harness-foundation.md` before changing runtime contracts or architecture.
- Preserve the package boundaries. The CLI is a client of `HarnessRuntime`; it must not own orchestration, provider execution, persistence, or decision policy.
- Jev makes bounded, typed decisions. TypeScript enforces policy and performs execution. The deterministic decision mode is an explicit, observable bypass.

## Current architectural direction

The original foundation is being revised to adopt the Jev state/context model. Treat these as required design seams before deep implementation work begins:

1. `StateStore` and typed `StateChunk`s are the canonical run state; transcripts are not.
2. `ContextAssembler` builds per-operation context from state chunks.
3. `DecisionGateway` anticipates decisions for routing, context visibility, tools, permissions, delegation, and completion.
4. Tasks declare read/write access semantics and optional resource scope.
5. Capabilities are exposed through a registry, enabling tiered tool disclosure later. Prefer existing CLIs, MCP servers, and installed skills; the harness does not recreate their integrations.
6. Context-compression providers, including Headroom if adopted, remain implementations behind the harness-owned context abstraction.

Cost optimization targets worker usage in Cursor, Codex, and Claude. Jev call cost is negligible for this project; use Jev where its bounded decisions can reduce worker tokens, irrelevant context, or unnecessary worker calls. Evaluate savings against worker spend and task quality, rather than optimizing Jev calls away.

Do not implement advanced dynamic tool loading, broad parallel write execution, or elaborate context compression until these contracts and their focused vertical slice are established.

## Capability boundary

- The harness owns discovery, configuration, context selection, policy, invocation records, and typed results.
- Existing tools own their domain behavior. For example, use the `gh` CLI for GitHub work rather than implementing a GitHub API client.
- A capability may be backed by an installed CLI, an MCP server, an existing skill, or an agent provider. New built-in integrations need a concrete justification.
- Keep the initial registry small and configured: Git, shell, `gh`, configured verification commands, Codex, and Cursor. MCP and skills can be registered when needed.

## Work tracking

**GitHub Issues is the canonical system for tasks, bugs, features, follow-ups, and durable handoffs.** Use the repository's [Issues tab](https://github.com/tjeastmond/adaptive-harness/issues), its issue forms, and `.github/ISSUE_GUIDANCE.md`.

- Use `.agents/ISSUES.md` only for short-lived session scratch notes.
- Open or update one GitHub issue for work that persists beyond the current session or branch.
- Reference the relevant foundation milestone and include paths, verification evidence, and commit SHAs when available.
- Keep one logical item per issue; use issue comments for new evidence on an existing item.
- Refer to the project owner as TJ in issues, pull requests, commits, and comments, not as "the repo owner" or "the user".

## Git and PR hygiene

- An agent may merge its pull request without asking when all of these hold: `bun run validate` passes on the final commit, every Dr. Nit finding is resolved, no identified duplicated-code or security concern remains unresolved, and the agent has checked each of the task's stated requirements (its issue or definition of done) against the PR and found it met. Otherwise, ask the user before merging and say which condition is unmet.
- When merging a pull request, use `gh pr merge --delete-branch` and verify the remote branch is gone. If a linked worktree has the branch checked out, `gh` cannot delete the local branch and may leave the remote one; delete it with `git push origin --delete <branch>`.
- After merging, remove the source branch's linked worktree, if any, with `git worktree remove <path>` (never `--force`), but only when all of these hold: `git status` in it is clean, it has no commits beyond what was merged, and no active agent still uses it. Otherwise keep it and tell the user which worktree was kept and why.
- Then prune stale remote-tracking refs and delete the local source branch, unless its worktree was kept.
- Never delete a branch with uncommitted changes or while an active agent still needs that branch.
- Do not attribute work to any AI agent or coding tool. Commits, PR titles and bodies, issue and review comments, and code must not include `Co-Authored-By` trailers, "Generated with" footers, or mentions of Claude, Codex, Cursor, or any other agent or model as an author.

## Implementation expectations

- Supported platforms are macOS (primary) and other Unix systems. Windows is not supported; do not add Windows-specific code paths or review findings.
- Keep changes narrowly scoped and add focused tests with the implementation.
- Run the relevant Bun checks before handoff; do not claim verification that was not run.
- Request an independent, read-only Dr. Nit review for every PR before merging, and for substantial changes made directly on `main` before handoff. Scope the review to the PR's changes (or the direct change) rather than the whole repository. Its skill is at `~/.codex/skills/dr-nit/SKILL.md`; agents that do not load Codex skills automatically should read that file and follow its scoped review and reporting instructions. Address findings and rerun relevant checks before merging or handing off.
- Treat provider output and stored raw events as untrusted input, redact secrets, and preserve bounded event/context retention.
- Update the foundation document only when an accepted decision changes a contract.

## Using Jev with Claude

This section directs Claude sessions (see the `typesafe:typesafe-ai` skill for Jev's API and question design). Its purpose is to spend fewer Claude tokens without lowering quality: Jev picks the cheapest sufficient profile, and the host enforces it.

1. **Ask Jev once per task, before starting work.** No Jev connector or MCP server is installed, so call the HTTP API described by the `typesafe-ai` skill directly with `curl`. Send one Choice question over the task description (goal, issue number, rough file count) to `https://api.typesafe.ai/v1/systemone` with model `jev-latest`, using `TYPESAFE_API_KEY` from the gitignored `.env.local`. Load the key into the shell without printing it and never put it in output, commits, or issues. Ask "Which host-approved profile is the cheapest one that will complete the task at good quality?" with these options:
   - `single-medium`: one Sonnet 5.5 session at medium effort. A clear, well-scoped coding or docs change touching a few files.
   - `single-high`: one Sonnet 5.5 session at high effort. Ambiguous design, subtle debugging, contract changes, or JSON/schema-heavy work.
   - `lead-plus-subagent`: the lead session plus one Sonnet 5.5 medium-effort implementation subagent in a worktree. A substantial multi-file change with a clear spec, as in the task workflow below.
2. **The host checks and applies the answer.** Accept only a profile named above. If Jev errors, returns anything else, or has confidence below 0.6 (a provisional threshold; adjust it from observed results), use `single-medium`. Set the model when starting any subagent (the Agent tool's `model` parameter) and keep it fixed for that session. Effort cannot be set per subagent from within a session. Apply it only where the host exposes it, and say so instead of claiming it was applied. Jev never changes permissions or approvals.
3. **Do not ask again mid-task.** Re-ask only if the task's scope changes materially, such as a clear fix turning into a contract change.
4. **A second Claude is for the `lead-plus-subagent` profile, or for independent research or a review the user requested.** Dr. Nit reviews go through Codex, not a second Claude. Give it the task, the specific files and issue excerpts it needs, its limits, and its completion requirements, not the whole conversation. It returns a short summary of findings and evidence, not transcripts or file dumps.
5. **Scope.** Do not add features, documentation, refactors, or extra review rounds beyond the task. The tests, Dr. Nit reviews, and fix-and-rereview rounds this guide requires are part of the task. Ask the user only when you cannot continue without input or before an action that needs approval, including a merge whose conditions are unmet.
6. **Completion check.** Before reporting completion, run `bun run validate`. For a change it does not cover, such as docs only, run the closest relevant check. If no check can run, say which one and why. When the work is done and checked, stop and report the result.
7. **Track evidence.** Whether this saves tokens and time is unproven, so append one row per task to `.agents/jev-log.md` (create it with a header on first use) and commit it with the task's PR. Columns: date, issue or PR, profile Jev chose, confidence, whether the fallback was used, wall-clock minutes from the Jev call to the completion check, `bun run validate` runs, Dr. Nit rounds, token use if the session reports it, and a short note on whether the profile fit. Record only what was observed. Leave a column blank rather than estimating it. Review the log with TJ after about ten tasks and adjust the profiles and the confidence threshold from it.

## Claude-specific rules

These rules apply to Claude agent sessions (Claude Code in the terminal or the Claude desktop app), not to this project's `apps/cli`. A pattern-based `pkill` run by a Claude agent once terminated every application on the user's machine.

- Never terminate processes by name or pattern. Do not use `pkill`, `killall`, or `kill` on PIDs found by searching. `pkill -f` matches the pattern against each process's full command line, so a short pattern hits unrelated processes; for example, `cat` matches every app launched from `/Applications` because its executable path contains "Applications".
- Stop only processes you started: use the task-stop tool with the task ID of a background command, or let a foreground command finish or time out. If one cannot be stopped that way, report it to the user instead of searching for it.
- Limit machine use to the command line for this project: Git, `gh`, `bun`, and reading and editing files in the repository and your scratch directory. Do not use desktop, browser, AppleScript, or other app-control tools, and do not change other applications or system state.
- Avoid commands that wait for interactive input, such as a bare `cat` with no file.

### Task workflow

Claude sessions follow this sequence for each task:

1. **Plan.** The main session picks a GitHub issue, scopes it, and writes a self-contained spec.
2. **Implement.** For substantial changes, a Sonnet subagent implements the spec in an isolated worktree, adds focused tests, runs `bun run validate`, and commits without pushing. The main session makes trivial changes itself.
3. **Verify.** The main session reads the diff, mutation-checks each new test (temporarily remove the logic, confirm the test fails, restore it; never while validate is running), and reruns `bun run validate` itself.
4. **Open the PR.** Push the branch and open the PR with `Fixes #N`.
5. **Review.** Run the Dr. Nit review with Codex directly, not through a wrapper agent, from a checkout of the PR's source branch (its worktree, if it has one) so that `git diff main...HEAD` holds the PR's changes: `node ~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs task "<prompt>"`. The prompt tells Codex to read and follow `~/.codex/skills/dr-nit/SKILL.md`, scopes it to `git diff main...HEAD`, and tells it not to run `gh` or typecheck, which fail in its sandbox. Never pass `--write`; the reviewer stays read-only.
6. **Post.** Post Codex's findings verbatim as a new PR comment under a `## Dr. Nit review` heading, and show the user the exact command and Codex's final output.
7. **Fix.** Send substantive fixes to the Sonnet subagent; the main session may make trivial fixes itself. Rerun `bun run validate`, push the fixes, confirm the PR head is the validated commit, then post a PR comment describing each fix and its verification. After substantive fixes, repeat steps 5 and 6 from the same branch, posting each repeat review as a new comment.
8. **Merge and clean up** as described in Git and PR hygiene.
