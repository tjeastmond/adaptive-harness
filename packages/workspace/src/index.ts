import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileChange } from "@adaptive-harness/core";

export interface GitPolicy {
  requireRepository: boolean;
  requireClean: boolean;
  allowUntracked: boolean;
}

export interface GitStatusEntry {
  path: string;
  code: string;
  originalPath?: string;
  fingerprint: string;
}

export interface GitState {
  root: string;
  head: string | null;
  /** Ignored files are excluded, as in ordinary Git status. */
  entries: GitStatusEntry[];
  /** Full tracked diff against HEAD, including changes present before a worker ran. */
  trackedDiffStat: string;
}

export interface RepositoryPreflight {
  ok: boolean;
  root?: string;
  state?: GitState;
  reasons: string[];
}

export interface GitEvidence {
  /** Paths already dirty before execution; unchanged baseline paths are not attributed to the worker. */
  baselineChanges: FileChange[];
  /** Paths whose content, index, or status changed since the baseline snapshot. */
  changesSinceBaseline: FileChange[];
  /** Full tracked diff against the baseline HEAD. This can include baseline changes. */
  trackedDiffStat: string;
  headChanged: boolean;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(`Git ${args[0] ?? "command"} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
}

async function git(workspace: string, args: string[]): Promise<string> {
  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn(["git", "-C", workspace, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error(`Unable to start Git: ${String(error)}`, { cause: error });
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout as ReadableStream<Uint8Array>).text(),
    new Response(process.stderr as ReadableStream<Uint8Array>).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new GitCommandError(args, stderr, exitCode);
  return stdout;
}

function parseStatus(output: string): Array<Omit<GitStatusEntry, "fingerprint">> {
  const tokens = output.split("\0");
  const entries: Array<Omit<GitStatusEntry, "fingerprint">> = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (token.length < 4 || token[2] !== " " || !path) throw new Error("Invalid Git status output");
    if (code.includes("R") || code.includes("C")) {
      const originalPath = tokens[++index];
      if (!originalPath) throw new Error("Invalid Git rename status output");
      entries.push({ code, path, originalPath });
    } else {
      entries.push({ code, path });
    }
  }
  return entries;
}

async function fileFingerprint(root: string, path: string): Promise<string> {
  const absolute = join(root, path);
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return hash(`link:${await readlink(absolute)}`);
    if (stat.isFile()) {
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) digest.update(chunk);
      return hash(`${stat.mode}:${digest.digest("hex")}`);
    }
    // A dirty submodule appears as one directory entry in the parent status.
    // A directory stat cannot prove its nested contents stayed unchanged.
    throw new Error(`Cannot fingerprint directory or special path: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export async function captureGitState(workspace: string): Promise<GitState> {
  const root = resolve((await git(workspace, ["rev-parse", "--show-toplevel"])).trim());
  const [headResult, status, trackedDiffStat] = await Promise.all([
    git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => null),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, ["diff", "--stat", "HEAD"]).catch(async () => git(root, ["diff", "--stat"])),
  ]);
  const statusEntries = parseStatus(status);
  const entries: GitStatusEntry[] = [];
  for (let offset = 0; offset < statusEntries.length; offset += 16) {
    const batch = statusEntries.slice(offset, offset + 16);
    entries.push(
      ...(await Promise.all(
        batch.map(async (entry) => {
          const [fileHash, indexState] = await Promise.all([
            fileFingerprint(root, entry.path),
            git(root, ["ls-files", "--stage", "--", entry.path]),
          ]);
          return { ...entry, fingerprint: hash(`${entry.code}\0${fileHash}\0${indexState}`) };
        }),
      )),
    );
  }
  return { root, head: headResult?.trim() ?? null, entries, trackedDiffStat };
}

/** Resolves symlinks in the longest existing prefix, so paths that do not exist yet compare like their parents. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(absolute) === absolute) throw error;
    return join(await canonicalPath(dirname(absolute)), basename(absolute));
  }
}

/**
 * Whether `path` lies inside the workspace's repository without a Git ignore rule covering it. Harness storage
 * in such a location would show up as an untracked change and as drift between harness observations.
 */
