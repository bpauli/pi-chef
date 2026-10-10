// Cook processes: launch argv, detached spawn, the in-memory liveness map, group
// signals, and the prompt text. No pid is stored on disk: a cook's identity is
// the `--session-id <uuid>` pair in its argv.

import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Config, Pid, Project, RunNo, TaskSpec } from "./domain.ts";
import type { LiveCooks } from "./derive.ts";

const run = promisify(execFile);

export const ROLE_ENV = "CHEF_ROLE";
export const TASK_DIR_ENV = "CHEF_TASK_DIR";

/** How to re-run this Pi: the same runtime and script, never a different pi from PATH. */
export interface PiInvocation {
  command: string;
  args: string[];
}

export function piInvocation(): PiInvocation {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return { command: process.execPath, args: [script] };
  return { command: process.execPath, args: [] };
}

export interface LaunchSpec {
  pi: PiInvocation;
  /** Absolute path of extension/index.ts, loaded with -e. Double loading is guarded. */
  chefEntry: string;
  spec: TaskSpec;
  run: RunNo;
  promptFile: string;
  sessionDir: string;
  taskDir: string;
  config: Config;
  fds: { stdout: number; stderr: number };
}

export function cookArgv(l: LaunchSpec): string[] {
  const args = [...l.pi.args, "--mode", "json", "-p", "--session-id", l.spec.sessionId, "--session-dir", l.sessionDir, "-e", l.chefEntry];
  const model = l.spec.model ?? l.config.model;
  if (model) args.push("--model", model);
  if (l.config.thinking) args.push("--thinking", l.config.thinking);
  args.push(...l.config.cookArgs, `@${l.promptFile}`);
  return args;
}

/**
 * Starts one cook run and forgets it: detached in its own process group, stdin
 * ignored (an open stdin blocks `-p`), stdout to the claimed run file, stderr
 * to the err file. Returns the pid for the liveness map.
 */
export function launchCook(l: LaunchSpec): Pid {
  const child = spawn(l.pi.command, cookArgv(l), {
    cwd: l.spec.worktree,
    detached: true,
    stdio: ["ignore", l.fds.stdout, l.fds.stderr],
    env: { ...process.env, [ROLE_ENV]: "cook", [TASK_DIR_ENV]: l.taskDir },
  });
  child.unref();
  closeSync(l.fds.stdout);
  closeSync(l.fds.stderr);
  if (child.pid === undefined) throw new Error(`spawn of ${basename(l.pi.command)} returned no pid`);
  return child.pid as Pid;
}

// ---------- Process facts ----------

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function hasSessionPair(args: readonly string[], sessionId: string): boolean {
  return args.some((arg, i) => arg === "--session-id" && args[i + 1] === sessionId);
}

/** True while the process still runs this session. Guards against pid reuse. */
export async function runsSession(pid: number, sessionId: string): Promise<boolean> {
  if (!alive(pid)) return false;
  if (process.platform === "linux") {
    try {
      return hasSessionPair(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"), sessionId);
    } catch {
      return false;
    }
  }
  const { stdout } = await run("ps", ["-o", "args=", "-p", String(pid)]).catch(() => ({ stdout: "" }));
  return hasSessionPair(stdout.trim().split(/\s+/), sessionId);
}

/** One `ps -eo pid=,args=` scan: session id -> pid for every process whose argv carries the pair. */
export async function scanCooks(): Promise<Map<string, Pid>> {
  const found = new Map<string, Pid>();
  const { stdout } = await run("ps", ["-eo", "pid=,args="], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    const at = parts.indexOf("--session-id");
    const sid = parts[at + 1];
    if (at > 0 && pid > 0 && sid && parts.includes("--mode") && parts.includes("json")) found.set(sid, pid as Pid);
  }
  return found;
}

/** Process start time as a string, to tell a reused pid from the lease holder. */
export async function pidStart(pid: number): Promise<string | undefined> {
  if (!alive(pid)) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19];
    } catch {
      return undefined;
    }
  }
  const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)]).catch(() => ({ stdout: "" }));
  return stdout.trim() || undefined;
}

/** Signals the process group, only while the pid still runs this session. */
export async function signalCook(pid: Pid, sessionId: string, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (!(await runsSession(pid, sessionId))) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Exited between the check and the signal.
    }
  }
}

/**
 * The owner's map from session id to pid. Filled by `spawn` at launch and by one
 * `ps` scan at activation (adoption). Each query re-checks the pid's identity.
 */
export class CookTable {
  private readonly pids = new Map<string, Pid>();

  record(sessionId: string, pid: Pid): void {
    this.pids.set(sessionId, pid);
  }

  async adopt(): Promise<void> {
    for (const [sid, pid] of await scanCooks()) this.pids.set(sid, pid);
  }

  /** The cooks still alive, by session id. Dead or reused pids drop out of the map. */
  async live(): Promise<LiveCooks> {
    const out = new Map<string, Pid>();
    for (const [sid, pid] of this.pids) {
      if (await runsSession(pid, sid)) out.set(sid, pid);
      else this.pids.delete(sid);
    }
    return out;
  }
}

// ---------- Prompt text ----------

/** runs/1.prompt.md: the brief inside a fixed frame, plus any messages already waiting. */
export function firstPrompt(spec: TaskSpec, project: Project, messages: readonly string[]): string {
  const where = `You work in ${spec.worktree} on branch ${spec.branch}, forked from ${spec.baseBranch}.`;
  const note = project.note ? ` (${project.note})` : "";
  const lines = [`# ${spec.title}`, "", `Task ${spec.id} for project ${project.name}${note}. ${where}`, "", "## Brief", "", spec.brief.trim()];
  if (messages.length) lines.push("", ...messagesSection(messages));
  return `${lines.join("\n")}\n`;
}

/** runs/<n>.prompt.md for n > 1: only the chef's messages, the session holds the rest. */
export function followUpPrompt(messages: readonly string[]): string {
  return `${messagesSection(messages).join("\n")}\n`;
}

export function messagesSection(messages: readonly string[]): string[] {
  return ["## Messages from the chef", "", ...messages.map((m) => m.trim()).join("\n\n---\n\n").split("\n")];
}
