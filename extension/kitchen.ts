// The Kitchen is chef's one deep module. Tools and /chef call it; it knows
// nothing about Pi. Every mutating operation ends with a tick, so "launch now or
// queue" has one code path and restart reconciliation is the first tick.

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Board,
  ChefError,
  type Holder,
  type Millis,
  type Notice,
  type NoticeRef,
  type Pid,
  type Project,
  type RunNo,
  type SessionId,
  type TaskId,
  type TaskSpec,
  type TaskView,
  millis,
  parseProjectName,
} from "./domain.ts";
import { type Action, type GitFacts, type LiveCooks, type TaskRecord, closeVerdict, deriveTask, nextRunOf, plan } from "./derive.ts";
import { type CookEnd, CookTable, type PiInvocation, firstPrompt, followUpPrompt, launchCook, messagesSection, pidStart, signalCook } from "./cooks.ts";
import { type RemoveResult, diffstat, ensureWorktree, gitFacts, inspectRepo, removeWorktree } from "./git.ts";
import { RunTails, type Snapshot, type Store } from "./store.ts";

export interface KitchenDeps {
  store: Store;
  pi: PiInvocation;
  chefEntry: string;
  /** The Pi session that asks to own the kitchen. */
  self: { pid: Pid; sessionId: string };
  now?: () => Millis;
  killGraceMs?: number;
  /** How long `send` waits for a reported cook to exit before it answers `exiting`. Default 5000. */
  exitWaitMs?: number;
}

const EXIT_POLL_MS = 100;

export interface DispatchInput {
  project: string;
  title: string;
  brief: string;
  model?: string;
}

export type Delivery =
  | { kind: "steer" }
  | { kind: "relaunched"; run: RunNo }
  | { kind: "queued"; position: number }
  /** The last cook reported and has not exited within `exitWaitMs`. The tick relaunches when it does. */
  | { kind: "exiting" }
  | { kind: "held" };

export interface TaskResult {
  view: TaskView;
  project: Project | undefined;
  /** Undefined when the worktree is gone. */
  git: GitFacts | undefined;
  diffstat: string;
  finalText: string | undefined;
  transcript: string | undefined;
}

export type TickReport = { kind: "ok"; board: Board; notices: Notice[]; errors: string[] } | { kind: "lost"; holder: Holder | undefined };

export type Opened = { kind: "owner"; kitchen: Kitchen } | { kind: "read-only"; reader: KitchenReader; holder: Holder };

/** What a session without the lease can do: look. */
export class KitchenReader {
  protected readonly deps: KitchenDeps;
  protected readonly store: Store;
  protected readonly tails = new RunTails();
  protected readonly cooks = new CookTable();
  protected readonly now: () => Millis;
  // Runs whose liveness was checked once with a full ps scan, so a dead run never triggers another.
  private readonly scanned = new Set<string>();
  // Closed tasks whose worktree is gone never change again.
  private readonly finished = new Set<TaskId>();

  constructor(deps: KitchenDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.now = deps.now ?? (() => millis(Date.now()));
  }

  static async open(deps: KitchenDeps, options: { takeover?: boolean } = {}): Promise<Opened> {
    deps.store.ensureLayout();
    const holder = await acquireLease(deps.store, deps.self, options.takeover === true);
    if (holder) {
      const reader = new KitchenReader(deps);
      await reader.cooks.adopt();
      return { kind: "read-only", reader, holder };
    }
    const kitchen = new Kitchen(deps);
    await kitchen.cooks.adopt();
    return { kind: "owner", kitchen };
  }

  taskIds(): TaskId[] {
    return this.store.listTaskIds();
  }

  /** The session that holds the lease now, from pass.lock. */
  holder(): Holder | undefined {
    return holderOf(this.store.readLease());
  }

  async board(): Promise<Board> {
    const snap = this.snapshot();
    const live = await this.liveCooks(snap.records);
    const { views } = plan({ records: snap.records, live, now: this.now(), cap: snap.config.maxCooks, killGraceMs: 0 });
    return this.boardOf(views, snap, "read-only", holderOf(this.store.readLease()));
  }

