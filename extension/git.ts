// The git facts chef needs, and nothing else. Every function is idempotent and
// async, so a slow repository never stalls the Pi event loop.

import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { ChefError } from "./domain.ts";
import type { GitFacts } from "./derive.ts";

const run = promisify(execFile);
const DIFFSTAT_LINES = 40;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new ChefError(`git ${args.join(" ").slice(0, 120)} failed: ${(err.stderr || err.message).trim().slice(0, 400)}`);
  }
}

async function ok(cwd: string, args: string[]): Promise<boolean> {
  try {
    await run("git", args, { cwd, encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/** Repository root and the branch tasks fork from. */
export async function inspectRepo(path: string): Promise<{ root: string; baseBranch: string }> {
  if (!existsSync(path)) throw new ChefError(`${path} does not exist.`);
  const root = await git(path, ["rev-parse", "--show-toplevel"]);
  const current = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  if (current) return { root, baseBranch: current };
  const remoteHead = await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).catch(() => "");
  return { root, baseBranch: remoteHead ? remoteHead.replace(/^origin\//, "") : "main" };
}

// An existing path can be a leftover directory or a different checkout. Neither
// is permission to run a cook there (pstack worktree.ts assertWorktree).
async function assertWorktree(repo: string, worktree: string): Promise<void> {
  const invalid = (why: string) => new ChefError(`${worktree} is not the task's worktree of ${repo}: ${why}.`);
  if (!lstatSync(worktree).isDirectory()) throw invalid("not a directory");
  const root = realpathSync(worktree);
  if (root === realpathSync(repo)) throw invalid("it is the repository itself");
  const top = await git(worktree, ["rev-parse", "--show-toplevel"]).catch(() => "");
  if (!top || realpathSync(top) !== root) throw invalid("not a git worktree root");
  const common = (cwd: string) => git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).then(realpathSync);
  if ((await common(worktree)) !== (await common(repo))) throw invalid("it belongs to another repository");
}

/** Creates `worktree` on `branch` from `baseBranch`, re-attaches an existing branch, or accepts the existing worktree. */
export async function ensureWorktree(repo: string, worktree: string, branch: string, baseBranch: string): Promise<void> {
  if (!existsSync(worktree)) {
    await git(repo, ["worktree", "prune"]);
    const exists = (await git(repo, ["branch", "--list", branch])) !== "";
    await git(repo, exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", worktree, "-b", branch, baseBranch]);
  }
  await assertWorktree(repo, worktree);
}

/**
 * dirtyFiles from `status --porcelain` (ignored files do not count), ahead from
 * `rev-list base..branch`, unlanded from `rev-list branch --not base --remotes`,
 * so a commit on a pushed remote branch counts as landed. Missing worktree -> undefined.
 */
export async function gitFacts(repo: string, worktree: string, branch: string, baseBranch: string): Promise<GitFacts | undefined> {
  if (!existsSync(worktree)) return undefined;
  const status = await git(worktree, ["status", "--porcelain"]);
  const dirtyFiles = status ? status.split("\n").length : 0;
  const ahead = Number(await git(repo, ["rev-list", "--count", `${baseBranch}..${branch}`]));
  const unlanded = Number(await git(repo, ["rev-list", "--count", branch, "--not", baseBranch, "--remotes"]));
  return { dirtyFiles, ahead, unlanded };
}

/** `git diff --stat base...branch`, capped. */
export async function diffstat(repo: string, branch: string, baseBranch: string): Promise<string> {
  const text = await git(repo, ["diff", "--stat", `${baseBranch}...${branch}`]).catch(() => "");
  const lines = text.split("\n");
  return lines.length > DIFFSTAT_LINES ? [...lines.slice(0, DIFFSTAT_LINES), `... ${lines.length - DIFFSTAT_LINES} more lines`].join("\n") : text;
}

/**
 * `worktree remove` (forced when discarding) then `branch -d`, or `-D` when
 * discarding. A missing worktree or branch is success. An unmerged branch
 * survives a non-discard close so its commits stay reachable.
 */
export async function removeWorktree(repo: string, worktree: string, branch: string, discard: boolean): Promise<void> {
  if (existsSync(worktree)) await git(repo, ["worktree", "remove", ...(discard ? ["--force"] : []), worktree]);
  await git(repo, ["worktree", "prune"]);
  if ((await git(repo, ["branch", "--list", branch])) !== "") await ok(repo, ["branch", discard ? "-D" : "-d", branch]);
}