export async function isUnignoredRepositoryPath(workspace: string, path: string): Promise<boolean> {
  let root: string;
  try {
    root = await canonicalPath((await git(workspace, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return false;
  }
  const inside = relative(root, await canonicalPath(path));
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return false;
  try {
    await git(root, ["check-ignore", "-q", "--no-index", "--", inside]);
    return false;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return true;
    throw error;
  }
}

export async function preflightRepository(workspace: string, policy: GitPolicy): Promise<RepositoryPreflight> {
  let state: GitState;
  try {
    state = await captureGitState(workspace);
  } catch (error) {
    const isNonRepository =
      error instanceof GitCommandError && error.args[0] === "rev-parse" && /not a git repository/i.test(error.stderr);
    const ok = !policy.requireRepository && isNonRepository;
    return {
      ok,
      reasons: ok ? [] : [`Repository preflight failed: ${String(error)}`],
    };
  }
  const tracked = state.entries.some((entry) => entry.code !== "??");
  const untracked = state.entries.some((entry) => entry.code === "??");
  const reasons: string[] = [];
  if (policy.requireClean && tracked) reasons.push("Tracked worktree or index changes are present");
  if (!policy.allowUntracked && untracked) reasons.push("Untracked files are present");
  return { ok: reasons.length === 0, root: state.root, state, reasons };
}

function toFileChange(entry: GitStatusEntry): FileChange {
  const code = entry.code;
  const status: FileChange["status"] =
    code === "??" || code.includes("A")
      ? "added"
      : code.includes("D")
        ? "deleted"
        : code.includes("R")
          ? "renamed"
          : code.includes("M") || code.includes("T") || code.includes("U")
            ? "modified"
            : "unknown";
  return { path: entry.path, status };
}

function parseNameStatus(output: string): FileChange[] {
  const tokens = output.split("\0");
  const changes: FileChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++];
    if (!code) break;
    const oldPath = tokens[index++];
    if (!oldPath) throw new Error("Invalid Git diff name-status output");
    if (code.startsWith("R") || code.startsWith("C")) {
      const newPath = tokens[index++];
      if (!newPath) throw new Error("Invalid Git rename diff output");
      changes.push({ path: newPath, status: "renamed" });
    } else {
      const status: FileChange["status"] =
        code === "A" ? "added" : code === "D" ? "deleted" : code === "M" || code === "T" ? "modified" : "unknown";
      changes.push({ path: oldPath, status });
    }
  }
  return changes;
}

export async function compareGitStates(before: GitState, after: GitState): Promise<GitEvidence> {
  if (before.root !== after.root) throw new Error("Cannot compare Git states from different repositories");
  const baseline = new Map(before.entries.map((entry) => [entry.path, entry]));
  const final = new Map(after.entries.map((entry) => [entry.path, entry]));
  const changesSinceBaseline: FileChange[] = [];
  for (const path of new Set([...baseline.keys(), ...final.keys()])) {
    const oldEntry = baseline.get(path);
    const newEntry = final.get(path);
    if (oldEntry?.fingerprint === newEntry?.fingerprint && oldEntry?.originalPath === newEntry?.originalPath) continue;
    if (newEntry) changesSinceBaseline.push(toFileChange(newEntry));
    else if (oldEntry) {
      const status = oldEntry.code === "??" || oldEntry.code.includes("A") ? "deleted" : toFileChange(oldEntry).status;
      changesSinceBaseline.push({ path, status });
    }
  }
  const headChanged = before.head !== after.head;
  const baselineHead =
    before.head ?? (headChanged ? (await git(after.root, ["hash-object", "-t", "tree", "/dev/null"])).trim() : null);
  if (headChanged && after.head) {
    const committed = parseNameStatus(
      await git(after.root, ["diff", "--name-status", "-z", "--find-renames", baselineHead ?? "", after.head]),
    );
    const observed = new Set(changesSinceBaseline.map((change) => change.path));
    for (const change of committed) {
      if (!observed.has(change.path)) changesSinceBaseline.push(change);
    }
  }
  const trackedDiffStat =
    headChanged && baselineHead ? await git(after.root, ["diff", "--stat", baselineHead]) : after.trackedDiffStat;
  return {
    baselineChanges: before.entries.map(toFileChange),
    changesSinceBaseline,
    trackedDiffStat,
    headChanged,
  };
}