  async result(task: TaskId): Promise<TaskResult> {
    const rec = this.store.loadRecord(task, this.tails);
    const live = await this.liveCooks([rec]);
    const view = deriveTask(rec, live, this.now());
    const project = this.store.readProject(rec.spec.project);
    const git = project ? await gitFacts(project.path, rec.spec.worktree, rec.spec.branch, rec.spec.baseBranch) : undefined;
    const stat = project && git ? await diffstat(project.path, rec.spec.branch, rec.spec.baseBranch) : "";
    const last = rec.runs.filter((r) => r.claimed).at(-1);
    return {
      view,
      project,
      git,
      diffstat: stat,
      finalText: last?.facts.finalText,
      transcript: last ? this.store.runFile(task, last.n) : undefined,
    };
  }

  protected snapshot(): Snapshot {
    return this.store.snapshot(this.tails, this.finished);
  }

  /**
   * Cheap per tick: kill(0) plus an argv check per known pid. A claimed, unsettled
   * run with no known pid gets one full ps scan, which adopts a cook another
   * session launched. After that scan a missing process is dead.
   */
  protected async liveCooks(records: readonly TaskRecord[]): Promise<LiveCooks> {
    let live = await this.cooks.live();
    const unknown = records.filter((rec) => {
      const last = rec.runs.at(-1);
      if (!last?.claimed || last.facts.settled || live.has(rec.spec.sessionId)) return false;
      const key = `${rec.spec.id}#${last.n}`;
      if (this.scanned.has(key)) return false;
      this.scanned.add(key);
      return true;
    });
    if (unknown.length) {
      await this.cooks.adopt();
      live = await this.cooks.live();
    }
    return live;
  }

  protected boardOf(views: TaskView[], snap: Snapshot, role: Board["role"], holder: Holder | undefined): Board {
    const open = views.filter((v) => v.state.kind !== "closed").sort((a, b) => b.spec.createdAt - a.spec.createdAt);
    for (const v of views) {
      if (v.state.kind === "closed" && !this.store.loadRecord(v.spec.id, this.tails).worktreeExists) {
        this.finished.add(v.spec.id);
        this.tails.forget(this.store.taskDir(v.spec.id));
      }
    }
    const closedCount = this.finished.size + views.filter((v) => v.state.kind === "closed" && !this.finished.has(v.spec.id)).length;
    return {
      role,
      holder,
      projects: snap.projects,
      open,
      broken: snap.broken,
      closedCount,
      cooks: { busy: views.filter((v) => v.state.kind === "cooking").length, cap: snap.config.maxCooks },
    };
  }
}

