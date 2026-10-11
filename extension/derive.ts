// Pure kitchen logic. No fs, no processes, no Pi. Restart reconciliation is not
// a code path of its own: it is the first call of `plan`.

import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type Activity,
  type Board,
  type CookReport,
  CookReportSchema,
  type Millis,
  type Notice,
  type Outcome,
  type Pid,
  type RunNo,
  type TaskEvent,
  type TaskId,
  type TaskSpec,
  type TaskState,
  type TaskView,
  millis,
  runNo,
} from "./domain.ts";

// ---------- Run facts: a fold over one run's Pi JSONL stream ----------

export interface RunFacts {
  startedAt: Millis | undefined;
  lastAt: Millis | undefined;
  settled: boolean;
  /** The run's prompt reached the session as a user message, so the session holds the brief. */
  prompted: boolean;
  activity: Activity;
  report: CookReport | undefined;
  finalText: string | undefined;
  providerError: string | undefined;
}

export const EMPTY_RUN: RunFacts = {
  startedAt: undefined,
  lastAt: undefined,
  settled: false,
  prompted: false,
  activity: { kind: "starting" },
  report: undefined,
  finalText: undefined,
  providerError: undefined,
};

// Only the fields chef reads. Value.Check ignores extra fields.
const TimedMessageLine = Type.Object({ type: Type.Literal("message_end"), message: Type.Object({ timestamp: Type.Number() }) });
const TurnStartLine = Type.Object({ type: Type.Literal("turn_start") });
const ToolStartLine = Type.Object({ type: Type.Literal("tool_execution_start"), toolName: Type.String(), args: Type.Unknown() });
const ToolEndLine = Type.Object({
  type: Type.Literal("tool_execution_end"),
  toolName: Type.String(),
  isError: Type.Boolean(),
  result: Type.Object({ structuredContent: Type.Optional(Type.Unknown()) }),
});
const AssistantEndLine = Type.Object({
  type: Type.Literal("message_end"),
  message: Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) })),
    errorMessage: Type.Optional(Type.String()),
    stopReason: Type.Optional(Type.String()),
    timestamp: Type.Optional(Type.Number()),
  }),
});
const UserEndLine = Type.Object({ type: Type.Literal("message_end"), message: Type.Object({ role: Type.Literal("user") }) });
const SettledLine = Type.Object({ type: Type.Literal("agent_settled") });

export function foldRunLine(facts: RunFacts, line: string): RunFacts {
  if (line.startsWith('{"type":"message_update"')) return facts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return facts;
  }
  // The session header repeats the session's creation time on every relaunch, so
  // the run starts at its first timestamped message.
  if (facts.startedAt === undefined && Value.Check(TimedMessageLine, parsed)) facts = { ...facts, startedAt: millis(parsed.message.timestamp) };
  if (Value.Check(TurnStartLine, parsed)) return { ...facts, activity: { kind: "thinking" } };
  if (Value.Check(ToolStartLine, parsed)) {
    return { ...facts, activity: { kind: "tool", tool: parsed.toolName, detail: activityDetail(parsed.toolName, parsed.args) } };
  }
  if (Value.Check(ToolEndLine, parsed)) {
    const content = parsed.result.structuredContent;
    const isReport = parsed.toolName === "chef_report" && !parsed.isError && Value.Check(CookReportSchema, content);
    // A report and a provider error are two verdicts on the run: the later one in the stream wins.
    return isReport ? { ...facts, activity: { kind: "thinking" }, report: content, providerError: undefined } : { ...facts, activity: { kind: "thinking" } };
  }
  if (Value.Check(AssistantEndLine, parsed)) {
    const { message } = parsed;
    const text = message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("").trim();
    const failed = message.errorMessage !== undefined || message.stopReason === "error";
    return {
      ...facts,
      lastAt: message.timestamp === undefined ? facts.lastAt : millis(message.timestamp),
      finalText: text || facts.finalText,
      providerError: failed ? (message.errorMessage ?? "provider error") : undefined,
      report: failed ? undefined : facts.report,
    };
  }
  if (Value.Check(UserEndLine, parsed)) return { ...facts, prompted: true };
  if (Value.Check(SettledLine, parsed)) return { ...facts, settled: true };
  return facts;
}

