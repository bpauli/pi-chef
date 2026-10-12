import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ChefError, ChefModeEntrySchema, errorMessage, type Millis, type Notice, type NoticeRef, type Pid, type TaskId, type WakeDetails, WakeDetailsSchema, millis, parseTaskId, runNo } from "./domain.ts";
import { type RestartNote, boardHeader, outcomeDetail, boardLines, formatAge, formatWake, outcomeText, plural, queuePosition, stateText, statusText } from "./derive.ts";
import { piInvocation } from "./cooks.ts";
import { CookTabs, Herdr } from "./herdr.ts";
import { Kitchen, type KitchenReader, type TaskResult, lostError } from "./kitchen.ts";
import { loadPrinciples, principlesBlock } from "./principles.ts";
import { Store, kitchenDir } from "./store.ts";

export const TICK_MS = 1000;
export const WAKE_TIMING = { quietMs: 1500, maxWaitMs: 5000 };
const WIDGET_WIDTH = 120;
const BOARD_WIDTH = 160;
const CHEF_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

export const CHEF_TOOLS = ["chef_add_project", "chef_dispatch", "chef_board", "chef_send", "chef_stop", "chef_result", "chef_close"] as const;

const AddProjectParams = Type.Object(
  {
    path: Type.String({ description: "Path to a git repository, any directory inside it." }),
    name: Type.Optional(Type.String({ description: "Short name: a-z, 0-9, dashes. Default: the repository directory name, lowercased, with other characters turned into dashes." })),
    note: Type.Optional(Type.String({ description: "One line every cook of this project reads, for example how to run the tests." })),
    baseBranch: Type.Optional(Type.String({ description: "Branch tasks fork from. Default: the current branch of the repository." })),
  },
  { additionalProperties: false },
);
const DispatchParams = Type.Object(
  {
    project: Type.String({ description: "Registered project name." }),
    title: Type.String({ description: "Imperative, under 60 characters, for example 'Add rate limiting to /login'." }),
    brief: Type.String({
      description: "Everything the cook needs: the intent in the human's words, what done means and the check that proves it, constraints, and the delivery (commit only, push, or open a PR). The cook cannot see this conversation.",
    }),
    model: Type.Optional(Type.String({ description: "provider/model for this cook. Default: the kitchen config." })),
  },
  { additionalProperties: false },
);
const TaskParam = Type.String({ description: "Task id, for example api-7." });
const TaskParams = Type.Object({ task: TaskParam }, { additionalProperties: false });
const SendParams = Type.Object({ task: TaskParam, message: Type.String({ description: "An answer, a correction, or the next instruction. Plain text." }) }, { additionalProperties: false });
const CloseParams = Type.Object(
  { task: TaskParam, discard: Type.Optional(Type.Boolean({ description: "Drop unlanded commits and a dirty worktree. Only on the human's explicit word." })) },
  { additionalProperties: false },
);
const NoParams = Type.Object({}, { additionalProperties: false });

const noticeKey = (n: NoticeRef): string => `${n.task}#${n.run}`;

/**
 * A sent wake stays in flight until Pi reports its `message_end`, because a
 * wake sent mid-turn sits in Pi's follow-up queue, which Escape or an abort
 * drops. `notified` is written only on that `message_end`. Until then the tick
 * derives the notice again every second, and the in-flight set keeps it from
 * being sent twice. When the agent settles with wakes still in flight, Pi
 * dropped them, so they are released and the next tick sends them again.
 */
export class Waker {
  private readonly pending = new Map<string, Notice>();
  private readonly inFlight = new Set<string>();
  private readonly deliver: (notices: Notice[]) => void;
  private readonly timing: { quietMs: number; maxWaitMs: number };
  private readonly clock: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  private quiet: ReturnType<typeof setTimeout> | undefined;
  private cap: ReturnType<typeof setTimeout> | undefined;

  constructor(deliver: (notices: Notice[]) => void, timing = WAKE_TIMING, clock: Pick<typeof globalThis, "setTimeout" | "clearTimeout"> = globalThis) {
    this.deliver = deliver;
    this.timing = timing;
    this.clock = clock;
  }

  offer(notices: readonly Notice[]): void {
    let fresh = false;
    for (const n of notices) {
      const key = noticeKey(n);
      if (this.pending.has(key) || this.inFlight.has(key)) continue;
      this.pending.set(key, n);
      fresh = true;
    }
    if (!fresh) return;
    if (this.quiet) this.clock.clearTimeout(this.quiet);
    this.quiet = this.clock.setTimeout(() => this.flush(), this.timing.quietMs);
    this.cap ??= this.clock.setTimeout(() => this.flush(), this.timing.maxWaitMs);
  }