export class Kitchen extends KitchenReader {
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Every write runs here, one at a time with the tick, in the order lease check,
   * read, decide, write, tick. A lost lease is found before the first write, and
   * no interval tick can change a task between the decision and the write.
   */
  private mutate<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => {
      if (!leaseIsMine(this.store, this.deps.self)) throw lostError(holderOf(this.store.readLease()));
      return op();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Verify lease, load records, liveness, plan, execute. Serialized: a tick never overlaps a mutation. */
  tick(): Promise<TickReport> {
    const next = this.chain.then(() => this.runTick());
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ---------- operations ----------

  addProject(input: { path: string; name?: string; note?: string; baseBranch?: string }): Promise<Project> {
    return this.mutate(async () => {
      const { root, baseBranch } = await inspectRepo(input.path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
      const name = parseProjectName(input.name ?? basename(root));
      return this.store.addProject({ name, path: root, baseBranch: input.baseBranch ?? baseBranch, note: input.note, addedAt: this.now() });
    });
  }

  /** Writes task.json, then the tick launches it or leaves it queued. */
  dispatch(input: DispatchInput): Promise<TaskView> {
    return this.mutate(async () => {
      const project = this.requireProject(input.project);
      let id: TaskId | undefined;
      for (let attempt = 0; attempt < 5 && !id; attempt++) {
        const candidate = this.store.nextTaskId(project.name);
        const created = this.store.createTask({
          id: candidate,
          project: project.name,
          title: input.title,
          brief: input.brief,
          branch: `chef/${candidate}`,
          worktree: this.store.worktreeDir(candidate),
          baseBranch: project.baseBranch,
          sessionId: randomUUID() as SessionId,
          model: input.model,
          createdAt: this.now(),
        });
        if (created) id = candidate;
      }
      if (!id) throw new ChefError(`Could not allocate a task id for ${project.name}.`);
      return this.viewAfterTick(id);
    });
  }

  /**
   * One way to talk to a task: steer if cooking, relaunch with the message if idle.
   * A cook that reported and is still exiting blocks the relaunch (plan waits for
   * the exit), so send ticks until the exit or `exitWaitMs`, and never reads that
   * wait as the cap holding the task.
   */
  send(task: TaskId, text: string): Promise<Delivery> {
    return this.mutate(async () => {
      const rec = this.store.loadRecord(task, this.tails);
      if (rec.events.some((e) => e.type === "closed")) throw new ChefError(`${task} is closed. Dispatch a new task.`);
      const before = deriveTask(rec, await this.liveCooks([rec]), this.now()).state;
      this.store.postMessage(task, text, this.now());
      const deadline = this.now() + (this.deps.exitWaitMs ?? 5000);
      for (;;) {
        const report = await this.runTick();
        if (report.kind === "lost") throw lostError(report.holder);
        const state = report.board.open.find((v) => v.spec.id === task)?.state;
        if (state?.kind === "cooking") {
          return before.kind === "cooking" && before.run === state.run ? { kind: "steer" } : { kind: "relaunched", run: state.run };
        }
        if (state?.kind !== "queued") return { kind: "held" };
        if (!(await this.cooks.live()).has(rec.spec.sessionId)) {
          const queue = report.board.open.filter((v) => v.state.kind === "queued").sort((a, b) => a.spec.createdAt - b.spec.createdAt);
          return { kind: "queued", position: queue.findIndex((v) => v.spec.id === task) + 1 };
        }
        if (this.now() >= deadline) return { kind: "exiting" };
        await sleep(EXIT_POLL_MS);
      }
    });
  }

  /** Stops the live run, or holds a queued task. The tick escalates to SIGKILL. */
  stop(task: TaskId): Promise<TaskView> {
    return this.mutate(async () => {
      const rec = this.store.loadRecord(task, this.tails);
      await this.stopNow(rec, await this.liveCooks([rec]));
      return this.viewAfterTick(task);
    });
  }

  private async stopNow(rec: TaskRecord, live: LiveCooks): Promise<void> {
    const task = rec.spec.id;
    const { state } = deriveTask(rec, live, this.now());
    const run = state.kind === "cooking" ? state.run : state.kind === "queued" ? nextRunOf(rec) : undefined;
    if (run !== undefined) this.store.appendEvent(task, { type: "stop", at: this.now(), run });
    const pid = live.get(rec.spec.sessionId);
    if (state.kind === "cooking" && pid !== undefined) await signalCook(pid, rec.spec.sessionId, "SIGTERM");
  }

  /**
   * Refuses unless closeVerdict says ok. Order makes it crash-safe: stop a live
   * cook when discarding, append `closed`, then remove the worktree and report
   * what git did. A removal that fails here is retried by every tick.
   */
  close(task: TaskId, discard: boolean): Promise<{ view: TaskView; removal: RemoveResult | { error: string } }> {
    return this.mutate(async () => {
      const rec = this.store.loadRecord(task, this.tails);
      const live = await this.liveCooks([rec]);
      const before = deriveTask(rec, live, this.now());
      const project = this.store.readProject(rec.spec.project);
      const git = project ? await gitFacts(project.path, rec.spec.worktree, rec.spec.branch, rec.spec.baseBranch) : undefined;
      const verdict = closeVerdict(task, before.state, git, discard);
      if (!verdict.ok) throw new ChefError(verdict.reason);
      const discarded = before.state.kind === "closed" ? before.state.discarded : discard;
      if (before.state.kind !== "closed") {
        if (before.state.kind === "cooking") await this.stopNow(rec, live);
        this.store.appendEvent(task, { type: "closed", at: this.now(), discarded: discard });
      }
      let removal: RemoveResult | { error: string };
      try {
        removal = project ? await removeWorktree(project.path, rec.spec.worktree, rec.spec.branch, rec.spec.baseBranch, discarded) : { error: `project ${rec.spec.project} is not registered` };
      } catch (e) {
        removal = { error: (e as Error).message };
      }
      return { view: await this.viewAfterTick(task), removal };
    });
  }

  /** Marks `notified` for each delivered notice. Called by the shell after the wake is delivered. */
  markNotified(notices: readonly NoticeRef[]): Promise<void> {
    return this.mutate(async () => {
      for (const n of notices) this.store.appendEvent(n.task, { type: "notified", at: this.now(), run: n.run });
    });
  }

  /** Deletes pass.lock while it names this session. Cooks keep running. */
  release(): void {
    if (leaseIsMine(this.store, this.deps.self)) this.store.removeLease();
  }

  // ---------- the tick ----------

  private async runTick(): Promise<TickReport> {
    if (!leaseIsMine(this.store, this.deps.self)) return { kind: "lost", holder: holderOf(this.store.readLease()) };
    const snap = this.snapshot();
    const { records } = snap;
    const live = await this.liveCooks(records);
    const cap = snap.config.maxCooks;
    const { views, actions } = plan({ records, live, now: this.now(), cap, killGraceMs: this.deps.killGraceMs ?? 5000 });
    const notices: Notice[] = [];
    const errors: string[] = [...snap.problems];
    let launched = false;
    for (const action of actions) {
      launched ||= action.kind === "launch";
      try {
        if (action.kind === "notify") notices.push(action.notice);
        else await this.execute(action, records.find((r) => r.spec.id === action.task)!);
      } catch (e) {
        errors.push(`${action.kind} ${"task" in action ? action.task : ""}: ${(e as Error).message}`);
      }
    }
    // A launch attempt changes the views this tick reports: the board shows the cook or the failure, not the queue.
    const fresh = launched ? plan({ records: this.snapshot().records, live: await this.cooks.live(), now: this.now(), cap, killGraceMs: 0 }).views : views;
    return { kind: "ok", board: this.boardOf(fresh, snap, "owner", holderOf(this.store.readLease())), notices, errors };
  }

  private async execute(action: Exclude<Action, { kind: "notify" }>, rec: TaskRecord): Promise<void> {
    const { spec } = rec;
    switch (action.kind) {
      case "launch":
        try {
          await this.launch(action, spec);
        } catch (e) {
          this.store.appendEvent(spec.id, { type: "launch_failed", at: this.now(), run: action.run, reason: (e as Error).message });
          throw e;
        }
        return;
      case "signal":
        await signalCook(action.pid, spec.sessionId, action.signal);
        return;
      case "remove-worktree": {
        const project = this.store.readProject(spec.project);
        if (project) await removeWorktree(project.path, spec.worktree, spec.branch, spec.baseBranch, action.discard);
        return;
      }
    }
  }

  private async launch(action: Extract<Action, { kind: "launch" }>, spec: TaskSpec): Promise<void> {
    const project = this.requireProject(spec.project);
    await ensureWorktree(project.path, spec.worktree, spec.branch, spec.baseBranch);
    const pending = this.store.pendingMessages(spec.id);
    const texts = pending.map((m) => m.text);
    if (action.prompt === "existing") {
      const existing = this.store.readPrompt(spec.id, action.run) ?? "";
      if (texts.length) this.store.writePrompt(spec.id, action.run, `${existing.trimEnd()}\n\n${messagesSection(texts).join("\n")}\n`);
    } else {
      this.store.writePrompt(spec.id, action.run, action.prompt === "brief" ? firstPrompt(spec, project, texts) : followUpPrompt(texts));
    }
    this.store.moveToHandled(spec.id, pending.map((m) => m.file));
    if (action.reclaim) this.store.releaseEmptyClaim(spec.id, action.run);
    const fds = this.store.claimRun(spec.id, action.run);
    if (!fds) return;
    const pid = launchCook(
      {
        pi: this.deps.pi,
        chefEntry: this.deps.chefEntry,
        spec,
        run: action.run,
        promptFile: this.store.runPrompt(spec.id, action.run),
        sessionDir: this.store.sessionDir(spec.id),
        taskDir: this.store.taskDir(spec.id),
        config: this.store.readConfig(),
        fds,
      },
      (end) => this.cookEnded(spec.id, action.run, end),
    );
    if (pid !== undefined) this.cooks.record(spec.sessionId, pid);
  }

  /**
   * A cook that exits before its first output line failed to launch (a bad model,
   * a broken extension, a missing binary). Recording it stops the tick from
   * respawning it every second. A run that produced output follows the file rules.
   */
  private cookEnded(task: TaskId, run: RunNo, end: CookEnd): void {
    const reason = end.kind === "error" ? end.message : `cook exited with ${end.signal ?? `code ${end.code}`} before its first output line`;
    void this.mutate(async () => {
      if (this.store.runBytes(task, run) === 0) this.store.appendEvent(task, { type: "launch_failed", at: this.now(), run, reason });
    }).catch(() => undefined);
  }

  /** Inside a mutation: the tick body runs directly, the chain is already held. */
  private async viewAfterTick(task: TaskId): Promise<TaskView> {
    const report = await this.runTick();
    if (report.kind === "lost") throw lostError(report.holder);
    const view = report.board.open.find((v) => v.spec.id === task);
    if (view) return view;
    const rec = this.store.loadRecord(task, this.tails);
    return deriveTask(rec, new Map(), this.now());
  }

  private requireProject(name: string): Project {
    const projects = this.store.readProjects();
    const project = projects.find((p) => p.name === name.trim().toLowerCase());
    if (project) return project;
    const known = projects.map((p) => p.name).join(", ") || "none";
    throw new ChefError(`Unknown project "${name}". Registered projects: ${known}. Register one with chef_add_project.`);
  }
}

export function lostError(holder: Holder | undefined): ChefError {
  const who = holder ? `Another Pi session (pid ${holder.pid}) owns this kitchen` : "This session no longer owns the kitchen";
  return new ChefError(`${who}. You can read the board and results here. Run /chef takeover to move the kitchen to this session.`);
}

// ---------- Lease ----------

function holderOf(lease: ReturnType<Store["readLease"]>): Holder | undefined {
  return lease ? { pid: lease.pid as Pid, sessionId: lease.sessionId, since: millis(lease.since) } : undefined;
}

/**
 * Self-healing: no lease, an unreadable one, or a holder whose pid is dead or
 * whose start time differs is replaced. A live foreign holder wins unless
 * `takeover`. Returns the holder when this session does not get the lease.
 */
export async function acquireLease(store: Store, self: KitchenDeps["self"], takeover: boolean): Promise<Holder | undefined> {
  const lease = store.readLease();
  if (lease && !(lease.pid === self.pid && lease.sessionId === self.sessionId)) {
    const start = await pidStart(lease.pid);
    if (start !== undefined && start === lease.pidStart && !takeover) return holderOf(lease);
  }
  store.writeLease({ pid: self.pid, pidStart: (await pidStart(self.pid)) ?? "", sessionId: self.sessionId, since: Date.now() });
  return undefined;
}

export function leaseIsMine(store: Store, self: KitchenDeps["self"]): boolean {
  const lease = store.readLease();
  return lease !== undefined && lease.pid === self.pid && lease.sessionId === self.sessionId;
}
