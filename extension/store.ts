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
  type BrokenTask,
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
import { type Claim, EMPTY_RUN, type RunFacts, type RunRecord, type TaskRecord, foldRunLine } from "./derive.ts";

export function kitchenDir(env: NodeJS.ProcessEnv, agentDir: string): string {
  return env.CHEF_HOME || join(agentDir, "chef");
}

export interface Snapshot {
  config: Config;
  projects: Project[];
  records: TaskRecord[];
  broken: BrokenTask[];
  problems: string[];
}

export interface RunFds {
  stdout: number;
  stderr: number;
}

export interface InboxMessage {
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

  loadConfig(): { config: Config; error: string | undefined } {
    const path = join(this.dir, "config.json");
    if (!existsSync(path)) return { config: DEFAULT_CONFIG, error: undefined };
    try {
      const file = parseFile(ConfigSchema, path, readFileSync(path, "utf8"));
      return {
        config: { maxCooks: file.maxCooks ?? DEFAULT_CONFIG.maxCooks, model: file.model, thinking: file.thinking, cookArgs: file.cookArgs ?? [] },
        error: undefined,
      };
    } catch (e) {
      return { config: DEFAULT_CONFIG, error: (e as Error).message };
    }
  }

  readConfig(): Config {
    return this.loadConfig().config;
  }

  readProjects(): Project[] {
    return this.loadProjects().projects;
  }

  private loadProjects(): { projects: Project[]; problems: string[] } {
    const dir = join(this.dir, "projects");
    if (!existsSync(dir)) return { projects: [], problems: [] };
    const projects: Project[] = [];
    const problems: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        projects.push(this.readProjectFile(join(dir, f)));
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    return { projects, problems };
  }

  snapshot(tails: RunTails, skip: ReadonlySet<TaskId>): Snapshot {
    const { config, error } = this.loadConfig();
    const { projects, problems } = this.loadProjects();
    if (error) problems.unshift(error);
    const records: TaskRecord[] = [];
    const broken: BrokenTask[] = [];
    for (const id of this.listTaskIds()) {
      if (skip.has(id)) continue;
      try {
        records.push(this.loadRecord(id, tails));
      } catch (e) {
        broken.push({ id, reason: (e as Error).message });
      }
    }
    return { config, projects, records, broken, problems };
  }

  readProject(name: ProjectName): Project | undefined {
    const path = this.projectFile(name);
    return existsSync(path) ? this.readProjectFile(path) : undefined;
  }

  private readProjectFile(path: string): Project {
    const file = parseFile(ProjectSchema, path, readFileSync(path, "utf8"));
    return { ...file, name: file.name as ProjectName, addedAt: millis(file.addedAt) };
  }

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

  listTaskIds(): TaskId[] {
    const dir = join(this.dir, "tasks");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => existsSync(join(dir, f, "task.json")))
      .sort()
      .map((f) => f as TaskId);
  }

  nextTaskId(project: ProjectName): TaskId {
    const re = new RegExp(`^${project}-(\\d+)$`);
    const dir = join(this.dir, "tasks");
    const seqs = existsSync(dir) ? readdirSync(dir).map((f) => re.exec(f)?.[1]).filter((s): s is string => s !== undefined).map(Number) : [];
    return `${project}-${Math.max(0, ...seqs) + 1}` as TaskId;
  }

  createTask(spec: TaskSpec): { kind: "created" } | { kind: "exists" } {
    this.ensureLayout();
    const dir = this.taskDir(spec.id);
    try {
      mkdirSync(dir);
    } catch (e) {
      if (isCode(e, "EEXIST")) return { kind: "exists" };
      throw e;
    }
    for (const sub of ["runs", join("inbox", "handled"), "session"]) mkdirSync(join(dir, sub), { recursive: true });
    writeAtomic(join(dir, "task.json"), `${JSON.stringify(spec, null, 2)}\n`);
    return { kind: "created" };
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
      } catch {}
    }
    return events;
  }

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
      const st = statSync(path, { throwIfNoEntry: false });
      const at = st && millis(Math.round(st.mtimeMs));
      const claim: Claim = at === undefined ? { kind: "none" } : st?.size ? { kind: "started", at } : { kind: "empty", at };
      const facts = claim.kind === "none" ? EMPTY_RUN : tails.get(path).poll();
      const stderrTail = claim.kind !== "none" && !facts.settled ? this.tail(this.runErr(id, runNo(n))) : "";
      return { n: runNo(n), claim, facts, stderrTail };
    });
    const claimed = new Set(runs.filter((r) => r.claim.kind !== "none").map((r) => r.n));
    return {
      spec,
      // Before `hold` existed, a hold was logged as a `stop` that names a run that was never claimed.
      events: this.readEvents(id).map((e) => (e.type === "stop" && !claimed.has(runNo(e.run)) ? { ...e, type: "hold" } : e)),
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

  writePrompt(id: TaskId, n: RunNo, text: string): void {
    writeAtomic(this.runPrompt(id, n), text);
  }

  readPrompt(id: TaskId, n: RunNo): string | undefined {
    const path = this.runPrompt(id, n);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  claimRun(id: TaskId, n: RunNo): { kind: "claimed"; fds: RunFds } | { kind: "taken" } {
    let stdout: number;
    try {
      stdout = openSync(this.runFile(id, n), "wx");
    } catch (e) {
      if (isCode(e, "EEXIST")) return { kind: "taken" };
      throw e;
    }
    try {
      return { kind: "claimed", fds: { stdout, stderr: openSync(this.runErr(id, n), "a") } };
    } catch (e) {
      closeSync(stdout);
      throw e;
    }
  }

  runBytes(id: TaskId, n: RunNo): number | undefined {
    try {
      return statSync(this.runFile(id, n)).size;
    } catch {
      return undefined;
    }
  }

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
        if (!isCode(e, "ENOENT")) throw e;
      }
    }
    return out;
  }

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
  forget(pathPrefix: string): void {
    for (const path of this.tails.keys()) if (path.startsWith(pathPrefix)) this.tails.delete(path);
  }
}

const CHUNK = 64 * 1024;

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
    // LF only: U+2028 is legal inside a JSON string.
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