const DETAIL_MAX = 60;

/** `npm test` for bash, the path for file tools, else the arguments; one line, capped. */
export function activityDetail(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const pick = tool === "bash" ? a.command : (a.path ?? a.file_path ?? a.pattern);
  const text = typeof pick === "string" ? pick : JSON.stringify(a);
  return oneLine(text ?? "", DETAIL_MAX);
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------- Task records: what the store hands to derive ----------

export interface RunRecord {
  n: RunNo;
  /** runs/<n>.jsonl exists. A prompt without it is an interrupted launch. */
  claimed: boolean;
  /** Size of runs/<n>.jsonl. Zero with no live process and an empty err file is an interrupted launch. */
  bytes: number;
  /** Modification time of runs/<n>.jsonl, undefined when unclaimed. For an empty claim this is the claim time. */
  claimedAt: Millis | undefined;
  facts: RunFacts;
  /** Tail of runs/<n>.err, read for every claimed run that has not settled. */
  stderrTail: string;
}

export interface TaskRecord {
  spec: TaskSpec;
  events: readonly TaskEvent[];
  /** Ascending by n, one per runs/<n>.prompt.md. */
  runs: readonly RunRecord[];
  /** Creation time of each inbox/*.msg still pending, from its file name. */
  pendingAt: readonly Millis[];
  worktreeExists: boolean;
}

/** Live cook processes, keyed by the `CHEF_SESSION_ID` in their environment. */
export type LiveCooks = ReadonlyMap<string, Pid>;

/** The last launch attempt produced no output. Its run number is used up. */
export interface LaunchFailure {
  run: RunNo;
  at: Millis;
  reason: string;
}

interface Folded {
  last: RunRecord | undefined;
  nextRun: RunNo;
  lastStop: Extract<TaskEvent, { type: "stop" }> | undefined;
  closed: Extract<TaskEvent, { type: "closed" }> | undefined;
  launchFailure: LaunchFailure | undefined;
  /** A message newer than the last stop or launch failure resumes a held task. */
  resumable: boolean;
  /** The last stop names the run that would launch next, and nothing newer resumes it. */
  held: boolean;
  /** Some run delivered its prompt, so the session holds the brief and a relaunch sends only messages. */
  briefDelivered: boolean;
}

const errTail = (text: string): string => text.trim().split("\n").filter(Boolean).slice(-3).join(" ");

/**
 * From the owner's `launch_failed` event for a run that never started, or from
 * the files alone: an empty claim with a dead process and a non-empty err file.
 * The event wins when both name the same run; the files alone cover a failure
 * that happened while no owner ran.
 */
function launchFailureOf(rec: TaskRecord, last: RunRecord | undefined): LaunchFailure | undefined {
  const event = rec.events.filter((e) => e.type === "launch_failed").at(-1);
  const emptyClaim = last !== undefined && last.claimed && last.bytes === 0 ? last : undefined;
  const tail = emptyClaim ? errTail(emptyClaim.stderrTail) : "";
  if (event && !rec.runs.some((r) => r.n === event.run && r.bytes > 0) && (last === undefined || event.run >= last.n)) {
    const detail = tail && emptyClaim?.n === event.run ? `${event.reason}: ${tail}` : event.reason;
    return { run: runNo(event.run), at: millis(event.at), reason: detail };
  }
  if (emptyClaim && tail) {
    return { run: emptyClaim.n, at: emptyClaim.claimedAt ?? millis(0), reason: `cook exited before its first output line: ${tail}` };
  }
  return undefined;
}

function fold(rec: TaskRecord): Folded {
  const last = rec.runs.at(-1);
  const lastStop = rec.events.filter((e) => e.type === "stop").at(-1);
  const closed = rec.events.find((e) => e.type === "closed");
  const launchFailure = launchFailureOf(rec, last);
  // An interrupted launch (an empty claim with an empty err file) is relaunched as
  // the same run. A failed launch used its number up, so the retry is the next run.
  const started = last !== undefined && last.claimed && last.bytes > 0;
  const fromRuns = last === undefined ? 1 : started ? last.n + 1 : last.n;
  const nextRun = runNo(Math.max(fromRuns, launchFailure ? launchFailure.run + 1 : 1));
  const holdAt = Math.max(lastStop?.at ?? Number.NEGATIVE_INFINITY, launchFailure?.at ?? Number.NEGATIVE_INFINITY);
  // Same millisecond: the chain wrote the hold first, so the message is the newer fact.
  const resumable = rec.pendingAt.some((at) => at >= holdAt);
  return {
    last,
    nextRun,
    lastStop,
    closed,
    launchFailure,
    resumable,
    held: lastStop !== undefined && lastStop.run === nextRun && !resumable,
    briefDelivered: rec.runs.some((r) => r.facts.prompted),
  };
}

export function nextRunOf(rec: TaskRecord): RunNo {
  return fold(rec).nextRun;
}

/**
 * The state machine. First match wins:
 *   closed event                                   -> closed
 *   live process and the last run is not settled   -> cooking
 *   the last launch failed                         -> idle(failed), or queued(message) when a newer message resumes it
 *   last run has no run file, or an empty one      -> queued(interrupted-launch), or idle(stopped) when held
 *   a message newer than the last stop             -> queued(message)
 *   no runs                                        -> queued(new), or idle(stopped) when held
 *   otherwise                                      -> idle(outcomeOf(last run))
 * `settled` beats liveness, so a run whose process is still exiting is idle. The
 * launch guard in `plan` still waits for the exit.
 */
export function deriveTask(rec: TaskRecord, live: LiveCooks, now: Millis): TaskView {
  const view = (state: TaskState): TaskView => ({ spec: rec.spec, state });
  const { last, lastStop, closed, launchFailure, resumable, held } = fold(rec);
  if (closed) return view({ kind: "closed", at: millis(closed.at), discarded: closed.discarded });
  const pid = live.get(rec.spec.sessionId);
  if (pid !== undefined && last?.claimed && !last.facts.settled) {
    return view({ kind: "cooking", run: last.n, since: last.facts.startedAt ?? last.claimedAt ?? now, activity: last.facts.activity });
  }
  if (launchFailure) {
    if (resumable) return view({ kind: "queued", why: "message" });
    return view({ kind: "idle", run: launchFailure.run, since: launchFailure.at, outcome: { kind: "failed", reason: launchFailure.reason } });
  }
  const stopped = (run: RunNo | undefined): TaskView => view({ kind: "idle", run, since: millis(lastStop?.at ?? now), outcome: { kind: "stopped" } });
  if (last && (!last.claimed || last.bytes === 0)) return held ? stopped(rec.runs.at(-2)?.n) : view({ kind: "queued", why: "interrupted-launch" });
  if (resumable) return view({ kind: "queued", why: "message" });
  if (!last) return held ? stopped(undefined) : view({ kind: "queued", why: "new" });
  if (held) return stopped(last.n);
  const since = last.facts.lastAt ?? last.facts.startedAt ?? now;
  return view({ kind: "idle", run: last.n, since, outcome: outcomeOf(last, lastStop?.run === last.n) });
}

/** How an ended run ended. Total over RunRecord, so every run has one outcome. */
export function outcomeOf(run: RunRecord, stopped: boolean): Outcome {
  const { facts } = run;
  if (!facts.settled) {
    if (stopped) return { kind: "stopped" };
    const tail = errTail(run.stderrTail);
    return { kind: "failed", reason: tail ? `cook exited before settling: ${tail}` : "cook exited before settling" };
  }
  if (facts.report) {
    const { status, summary } = facts.report;
    if (status === "done") return { kind: "done", summary, reported: true };
    if (status === "needs_decision") return { kind: "needs_decision", question: summary };
    if (status === "blocked") return { kind: "blocked", reason: summary };
    return { kind: "failed", reason: summary };
  }
  if (facts.providerError !== undefined) return { kind: "failed", reason: facts.providerError };
  if (stopped) return { kind: "stopped" };
  return { kind: "done", summary: facts.finalText ?? "(no final text)", reported: false };
}

/**
 * A notice is due when the task is idle on run n with an outcome other than
 * stopped and no `notified` event names n. A pending relaunch makes the task
 * queued, so it never has a notice.
 */
export function noticeFor(rec: TaskRecord, view: TaskView): Notice | undefined {
  const { state } = view;
  if (state.kind !== "idle" || state.run === undefined || state.outcome.kind === "stopped") return undefined;
  const run = state.run;
  if (rec.events.some((e) => e.type === "notified" && e.run === run)) return undefined;
  return { task: rec.spec.id, title: rec.spec.title, run, outcome: state.outcome };
}

// ---------- Convergence: one plan per tick ----------

export type Action =
  /** `prompt` is `brief` until a run has delivered it, `existing` for an interrupted launch, else `messages`. */
  | { kind: "launch"; task: TaskId; run: RunNo; prompt: "brief" | "messages" | "existing"; reclaim: boolean }
  | { kind: "signal"; task: TaskId; pid: Pid; signal: "SIGTERM" | "SIGKILL" }
  | { kind: "remove-worktree"; task: TaskId; discard: boolean }
  | { kind: "notify"; notice: Notice };

export interface PlanInput {
  records: readonly TaskRecord[];
  live: LiveCooks;
  now: Millis;
  cap: number;
  /** SIGKILL this long after the SIGTERM of a stop, a close, or a stuck exit. */
  killGraceMs: number;
  /** A cook still alive this long after its run settled gets SIGTERM. */
  exitGraceMs: number;
  /** An empty claim is reclaimed only when it is older than this, so a launch in progress elsewhere is not undone. */
  reclaimAfterMs: number;
}

/**
 * Everything the owner must do to converge. Running a plan twice is safe: the
 * executor claims a launch with O_EXCL, a signal re-checks identity, worktree
 * removal accepts a missing path, and notify is marked only after delivery.
 */
export function plan(input: PlanInput): { views: TaskView[]; actions: Action[] } {
  const { live, now, killGraceMs, exitGraceMs, reclaimAfterMs } = input;
  const views: TaskView[] = [];
  const actions: Action[] = [];
  const queued: { rec: TaskRecord; view: TaskView }[] = [];
  let busy = 0;
  const escalate = (since: number): "SIGTERM" | "SIGKILL" => (now - since > killGraceMs ? "SIGKILL" : "SIGTERM");

  for (const rec of input.records) {
    const view = deriveTask(rec, live, now);
    views.push(view);
    const { state } = view;
    const pid = live.get(rec.spec.sessionId);
    const { last, lastStop, closed } = fold(rec);
    if (state.kind === "closed") {
      if (rec.worktreeExists) actions.push({ kind: "remove-worktree", task: rec.spec.id, discard: state.discarded });
      if (pid !== undefined && closed) actions.push({ kind: "signal", task: rec.spec.id, pid, signal: escalate(closed.at) });
      continue;
    }
    if (state.kind === "cooking") {
      busy += 1;
      if (pid !== undefined && lastStop?.run === state.run) {
        actions.push({ kind: "signal", task: rec.spec.id, pid, signal: escalate(lastStop.at) });
      }
      continue;
    }
    if (state.kind === "queued") queued.push({ rec, view });
    const notice = noticeFor(rec, view);
    if (notice) actions.push({ kind: "notify", notice });
    // A settled run whose process has not exited: the task is idle, and after the exit grace the owner ends the process.
    if (pid !== undefined && last?.facts.settled) {
      const settledAt = last.facts.lastAt ?? last.claimedAt ?? now;
      if (now - settledAt > exitGraceMs) actions.push({ kind: "signal", task: rec.spec.id, pid, signal: escalate(settledAt + exitGraceMs) });
    }
  }

  queued.sort((a, b) => a.rec.spec.createdAt - b.rec.spec.createdAt);
  for (const { rec } of queued) {
    if (busy >= input.cap) break;
    if (live.has(rec.spec.sessionId)) continue;
    const { last, nextRun, briefDelivered } = fold(rec);
    const reuse = last !== undefined && last.n === nextRun;
    const reclaim = reuse && last.claimed;
    if (reclaim && now - (last.claimedAt ?? now) < reclaimAfterMs) continue;
    const prompt = reuse ? "existing" : briefDelivered ? "messages" : "brief";
    actions.push({ kind: "launch", task: rec.spec.id, run: nextRun, prompt, reclaim });
    busy += 1;
  }
  return { views, actions };
}

// ---------- Close gate ----------

export interface GitFacts {
  /** `git status --porcelain` entries. Ignored files do not count. */
  dirtyFiles: number;
  /** Commits on the branch not on the base branch. */
  ahead: number;
  /** Commits on the branch reachable from neither the base branch nor any remote-tracking ref. */
  unlanded: number;
  /** The worktree HEAD is the task branch. False for a detached HEAD, another branch, or a rebase in progress. */
  onBranch: boolean;
}

export type CloseVerdict = { ok: true } | { ok: false; reason: string };

export function closeVerdict(task: TaskId, state: TaskState, git: GitFacts | undefined, discard: boolean): CloseVerdict {
  if (state.kind === "closed" || discard) return { ok: true };
  if (state.kind === "cooking") return { ok: false, reason: `${task} is still cooking. chef_stop it first, or pass discard: true to drop its work.` };
  if (state.kind === "queued" && state.why === "message") {
    return { ok: false, reason: `${task} has an undelivered message and is about to relaunch. chef_stop it first, or pass discard: true to drop the message and the work.` };
  }
  if (git === undefined) return { ok: true };
  if (!git.onBranch) {
    return { ok: false, reason: `${task}'s worktree HEAD is not on chef/${task}: a detached HEAD, another branch, or a rebase in progress. Its commits would be lost with the worktree. Put them on chef/${task} first, or pass discard: true if the human said to drop them.` };
  }
  const parts: string[] = [];
  if (git.unlanded > 0) parts.push(`${plural(git.unlanded, "commit")} not on the base branch or any remote branch`);
  if (git.dirtyFiles > 0) parts.push(`${plural(git.dirtyFiles, "changed file")} in the worktree`);
  if (parts.length === 0) return { ok: true };
  return { ok: false, reason: `${task} has ${parts.join(" and ")}. Merge or push the work, or pass discard: true if the human said to drop it.` };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---------- Text the chef model and the human read ----------

export interface RestartNote {
  cooking: number;
  finished: number;
}

const SUMMARY_MAX = 400;

/** One line, capped, ending in a sentence mark so the next sentence does not run into it. */
const sentence = (text: string): string => {
  const flat = oneLine(text, SUMMARY_MAX);
  return /[.!?…]$/.test(flat) ? flat : `${flat}.`;
};

export function noticeLine(n: Notice): string {
  const head = `${n.task} "${n.title}"`;
  const o = n.outcome;
  switch (o.kind) {
    case "done":
      return `${head} is done${o.reported ? "" : " (no chef_report, final text follows)"}: ${sentence(o.summary)} Review with chef_result ${n.task}.`;
    case "needs_decision":
      return `${head} needs a decision: ${sentence(o.question)} Answer with chef_send ${n.task}.`;
    case "blocked":
      return `${head} is blocked: ${sentence(o.reason)} Remove the obstacle and chef_send ${n.task}, or chef_stop it.`;
    case "failed":
      return `${head} failed: ${sentence(o.reason)} chef_send ${n.task} to retry, or tell the human.`;
  }
}

/** 1-based place of a queued task among the queued tasks, oldest first. 0 when it is not queued. */
export function queuePosition(board: Board, task: TaskId): number {
  const queue = board.open.filter((v) => v.state.kind === "queued").sort((a, b) => a.spec.createdAt - b.spec.createdAt);
  return queue.findIndex((v) => v.spec.id === task) + 1;
}

export function formatWake(notices: readonly Notice[], restart?: RestartNote): string {
  const lines = [`Kitchen update (${notices.length}):`, ...notices.map((n) => `- ${noticeLine(n)}`)];
  if (restart) {
    lines.unshift(`Chef restarted: ${plural(restart.cooking, "cook")} still cooking, ${plural(restart.finished, "run")} finished while you were away.`);
  }
  return lines.join("\n");
}

export function stateText(state: TaskState): string {
  switch (state.kind) {
    case "queued":
      return state.why === "new" ? "queued" : state.why === "message" ? "queued with a message" : "queued (relaunch)";
    case "cooking":
      return "cooking";
    case "idle":
      return outcomeText(state.outcome);
    case "closed":
      return state.discarded ? "closed, work discarded" : "closed";
  }
}

export function outcomeText(o: Outcome): string {
  switch (o.kind) {
    case "done":
      return o.reported ? "done" : "done (no report)";
    case "needs_decision":
      return "needs decision";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

export function activityText(a: Activity): string {
  return a.kind === "tool" ? `${a.tool}: ${a.detail}` : a.kind;
}

function glyph(state: TaskState): string {
  if (state.kind === "cooking") return "●";
  if (state.kind === "queued") return "○";
  if (state.kind === "closed") return "-";
  switch (state.outcome.kind) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "stopped":
      return "■";
    default:
      return "!";
  }
}

function needsYou(view: TaskView): boolean {
  const s = view.state;
  return s.kind === "idle" && s.outcome.kind !== "stopped";
}

function detailOf(view: TaskView): string {
  const s = view.state;
  if (s.kind === "cooking") return activityText(s.activity);
  if (s.kind !== "idle") return "";
  const o = s.outcome;
  return o.kind === "done" ? o.summary : o.kind === "needs_decision" ? o.question : o.kind === "stopped" ? "" : o.reason;
}

function ageOf(view: TaskView, now: Millis): string {
  const s = view.state;
  return s.kind === "cooking" || s.kind === "idle" ? formatAge(s.since, now) : "";
}

export function boardHeader(board: Board): string {
  if (board.role === "read-only") {
    const who = board.holder ? `pid ${board.holder.pid} owns the kitchen` : "no owner";
    return `chef (read-only, ${who})`;
  }
  const waiting = board.open.filter(needsYou).length;
  return `chef  ${board.cooks.busy}/${board.cooks.cap} cooks${waiting ? `  ${waiting} needs you` : ""}`;
}

/** One line per open task, each fitted to `width`. An empty board yields []. */
export function boardLines(board: Board, now: Millis, width: number): string[] {
  if (board.open.length === 0 && board.broken.length === 0) return [];
  const rows = [
    ...board.open.map((v) => ({ id: `${glyph(v.state)} ${v.spec.id}`, state: stateText(v.state), detail: detailOf(v), age: ageOf(v, now) })),
    ...board.broken.map((b) => ({ id: `? ${b.id}`, state: "broken", detail: b.reason, age: "" })),
  ];
  const w0 = Math.max(...rows.map((r) => [...r.id].length));
  const w1 = Math.max(...rows.map((r) => r.state.length));
  const lines = rows.map((r) => {
    const prefix = `${r.id.padEnd(w0)}  ${r.state.padEnd(w1)}  `;
    const suffix = r.age ? `  ${r.age}` : "";
    const detail = oneLine(r.detail, Math.max(0, width - [...prefix].length - suffix.length));
    return fit(`${prefix}${detail}`.trimEnd() + suffix, width);
  });
  return [fit(boardHeader(board), width), ...lines];
}

function fit(line: string, width: number): string {
  const chars = [...line];
  return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join("")}…` : line;
}

/** Footer text for setStatus. Undefined when no task is open. */
export function statusText(board: Board): string | undefined {
  if (board.open.length === 0) return undefined;
  const parts = [`${board.cooks.busy} cooking`];
  const waiting = board.open.filter(needsYou).length;
  if (waiting) parts.push(`${waiting} needs you`);
  const queued = board.open.filter((v) => v.state.kind === "queued").length;
  if (queued) parts.push(`${queued} queued`);
  return `chef ${parts.join(", ")}`;
}

export function formatAge(since: Millis, now: Millis): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
