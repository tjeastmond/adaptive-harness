# GitHub Issues on adaptive-harness

GitHub Issues are the **durable backlog** for this repo: bugs, features, milestone work, and notes from humans or bots.

Local scratch notes may go in [`.agents/ISSUES.md`](../.agents/ISSUES.md) during a session, but **open or update a GitHub issue** when the item should outlive the chat or branch.

## When to open an issue

| Situation                                       | Template             |
| ----------------------------------------------- | -------------------- |
| Broken behavior or regression                   | **Bug**              |
| New product capability                          | **Feature**          |
| Finish later, refactor, review finding, handoff | **Task / follow-up** |

Agents and harness bots should **comment on existing issues** when adding detail, and **open a new issue** when the work is distinct.

## Labels

| Label         | Use                                                |
| ------------- | -------------------------------------------------- |
| `bug`         | Incorrect behavior                                 |
| `enhancement` | New capability                                     |
| `task`        | Follow-up or implementation chunk                  |
| `bot-report`  | Filed or primarily driven by an automated agent    |
| `deferred`    | Explicitly not in the current milestone            |
| `milestone`   | Tied to a numbered milestone in the foundation doc |

Maintainers may add area labels later (`config`, `runtime`, etc.) as volume grows.

## Creating issues from the CLI

Requires [GitHub CLI](https://cli.github.com/) and repo access:

```bash
gh issue create \
  --repo tjeastmond/adaptive-harness \
  --title "[task]: implement config loader (Milestone 1.1)" \
  --label "task,milestone" \
  --body "$(cat <<'EOF'
## Context
...

## Work to do
- [ ] ...
EOF
)"
```

Add `bot-report` when an agent files on its own findings:

```bash
gh issue create --label "bug,bot-report" ...
```

## Bot and agent conventions

1. **One issue per logical item**—do not combine unrelated bugs or tasks.
2. Put **reproduction steps, paths, and commit SHAs** in the body, not only in chat.
3. Reference the **foundation doc milestone** (e.g. 1.1, 1.6) when scope matches, and assign the issue to the corresponding GitHub Milestone.
4. Do **not** assign credit to tools in titles or bodies (no “Cursor found…”—state the finding neutrally).
5. Link PRs with `Fixes #123` or `Refs #123` in the PR description when applicable.
6. Add each durable issue to the [adaptive-harness GitHub Project](https://github.com/users/tjeastmond/projects/2) so the product backlog and milestone progress stay connected.

## Issue lifecycle

- **Open** → work planned or in progress
- **Comment** → progress, new evidence, blocked reason
- **Close** → fixed, wontfix, or superseded (say which in the closing comment)