  private clearTimers(): void {
    if (this.quiet) this.clock.clearTimeout(this.quiet);
    if (this.cap) this.clock.clearTimeout(this.cap);
    this.quiet = this.cap = undefined;
  }

  private flush(): void {
    this.clearTimers();
    const notices = [...this.pending.values()];
    this.pending.clear();
    for (const n of notices) this.inFlight.add(noticeKey(n));
    if (notices.length) this.deliver(notices);
  }

  delivered(notices: readonly NoticeRef[]): void {
    for (const n of notices) {
      this.inFlight.delete(noticeKey(n));
      this.pending.delete(noticeKey(n));
    }
  }

  settled(): void {
    this.inFlight.clear();
  }

  dispose(): void {
    this.clearTimers();
    this.pending.clear();
    this.inFlight.clear();
  }
}

interface ChefSession {
  store: Store;
  reader: KitchenReader;
  owner: Kitchen | undefined;
  waker: Waker | undefined;
  tabs: CookTabs | undefined;
  timer: ReturnType<typeof setInterval>;
  lastLines: string;
  restart: RestartNote | undefined;
  firstTick: boolean;
  ticking: boolean;
  lastErrors: Set<string>;
}

const agentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const now = (): Millis => millis(Date.now());

export function installChef(pi: ExtensionAPI): void {
  let session: ChefSession | undefined;

  pi.registerFlag("chef", { type: "boolean", description: "Open the chef kitchen in this session." });

  const activeWithChef = (on: boolean): string[] => {
    const others = pi.getActiveTools().filter((t) => !CHEF_TOOLS.some((c) => c === t));
    return on ? [...others, ...CHEF_TOOLS] : others;
  };

  const chefModeOn = (ctx: ExtensionContext): boolean => {
    const entries = ctx.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "chef-mode");
    const last = entries.at(-1);
    return last?.type === "custom" && Value.Check(ChefModeEntrySchema, last.data) && last.data.on;
  };

  const wakerFor = (current: ChefSession): Waker =>
    new Waker((notices) => {
      const details: WakeDetails = { notices };
      pi.sendMessage({ customType: "chef-wake", content: formatWake(notices, current.restart), display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
      current.restart = undefined;
    });

  const tabsFor = (store: Store): CookTabs | undefined => {
    const herdr = Herdr.fromEnv(process.env);
    return herdr && new CookTabs(herdr, (id) => store.taskDir(id));
  };

  let opening: Promise<ChefSession> | undefined;
  const open = (ctx: ExtensionContext, takeover = false): Promise<ChefSession> => {
    if (session && !takeover) return Promise.resolve(session);
    if (opening) return opening;
    opening = openNow(ctx, takeover).finally(() => {
      opening = undefined;
    });
    return opening;
  };

  const openNow = async (ctx: ExtensionContext, takeover: boolean): Promise<ChefSession> => {
    if (session) close(ctx);
    const store = new Store(kitchenDir(process.env, agentDir()));
    const self = { pid: process.pid as Pid, sessionId: ctx.sessionManager.getSessionId() };
    const opened = await Kitchen.open({ store, pi: piInvocation(), chefEntry: CHEF_ENTRY, self }, { takeover });
    const owner = opened.kind === "owner" ? opened.kitchen : undefined;
    const current: ChefSession = {
      store,
      reader: opened.kind === "owner" ? opened.kitchen : opened.reader,
      owner,
      waker: undefined,
      tabs: undefined,
      timer: setInterval(() => void tick(ctx), TICK_MS),
      lastLines: "",
      restart: undefined,
      firstTick: true,
      ticking: false,
      lastErrors: new Set(),
    };
    current.timer.unref();
    if (owner) {
      current.waker = wakerFor(current);
      current.tabs = tabsFor(store);
    }
    session = current;
    pi.setActiveTools(activeWithChef(true));
    if (!chefModeOn(ctx)) pi.appendEntry("chef-mode", { on: true });
    await tick(ctx);
    return current;
  };

  const showErrors = (s: ChefSession, ctx: ExtensionContext, errors: readonly string[]): void => {
    for (const err of errors) if (!s.lastErrors.has(err) && ctx.hasUI) ctx.ui.notify(`chef: ${err}`, "error");
    s.lastErrors = new Set(errors);
  };

  const tick = async (ctx: ExtensionContext): Promise<void> => {
    const s = session;
    if (!s || s.ticking) return;
    s.ticking = true;
    try {
      let board;
      if (s.owner) {
        const report = await s.owner.tick();
        if (report.kind === "lost") {
          s.owner = undefined;
          s.waker?.dispose();
          s.waker = undefined;
          s.tabs = undefined;
          if (ctx.hasUI) ctx.ui.notify(lostError(report.holder).message, "warning");
          board = await s.reader.board();
        } else {
          if (s.firstTick && report.notices.length) s.restart = { cooking: report.board.cooks.busy, finished: report.notices.length };
          s.waker?.offer(report.notices);
          const herdrErrors = s.tabs ? await s.tabs.sync(report.board.open) : [];
          showErrors(s, ctx, [...report.errors, ...herdrErrors]);
          board = report.board;
        }
      } else {
        const promoted = await s.reader.promote();
        if (promoted) {
          s.owner = promoted;
          s.reader = promoted;
          s.waker = wakerFor(s);
          s.tabs = tabsFor(s.store);
          s.firstTick = true;
          if (ctx.hasUI) ctx.ui.notify("chef: this session now owns the kitchen.", "info");
        }
        board = await s.reader.board();
      }
      s.firstTick = false;
      const lines = boardLines(board, now(), WIDGET_WIDTH);
      const key = lines.join("\n");
      if (key !== s.lastLines && ctx.hasUI) {
        s.lastLines = key;
        ctx.ui.setWidget("chef", lines.length ? lines : undefined, { placement: "belowEditor" });
        ctx.ui.setStatus("chef", statusText(board));
      }
    } catch (e) {
      showErrors(s, ctx, [`tick failed: ${errorMessage(e)}`]);
    } finally {
      s.ticking = false;
    }
  };

  const close = (ctx: ExtensionContext | undefined): void => {
    if (!session) return;
    clearInterval(session.timer);
    session.waker?.dispose();
    session.owner?.release();
    if (ctx?.hasUI) {
      ctx.ui.setWidget("chef", undefined);
      ctx.ui.setStatus("chef", undefined);
    }
    session = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("chef") === true || chefModeOn(ctx)) await open(ctx);
  });
  pi.on("session_shutdown", () => close(undefined));
  pi.on("message_end", (event) => {
    const m = event.message;
    const s = session;
    if (m.role !== "custom" || m.customType !== "chef-wake" || !s?.owner || !s.waker) return;
    if (!Value.Check(WakeDetailsSchema, m.details)) return;
    const notices: NoticeRef[] = m.details.notices.map((n) => ({ task: n.task as TaskId, run: runNo(n.run) }));
    s.waker.delivered(notices);
    void s.owner.markNotified(notices).catch(() => undefined);
  });
  pi.on("agent_settled", () => session?.waker?.settled());
  const principles = principlesBlock("chef", loadPrinciples());
  pi.on("before_agent_start", (event) => (session ? { systemPrompt: `${event.systemPrompt}\n\n${principles}` } : undefined));

  const reader = (): KitchenReader => {
    if (!session) throw new ChefError("Chef mode is off. Run /chef, or start pi with --chef.");
    return session.reader;
  };
  const owner = (): Kitchen => {
    const r = reader();
    if (!session?.owner) throw lostError(r.holder());
    return session.owner;
  };
  const task = (raw: string): TaskId => parseTaskId(raw, reader().taskIds());
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
  const common = { defaultActive: false as const, exposure: "model-only" as const, executionMode: "sequential" as const };

  pi.registerTool({
    ...common,
    name: "chef_add_project",
    label: "Add project",
    description: "Register a git repository as a kitchen project, so tasks can be dispatched to it.",
    promptSnippet: "Register a git repository as a chef project",
    parameters: AddProjectParams,
    async execute(_id, params) {
      const p = await owner().addProject(params);
      return text(`Registered ${p.name}: ${p.path}, tasks fork from ${p.baseBranch}.`);
    },
  });

  pi.registerTool({
    ...common,
    name: "chef_dispatch",
    label: "Dispatch",
    description: "Create a task for a project and hand it to a cook, a Pi agent in its own git worktree and branch. Starts at once or queues behind the cook limit.",
    promptSnippet: "Hand a task to a cook in its own worktree",
    promptGuidelines: [
      "Before the first chef_dispatch in a session, load the chef skill.",
      "Never poll cooks. A kitchen update message wakes you when a cook is done, needs a decision, is blocked, or failed.",
      "One task is one branch of reviewable work in one project. Split larger requests.",
    ],
    parameters: DispatchParams,
    async execute(_id, params) {
      const k = owner();
      const view = await k.dispatch(params);
      const board = await k.board();
      const cooks = `${board.cooks.busy}/${board.cooks.cap} cooks busy`;
      if (view.state.kind === "cooking") return text(`${view.spec.id} is cooking on branch ${view.spec.branch} (${cooks}). You will get a kitchen update when it needs you.`);
      if (view.state.kind === "idle") return text(`${view.spec.id} failed to launch: ${view.state.outcome.kind === "failed" ? view.state.outcome.reason : outcomeText(view.state.outcome)}. Fix the cause, then chef_send ${view.spec.id} to retry.`);
      return text(`${view.spec.id} is queued, position ${queuePosition(board, view.spec.id)} (${cooks}). It starts when a cook frees up.`);
    },
  });

  pi.registerTool({
    ...common,
    name: "chef_board",
    label: "Board",
    description: "Show the projects and every open task with its state, current activity, and age.",
    promptSnippet: "Show the kitchen board",
    parameters: NoParams,
    async execute() {
      return text(await boardText(reader()));
    },
  });

  pi.registerTool({
    ...common,
    name: "chef_send",
    label: "Send",
    description: "Send a message to a task's cook: an answer, a correction, a follow-up, or a retry. Steers a running cook. Restarts an idle one on its own session with the message, so it keeps its context.",
    promptSnippet: "Answer, steer, or resume a cook",
    parameters: SendParams,
    async execute(_id, params) {
      const id = task(params.task);
      const d = await owner().send(id, params.message);
      switch (d.kind) {
        case "steer":
          return text(`Sent to ${id}'s running cook. It reads the message after its current step. If the run ends first, chef restarts it with your message.`);
        case "relaunched":
          return text(`${id} restarted (run ${d.run}) with your message.`);
        case "queued":
          return text(`${id} restarts with your message when a cook frees up (position ${d.position}).`);
        case "after-exit":
          return text(`${id} holds your message. Its last cook reported and is still exiting. chef restarts ${id} with your message as soon as it has exited.`);
        case "after-stop":
          return text(`${id} is stopping. Your message waits in its inbox and restarts ${id} as soon as the cook has exited.`);
        case "launch-failed":
          return text(`${id} could not restart with your message: ${d.reason} Fix the cause, then chef_send ${id} again.`);
      }
    },
  });

  pi.registerTool({
    ...common,
    name: "chef_stop",
    label: "Stop",
    description: "Stop a task's cook now, or hold a queued task. The worktree and branch stay. chef_send resumes it.",
    promptSnippet: "Stop a cook",
    parameters: TaskParams,
    async execute(_id, params) {
      const id = task(params.task);
      const { view, signalled } = await owner().stop(id);
      const { state } = view;
      if (state.kind === "idle" && state.outcome.kind === "stopped") {
        return text(state.run === undefined ? `${id} is held before its first run. chef_send ${id} starts it.` : `${id} stopped. Its worktree and branch stay. chef_send ${id} resumes it.`);
      }
      if (state.kind === "cooking") return text(`${id} is stopping. The cook gets SIGTERM now and SIGKILL after the grace period.`);
      if (signalled) return text(`${id} is ${stateText(state)}; its cook had reported and was still running. It gets SIGTERM now and SIGKILL after the grace period.`);
      return text(`${id} is ${stateText(state)}. Nothing to stop.`);
    },
  });

  pi.registerTool({
    ...common,
    name: "chef_result",
    label: "Result",
    description: "Read a task's outcome for review: the cook's report or final text, branch, commits ahead of base, landed or not, worktree clean or dirty, diffstat, and the transcript path.",
    promptSnippet: "Review a task's outcome",
    parameters: TaskParams,
    async execute(_id, params) {
      const id = task(params.task);
      return text(resultText(await reader().result(id), now()));
    },
  });

  pi.registerTool({
    ...common,
    name: "chef_close",
    label: "Close",
    description: "Close a finished task: remove its worktree and record it closed. Refuses a dirty worktree or commits that are on neither the base branch nor a remote branch, unless discard is true.",
    promptSnippet: "Close a landed task",
    parameters: CloseParams,
    async execute(_id, params) {
      const id = task(params.task);
      const { view, removal } = await owner().close(id, params.discard === true);
      if ("error" in removal) return text(`${id} closed. Removing its worktree failed: ${removal.error} chef retries it on every tick.`);
      const worktree = removal.worktree === "removed" ? "Worktree removed." : "Worktree was already gone.";
      const branch = { deleted: `Branch ${view.spec.branch} deleted.`, kept: `Branch ${view.spec.branch} kept: its commits are not on ${view.spec.baseBranch}.`, missing: `Branch ${view.spec.branch} was already gone.` }[removal.branch];
      return text(`${id} closed. ${worktree} ${branch}`);
    },
  });

  pi.registerCommand("chef", {
    description: "Open the chef kitchen here and show the board. /chef on | off | takeover | board",
    getArgumentCompletions: (prefix) => ["on", "off", "takeover", "board"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const verb = args.trim() || "on";
      if (verb === "off") {
        close(ctx);
        pi.setActiveTools(activeWithChef(false));
        pi.appendEntry("chef-mode", { on: false });
        ctx.ui.notify("Chef mode is off in this session. Cooks keep running.", "info");
        return;
      }
      if (!["on", "takeover", "board"].includes(verb)) {
        ctx.ui.notify("Usage: /chef [on | off | takeover | board]", "warning");
        return;
      }
      const s = await open(ctx, verb === "takeover");
      ctx.ui.notify(await boardText(s.reader), "info");
    },
  });
}

