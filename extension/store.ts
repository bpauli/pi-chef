// The kitchen on disk. This module is the only one that knows the layout. One
// writer per file; see docs/design.md "Files and writers".

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  ChefError,
  type Config,
  ConfigSchema,
  DEFAULT_CONFIG,
  type Lease,
  LeaseSchema,
  type Millis,
  type Project,
  type ProjectName,
  ProjectSchema,
  type RunNo,
  type TaskEvent,
  TaskEventSchema,
  type TaskId,
  type TaskSpec,
  TaskSpecSchema,
  millis,
  runNo,
} from "./domain.ts";
import { EMPTY_RUN, type RunFacts, type RunRecord, type TaskRecord, foldRunLine } from "./derive.ts";

export function kitchenDir(env: NodeJS.ProcessEnv, agentDir: string): string {
  return env.CHEF_HOME || join(agentDir, "chef");
}

export interface InboxMessage {
  /** Basename, sortable: `<epoch ms, 13 digits>-<4 hex>.msg`. */
  file: string;
  at: Millis;
  text: string;
}

const MSG = /^(\d{13})-[0-9a-f]{4}\.msg$/;
const PROMPT = /^(\d+)\.prompt\.md$/;
const ERR_TAIL_BYTES = 2048;

function isCode(e: unknown, code: string): boolean {
  return (e as NodeJS.ErrnoException).code === code;
}

