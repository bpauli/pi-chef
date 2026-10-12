import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import { type Config, type Pid, type Profile, type Project, type RunNo, type TaskSpec, isCode } from "./domain.ts";
import type { LiveCooks } from "./derive.ts";
import type { RunFds } from "./store.ts";

const run = promisify(execFile);

export const ROLE_ENV = "CHEF_ROLE";
export const TASK_DIR_ENV = "CHEF_TASK_DIR";
export const SESSION_ENV = "CHEF_SESSION_ID";

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
  chefEntry: string;
  spec: TaskSpec;
  run: RunNo;
  promptFile: string;
  sessionDir: string;
  taskDir: string;
  profile: Profile | undefined;
  config: Config;
  fds: RunFds;
}

export function cookArgv(l: LaunchSpec): string[] {
  const args = [...l.pi.args, "--mode", "json", "-p", "--session-id", l.spec.sessionId, "--session-dir", l.sessionDir, "-e", l.chefEntry];
  if (l.profile) args.push("--model", l.profile.model);
  if (l.profile?.thinking) args.push("--thinking", l.profile.thinking);
  args.push(...l.config.cookArgs, `@${l.promptFile}`);
  return args;
}

export type CookEnd = { kind: "exit"; code: number | null; signal: NodeJS.Signals | null } | { kind: "error"; message: string };

export function launchCook(l: LaunchSpec, onEnd: (end: CookEnd) => void): Pid | undefined {
  const child = spawn(l.pi.command, cookArgv(l), {
    cwd: l.spec.worktree,
    detached: true,
    // An open stdin blocks `-p`.
    stdio: ["ignore", l.fds.stdout, l.fds.stderr],
    env: { ...process.env, [ROLE_ENV]: "cook", [TASK_DIR_ENV]: l.taskDir, [SESSION_ENV]: l.spec.sessionId },
  });
  child.on("error", (e) => onEnd({ kind: "error", message: `spawn of ${basename(l.pi.command)} failed: ${e.message}` }));
  child.on("exit", (code, signal) => onEnd({ kind: "exit", code, signal }));
  child.unref();
  closeSync(l.fds.stdout);
  closeSync(l.fds.stderr);
  return child.pid === undefined ? undefined : (child.pid as Pid);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return isCode(e, "EPERM");
  }
}

// Pi 1.0.3 sets process.title at startup, which overwrites argv, so `--session-id`
// is not readable from ps.
const marker = (sessionId: string) => `${SESSION_ENV}=${sessionId}`;

async function environOf(pid: number): Promise<string[]> {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    } catch {
      return [];
    }
  }
  const { stdout } = await run("ps", ["-E", "-o", "command=", "-p", String(pid)]).catch(() => ({ stdout: "" }));
  return stdout.trim().split(/\s+/);
}

export async function runsSession(pid: number, sessionId: string): Promise<boolean> {
  return alive(pid) && (await environOf(pid)).includes(marker(sessionId));
}

interface Marked {
  pid: Pid;
  ppid: number;
  sessionId: string;
}

// proc(5) numbers the stat fields from 1. These index the fields after "(comm) ", which start at field 3.
const STAT_PPID = 4 - 3;
const STAT_STARTTIME = 22 - 3;

function statFields(pid: number): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

async function scanMarked(): Promise<Marked[]> {
  const found: Marked[] = [];
  const take = (pid: number, ppid: number, env: readonly string[]) => {
    const sessionId = env.find((e) => e.startsWith(`${SESSION_ENV}=`))?.slice(SESSION_ENV.length + 1);
    if (sessionId && pid > 0) found.push({ pid: pid as Pid, ppid, sessionId });
  };
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc")) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        take(pid, Number(statFields(pid)[STAT_PPID]), readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"));
      } catch {}
    }
    return found;
  }
  const { stdout } = await run("ps", ["-E", "-eo", "pid=,ppid=,command="], { maxBuffer: 64 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    take(Number(parts[0]), Number(parts[1]), parts.slice(2));
  }
  return found;
}

export async function scanCooks(): Promise<Map<string, Pid>> {
  const marked = await scanMarked();
  const markedPids = new Set<number>(marked.map((m) => m.pid));
  const parentUnmarked = (m: Marked): boolean => !markedPids.has(m.ppid);
  return new Map(marked.filter(parentUnmarked).map((m) => [m.sessionId, m.pid]));
}

export async function pidStart(pid: number): Promise<string | undefined> {
  if (!alive(pid)) return undefined;
  if (process.platform === "linux") {
    try {
      return statFields(pid)[STAT_STARTTIME];
    } catch {
      return undefined;
    }
  }
  const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)]).catch(() => ({ stdout: "" }));
  return stdout.trim() || undefined;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

// On SIGTERM Pi kills its own bash tree. SIGKILL gives it no chance, so a command
// it was running may outlive it.
export async function signalCook(pid: Pid, sessionId: string, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (!(await runsSession(pid, sessionId))) return;
  signalGroup(pid, signal);
}

export class CookTable {
  private readonly pids = new Map<string, Pid>();

  record(sessionId: string, pid: Pid): void {
    this.pids.set(sessionId, pid);
  }

  async adopt(): Promise<void> {
    for (const [sid, pid] of await scanCooks()) this.pids.set(sid, pid);
  }

  async live(): Promise<LiveCooks> {
    const out = new Map<string, Pid>();
    for (const [sid, pid] of this.pids) {
      if (await runsSession(pid, sid)) out.set(sid, pid);
      else this.pids.delete(sid);
    }
    return out;
  }
}

export function firstPrompt(spec: TaskSpec, project: Project, messages: readonly string[]): string {
  const where = `You work in ${spec.worktree} on branch ${spec.branch}, forked from ${spec.baseBranch}.`;
  const note = project.note ? ` (${project.note})` : "";
  const lines = [`# ${spec.title}`, "", `Task ${spec.id} for project ${project.name}${note}. ${where}`, "", "## Brief", "", spec.brief.trim()];
  if (messages.length) lines.push("", ...messagesSection(messages));
  return `${lines.join("\n")}\n`;
}

export function followUpPrompt(messages: readonly string[]): string {
  return `${messagesSection(messages).join("\n")}\n`;
}

export function messagesSection(messages: readonly string[]): string[] {
  return ["## Messages from the chef", "", ...messages.map((m) => m.trim()).join("\n\n---\n\n").split("\n")];
}
