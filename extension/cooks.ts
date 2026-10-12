import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import { type Config, type Pid, type Profile, type Project, type RunNo, type TaskId, type TaskSpec, type Tried, isCode } from "./domain.ts";
import type { LiveCooks } from "./derive.ts";
import { type RunFds, taskOfRunFile } from "./store.ts";

const run = promisify(execFile);

export const ROLE_ENV = "CHEF_ROLE";
export const TASK_DIR_ENV = "CHEF_TASK_DIR";

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
    // An open stdin blocks `-p`. The claimed run file on fd 1 is the cook's identity.
    stdio: ["ignore", l.fds.stdout, l.fds.stderr],
    env: { ...process.env, [ROLE_ENV]: "cook", [TASK_DIR_ENV]: l.taskDir },
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

/** One process and where its stdout points: the boundary type of the fd-1 primitive, parsed from /proc or lsof. */
export interface Stdout {
  pid: Pid;
  ppid: number;
  /** Resolved path. Linux readlink gives it resolved, lsof prints it resolved. */
  path: string;
}

// proc(5) numbers the stat fields from 1. These index the fields after "(comm) ", which start at field 3.
const STAT_PPID = 4 - 3;
const STAT_STARTTIME = 22 - 3;

function statFields(pid: number): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

/** Pure. Parses `lsof -F pRn` output: `p<pid>`, `R<ppid>`, an optional `f1`, and `n<path>` per record. */
export function parseLsof(text: string): Stdout[] {
  const out: Stdout[] = [];
  let pid: Pid | undefined;
  let ppid = 0;
  for (const line of text.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) {
      pid = Number(value) as Pid;
      ppid = 0;
    } else if (line.startsWith("R")) {
      ppid = Number(value);
    } else if (line.startsWith("n") && pid !== undefined) {
      out.push({ pid, ppid, path: value });
    }
  }
  return out;
}

const stdoutOf = (e: unknown): string => (typeof e === "object" && e !== null && "stdout" in e && typeof e.stdout === "string" ? e.stdout : "");

/** The one platform split. `pids` undefined means every process. A process the probe cannot read is absent. */
async function stdouts(pids?: readonly number[]): Promise<Stdout[]> {
  if (process.platform === "linux") {
    const out: Stdout[] = [];
    for (const pid of pids ?? readdirSync("/proc").map(Number).filter((n) => Number.isInteger(n) && n > 0)) {
      try {
        const path = readlinkSync(`/proc/${pid}/fd/1`);
        out.push({ pid: pid as Pid, ppid: Number(statFields(pid)[STAT_PPID]), path });
      } catch {}
    }
    return out;
  }
  if (pids?.length === 0) return [];
  const args = ["-w", "-d", "1", "-F", "pRn", ...(pids ? ["-a", "-p", pids.join(",")] : [])];
  // lsof exits 1 when a listed pid is gone or has no fd 1, with the other records intact.
  const { stdout } = await run("lsof", args, { maxBuffer: 64 * 1024 * 1024 }).catch((e: unknown) => ({ stdout: stdoutOf(e) }));
  return parseLsof(stdout);
}

// Resolved on every call: the kitchen layout may not exist yet when the table is made, and
// macOS reports a kitchen under /var as /private/var.
function rootOf(tasksDir: string): string | undefined {
  try {
    return realpathSync(tasksDir);
  } catch {
    return undefined;
  }
}

/**
 * Every live cook under `tasksDir`: the process whose fd 1 is `<tasksDir>/<id>/runs/<n>.jsonl` and whose
 * parent does not write a run file. A missing tasks dir gives an empty map.
 */
export async function scanCooks(tasksDir: string): Promise<LiveCooks> {
  const root = rootOf(tasksDir);
  if (root === undefined) return new Map();
  const cooks = (await stdouts()).flatMap((s) => {
    const task = taskOfRunFile(root, s.path);
    return task === undefined ? [] : [{ ...s, task }];
  });
  const writers = new Set<number>(cooks.map((c) => c.pid));
  return new Map(cooks.filter((c) => !writers.has(c.ppid)).map((c) => [c.task, c.pid]));
}

/** The task each of `pids` cooks now, by its fd 1. A dead, reused, or foreign pid is absent. One probe for all. */
async function tasksOf(tasksDir: string, pids: readonly Pid[]): Promise<Map<Pid, TaskId>> {
  const root = rootOf(tasksDir);
  const living = pids.filter(alive);
  const out = new Map<Pid, TaskId>();
  if (root === undefined || living.length === 0) return out;
  for (const s of await stdouts(living)) {
    const task = taskOfRunFile(root, s.path);
    if (task !== undefined) out.set(s.pid, task);
  }
  return out;
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

export class CookTable {
  private readonly pids = new Map<TaskId, Pid>();
  private readonly tasksDir: string;

  constructor(tasksDir: string) {
    this.tasksDir = tasksDir;
  }

  record(task: TaskId, pid: Pid): void {
    this.pids.set(task, pid);
  }

  async adopt(): Promise<void> {
    for (const [task, pid] of await scanCooks(this.tasksDir)) this.pids.set(task, pid);
  }

  /** The known cooks whose fd 1 still is a run file of their task (pid reuse guard). The others leave the table. */
  async live(): Promise<LiveCooks> {
    const found = await tasksOf(this.tasksDir, [...this.pids.values()]);
    for (const [task, pid] of this.pids) if (found.get(pid) !== task) this.pids.delete(task);
    return new Map(this.pids);
  }

  // On SIGTERM Pi kills its own bash tree. SIGKILL gives it no chance, so a command
  // it was running may outlive it.
  async signal(task: TaskId, pid: Pid, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    if ((await tasksOf(this.tasksDir, [pid])).get(pid) !== task) return;
    signalGroup(pid, signal);
  }
}

export function firstPrompt(spec: TaskSpec, project: Project, messages: readonly string[]): string {
  const where = `You work in ${spec.worktree} on branch ${spec.branch}, forked from ${spec.baseBranch}.`;
  const note = project.note ? ` (${project.note})` : "";
  const lines = [`# ${spec.title}`, "", `Task ${spec.id} for project ${project.name}${note}. ${where}`, "", "## Brief", "", spec.brief.trim()];
  if (messages.length) lines.push("", ...messagesSection(messages));
  return `${lines.join("\n")}\n`;
}

export function fallbackPrompt(from: Tried, to: Profile | undefined, messages: readonly string[]): string {
  const lines = [
    "## Model change",
    "",
    `Your last run on ${from.model} stopped with a provider error: ${from.error.trim()}`,
    "",
    `The chef moved this task to ${to?.model ?? "Pi's default model"}. Continue the task from where the last run stopped.`,
  ];
  if (messages.length) lines.push("", ...messagesSection(messages));
  return `${lines.join("\n")}\n`;
}

export function followUpPrompt(messages: readonly string[]): string {
  return `${messagesSection(messages).join("\n")}\n`;
}

export function messagesSection(messages: readonly string[]): string[] {
  return ["## Messages from the chef", "", ...messages.map((m) => m.trim()).join("\n\n---\n\n").split("\n")];
}