/** Parses one external JSON document against its schema. The error names the file and the field. */
export function parseFile<T extends TSchema>(schema: T, path: string, raw: string): Static<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ChefError(`${path} is not valid JSON.`);
  }
  if (!Value.Check(schema, json)) {
    const first = Value.Errors(schema, json)[0];
    throw new ChefError(`${path} is invalid${first ? ` at ${first.instancePath || "/"}: ${first.message}` : ""}.`);
  }
  return json;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export class Store {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  taskDir(id: TaskId): string {
    return join(this.dir, "tasks", id);
  }
  runPrompt(id: TaskId, n: RunNo): string {
    return join(this.taskDir(id), "runs", `${n}.prompt.md`);
  }
  runFile(id: TaskId, n: RunNo): string {
    return join(this.taskDir(id), "runs", `${n}.jsonl`);
  }
  runErr(id: TaskId, n: RunNo): string {
    return join(this.taskDir(id), "runs", `${n}.err`);
  }
  inboxDir(id: TaskId): string {
    return join(this.taskDir(id), "inbox");
  }
  sessionDir(id: TaskId): string {
    return join(this.taskDir(id), "session");
  }
  worktreeDir(id: TaskId): string {
    return join(this.dir, "worktrees", id);
  }
  lockFile(): string {
    return join(this.dir, "pass.lock");
  }
  private projectFile(name: string): string {
    return join(this.dir, "projects", `${name}.json`);
  }

  ensureLayout(): void {
    for (const sub of ["projects", "tasks", "worktrees"]) mkdirSync(join(this.dir, sub), { recursive: true });
  }

  // ----- config and projects -----

  readConfig(): Config {
    const path = join(this.dir, "config.json");
    if (!existsSync(path)) return DEFAULT_CONFIG;
    const file = parseFile(ConfigSchema, path, readFileSync(path, "utf8"));
    return {
      maxCooks: file.maxCooks ?? DEFAULT_CONFIG.maxCooks,
      model: file.model,
      thinking: file.thinking,
      cookArgs: file.cookArgs ?? [],
    };
  }

  readProjects(): Project[] {
    const dir = join(this.dir, "projects");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => this.readProjectFile(join(dir, f)));
  }

  readProject(name: ProjectName): Project | undefined {
    const path = this.projectFile(name);
    return existsSync(path) ? this.readProjectFile(path) : undefined;
  }

  private readProjectFile(path: string): Project {
    const file = parseFile(ProjectSchema, path, readFileSync(path, "utf8"));
    return { ...file, name: file.name as ProjectName, addedAt: millis(file.addedAt) };
  }

  /** O_EXCL. The same name with the same path is returned as is; another path is an error. */
  addProject(p: Project): Project {
    this.ensureLayout();
    try {
      writeFileSync(this.projectFile(p.name), `${JSON.stringify(p, null, 2)}\n`, { flag: "wx" });
      return p;
    } catch (e) {
      if (!isCode(e, "EEXIST")) throw e;
      const existing = this.readProjectFile(this.projectFile(p.name));
      if (existing.path === p.path) return existing;
      throw new ChefError(`Project "${p.name}" is already registered for ${existing.path}. Pass another name for ${p.path}.`);
    }
  }

  // ----- tasks -----

  listTaskIds(): TaskId[] {
    const dir = join(this.dir, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => existsSync(join(dir, f, "task.json")))
      .sort()
      .map((f) => f as TaskId);
  }

  /** `<project>-<max existing seq + 1>`, from the task directory names. */
  nextTaskId(project: ProjectName): TaskId {
    const re = new RegExp(`^${project}-(\\d+)$`);
    const dir = join(this.dir, "tasks");
    const seqs = existsSync(dir) ? readdirSync(dir).map((f) => re.exec(f)?.[1]).filter((s): s is string => s !== undefined).map(Number) : [];
    return `${project}-${Math.max(0, ...seqs) + 1}` as TaskId;
  }

  /** Returns false when the id is taken (a racing dispatch): retry with the next id. */
  createTask(spec: TaskSpec): boolean {
    this.ensureLayout();
    const dir = this.taskDir(spec.id);
    try {
      mkdirSync(dir);
    } catch (e) {
      if (isCode(e, "EEXIST")) return false;
      throw e;
    }
    for (const sub of ["runs", join("inbox", "handled"), "session"]) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, "task.json"), `${JSON.stringify(spec, null, 2)}\n`, { flag: "wx" });
    return true;
  }

  readSpec(id: TaskId): TaskSpec {
    const path = join(this.taskDir(id), "task.json");
    if (!existsSync(path)) throw new ChefError(`Unknown task "${id}".`);
    const file = parseFile(TaskSpecSchema, path, readFileSync(path, "utf8"));
    return { ...file, id: file.id as TaskId, project: file.project as ProjectName, sessionId: file.sessionId as TaskSpec["sessionId"], createdAt: millis(file.createdAt) };
  }

  appendEvent(id: TaskId, event: TaskEvent): void {
    appendFileSync(join(this.taskDir(id), "log.jsonl"), `${JSON.stringify(event)}\n`);
  }

  readEvents(id: TaskId): TaskEvent[] {
    const path = join(this.taskDir(id), "log.jsonl");
    if (!existsSync(path)) return [];
    const events: TaskEvent[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const json: unknown = JSON.parse(line);
        if (Value.Check(TaskEventSchema, json)) events.push(json);
      } catch {
        // A torn last line from a crash mid-append is skipped, never fatal.
      }
    }
    return events;
  }

  /** Reads one task into the record derive.ts consumes. `tails` carries incremental readers across ticks. */
  loadRecord(id: TaskId, tails: RunTails): TaskRecord {
    const spec = this.readSpec(id);
    const runsDir = join(this.taskDir(id), "runs");
    const ns = (existsSync(runsDir) ? readdirSync(runsDir) : [])
      .map((f) => PROMPT.exec(f)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    const runs = ns.map((n): RunRecord => {
      const path = this.runFile(id, runNo(n));
      let bytes = -1;
      try {
        bytes = statSync(path).size;
      } catch (e) {
        if (!isCode(e, "ENOENT")) throw e;
      }
      const claimed = bytes >= 0;
      const facts = claimed ? tails.get(path).poll() : EMPTY_RUN;
      const stderrTail = claimed && bytes > 0 && !facts.settled ? this.tail(this.runErr(id, runNo(n))) : "";
      return { n: runNo(n), claimed, bytes: Math.max(0, bytes), facts, stderrTail };
    });
    return {
      spec,
      events: this.readEvents(id),
      runs,
      pendingAt: this.pendingMessages(id).map((m) => m.at),
      worktreeExists: existsSync(spec.worktree),
    };
  }

  private tail(path: string): string {
    try {
      const size = statSync(path).size;
      const fd = openSync(path, "r");
      try {
        const start = Math.max(0, size - ERR_TAIL_BYTES);
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        return buf.toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  // ----- launch files -----

  writePrompt(id: TaskId, n: RunNo, text: string): void {
    writeAtomic(this.runPrompt(id, n), text);
  }

  readPrompt(id: TaskId, n: RunNo): string | undefined {
    const path = this.runPrompt(id, n);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  /** Claims run n by creating runs/<n>.jsonl with O_EXCL. EEXIST means another launch won. */
  claimRun(id: TaskId, n: RunNo): { stdout: number; stderr: number } | undefined {
    let stdout: number;
    try {
      stdout = openSync(this.runFile(id, n), "wx");
    } catch (e) {
      if (isCode(e, "EEXIST")) return undefined;
      throw e;
    }
    return { stdout, stderr: openSync(this.runErr(id, n), "w") };
  }

  /** Removes an empty claim left by an interrupted launch. A claim with content stays. */
  releaseEmptyClaim(id: TaskId, n: RunNo): boolean {
    const path = this.runFile(id, n);
    try {
      if (statSync(path).size !== 0) return false;
      unlinkSync(path);
      return true;
    } catch (e) {
      if (isCode(e, "ENOENT")) return true;
      throw e;
    }
  }

  // ----- inbox -----

  /** tmp plus rename, so the cook's `*.msg` glob never sees a partial file. */
  postMessage(id: TaskId, text: string, at: Millis): InboxMessage {
    const dir = this.inboxDir(id);
    mkdirSync(join(dir, "handled"), { recursive: true });
    const file = `${String(at).padStart(13, "0")}-${randomBytes(2).toString("hex")}.msg`;
    const tmp = join(dir, `.tmp-${randomBytes(4).toString("hex")}`);
    writeFileSync(tmp, text);
    renameSync(tmp, join(dir, file));
    return { file, at, text };
  }

  pendingMessages(id: TaskId): InboxMessage[] {
    const dir = this.inboxDir(id);
    if (!existsSync(dir)) return [];
    const out: InboxMessage[] = [];
    for (const file of readdirSync(dir).sort()) {
      const m = MSG.exec(file);
      if (!m) continue;
      try {
        out.push({ file, at: millis(Number(m[1])), text: readFileSync(join(dir, file), "utf8") });
      } catch (e) {
        // The cook moved it between readdir and read.
        if (!isCode(e, "ENOENT")) throw e;
      }
    }
    return out;
  }

  /** Moves messages into handled/. ENOENT is fine: the cook moved it first. */
  moveToHandled(id: TaskId, files: readonly string[]): void {
    const dir = this.inboxDir(id);
    for (const file of files) {
      try {
        renameSync(join(dir, file), join(dir, "handled", file));
      } catch (e) {
        if (!isCode(e, "ENOENT")) throw e;
      }
    }
  }

  // ----- lease -----

  readLease(): Lease | undefined {
    const path = this.lockFile();
    if (!existsSync(path)) return undefined;
    try {
      return parseFile(LeaseSchema, path, readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  writeLease(lease: Lease): void {
    this.ensureLayout();
    writeAtomic(this.lockFile(), `${JSON.stringify(lease)}\n`);
  }

  removeLease(): void {
    rmSync(this.lockFile(), { force: true });
  }
}

/** Incremental readers keyed by run file path. Owned by one Kitchen, reused across ticks. */
export class RunTails {
  private readonly tails = new Map<string, RunTail>();
  get(path: string): RunTail {
    let tail = this.tails.get(path);
    if (!tail) {
      tail = new RunTail(path);
      this.tails.set(path, tail);
    }
    return tail;
  }
  /** Closed tasks drop their tails to keep memory flat. */
  forget(pathPrefix: string): void {
    for (const path of this.tails.keys()) if (path.startsWith(pathPrefix)) this.tails.delete(path);
  }
}

const CHUNK = 64 * 1024;

/**
 * Reads only the bytes appended since the last poll, splits on LF only (U+2028 is
 * legal inside a JSON string), keeps a partial last line and a split multi-byte
 * character for the next poll, and folds each complete line.
 */
export class RunTail {
  private offset = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");
  private facts: RunFacts = EMPTY_RUN;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  poll(): RunFacts {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return this.facts;
    }
    if (size < this.offset) this.reset();
    if (size === this.offset) return this.facts;
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.alloc(CHUNK);
      while (this.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        this.feed(this.decoder.write(buf.subarray(0, n)));
      }
    } finally {
      closeSync(fd);
    }
    return this.facts;
  }

  private feed(text: string): void {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) if (line) this.facts = foldRunLine(this.facts, line);
  }

  private reset(): void {
    this.offset = 0;
    this.partial = "";
    this.decoder = new StringDecoder("utf8");
    this.facts = EMPTY_RUN;
  }
}
