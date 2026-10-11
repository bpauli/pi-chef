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

export async function inspectRepo(path: string): Promise<{ root: string; baseBranch: string }> {
  if (!existsSync(path)) throw new ChefError(`${path} does not exist.`);
  const root = await git(path, ["rev-parse", "--show-toplevel"]);
  const current = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  if (current) return { root, baseBranch: current };
  const remoteHead = await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).catch(() => "");
  return { root, baseBranch: remoteHead ? remoteHead.replace(/^origin\//, "") : "main" };
}

export async function verifyBaseBranch(repo: string, baseBranch: string): Promise<void> {
  if (!(await ok(repo, ["check-ref-format", "--branch", baseBranch]))) throw new ChefError(`"${baseBranch}" is not a valid branch name.`);
  if (!(await ok(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${baseBranch}`]))) {
    throw new ChefError(`Branch "${baseBranch}" does not exist in ${repo}. Pass a local branch as baseBranch.`);
  }
}

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

export async function ensureWorktree(repo: string, worktree: string, branch: string, baseBranch: string): Promise<void> {
  if (!existsSync(worktree)) {
    await git(repo, ["worktree", "prune"]);
    const exists = (await git(repo, ["branch", "--list", "--end-of-options", branch])) !== "";
    await git(repo, exists ? ["worktree", "add", "--end-of-options", worktree, branch] : ["worktree", "add", "-b", branch, "--end-of-options", worktree, baseBranch]);
  }
  await assertWorktree(repo, worktree);
}

export async function gitFacts(repo: string, worktree: string, branch: string, baseBranch: string): Promise<GitFacts | undefined> {
  if (!existsSync(worktree)) return undefined;
  const status = await git(worktree, ["status", "--porcelain"]);
  const dirtyFiles = status ? status.split("\n").length : 0;
  const ahead = Number(await git(repo, ["rev-list", "--count", "--end-of-options", `${baseBranch}..${branch}`]));
  const unlanded = Number(await git(repo, ["rev-list", "--count", "--not", "--remotes", "--not", "--end-of-options", branch, `^${baseBranch}`]));
  const head = await git(worktree, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "");
  return { dirtyFiles, ahead, unlanded, onBranch: head === branch };
}

export async function diffstat(repo: string, branch: string, baseBranch: string): Promise<string> {
  const text = await git(repo, ["diff", "--stat", "--end-of-options", `${baseBranch}...${branch}`]).catch(() => "");
  const lines = text.split("\n");
  return lines.length > DIFFSTAT_LINES ? [...lines.slice(0, DIFFSTAT_LINES), `... ${lines.length - DIFFSTAT_LINES} more lines`].join("\n") : text;
}

export interface RemoveResult {
  worktree: "removed" | "missing";
  branch: "deleted" | "kept" | "missing";
}

export async function removeWorktree(repo: string, worktree: string, branch: string, baseBranch: string, discard: boolean): Promise<RemoveResult> {
  const hadWorktree = existsSync(worktree);
  if (hadWorktree) await git(repo, ["worktree", "remove", ...(discard ? ["--force"] : []), worktree]);
  await git(repo, ["worktree", "prune"]);
  if ((await git(repo, ["branch", "--list", "--end-of-options", branch])) === "") return { worktree: hadWorktree ? "removed" : "missing", branch: "missing" };
  const landed = discard || (await ok(repo, ["merge-base", "--is-ancestor", "--end-of-options", branch, baseBranch]));
  // `branch -d` is not used: it also deletes a branch whose upstream contains it, and a
  // remote-tracking ref can be stale after the remote branch was deleted.
  const deleted = landed && (await ok(repo, ["branch", "-D", "--end-of-options", branch]));
  return { worktree: hadWorktree ? "removed" : "missing", branch: deleted ? "deleted" : "kept" };
}