async function boardText(reader: KitchenReader): Promise<string> {
  const board = await reader.board();
  const projects = board.projects.length ? board.projects.map((p) => `${p.name}: ${p.path} (base ${p.baseBranch})`).join("\n") : "No projects. Register one with chef_add_project.";
  const lines = board.open.length || board.broken.length ? boardLines(board, now(), BOARD_WIDTH) : [boardHeader(board), "No open tasks."];
  const closed = board.closedCount ? `${plural(board.closedCount, "closed task")} not shown.` : "";
  return [projects, "", ...lines, closed].filter((l, i, all) => l !== "" || i < all.length - 1).join("\n");
}

const RESULT = { max: 4000, bodyMin: 200, bodyMax: 2000, diffstatReserve: 400, partBreaks: 4 };
const CUT = { mark: " [cut]", min: 20 };

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return max < CUT.min ? "" : `${text.slice(0, max - CUT.mark.length)}${CUT.mark}`;
}

export function resultText(r: TaskResult, at: Millis): string {
  const { spec, state } = r.view;
  const age = state.kind === "idle" || state.kind === "cooking" ? ` ${formatAge(state.since, at)}` : "";
  const run = state.kind === "idle" && state.run !== undefined ? `, run ${state.run}` : state.kind === "cooking" ? `, run ${state.run}` : "";
  const head = `${spec.id} "${spec.title}": ${state.kind === "idle" ? `idle${age}, ${outcomeText(state.outcome)}` : stateText(state) + age}${run}.`;
  let body = "";
  if (state.kind === "idle") {
    const o = state.outcome;
    const raw = outcomeDetail(o);
    if (raw) body = `${o.kind === "needs_decision" ? "Question" : o.kind === "done" ? "Summary" : "Reason"}: ${raw.trim()}`;
  }
  let where: string;
  if (r.git) {
    const landed = r.git.unlanded === 0 ? (r.git.ahead ? "all on a remote-tracking ref as of the last fetch" : "nothing to land") : `${r.git.unlanded} not landed`;
    const clean = r.git.dirtyFiles ? `${plural(r.git.dirtyFiles, "changed file")}` : "clean";
    const off = r.git.onBranch ? "" : ` HEAD is not on ${spec.branch}: commits made there are not on the task branch.`;
    where = `Branch ${spec.branch} in ${spec.worktree}: ${plural(r.git.ahead, "commit")} ahead of ${spec.baseBranch}, ${landed}, ${clean}.${off}`;
  } else {
    where = `Worktree ${spec.worktree} is gone. Branch ${spec.branch} may still exist in ${r.project?.path ?? "the repository"}.`;
  }
  const transcript = r.transcript ? `Transcript: ${r.transcript}` : "";
  const fixed = head.length + where.length + transcript.length + RESULT.partBreaks;
  const bodyText = cut(body, Math.max(RESULT.bodyMin, Math.min(RESULT.bodyMax, RESULT.max - fixed - RESULT.diffstatReserve)));
  const diffText = cut(r.git ? r.diffstat : "", Math.max(0, RESULT.max - fixed - bodyText.length - 1));
  return [head, bodyText, where, diffText, transcript].filter(Boolean).join("\n");
}
