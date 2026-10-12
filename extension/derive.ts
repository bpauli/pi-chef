import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  type Activity,
  type Board,
  type CookReport,
  CookReportSchema,
  type Millis,
  type ModelsConfig,
  type Notice,
  type Outcome,
  type Pid,
  type PrinciplesConfig,
  type Profile,
  type ProjectName,
  type RunNo,
  type TaskEvent,
  type TaskId,
  type TaskSpec,
  type TaskState,
  type TaskView,
  type Tried,
  millis,
  runNo,
} from "./domain.ts";

export type Verdict = { kind: "report"; report: CookReport } | { kind: "provider-error"; message: string };

export interface RunFacts {
  startedAt: Millis | undefined;
  lastAt: Millis | undefined;
  settled: boolean;
  prompted: boolean;
  activity: Activity;
  verdict: Verdict | undefined;
  finalText: string | undefined;
  /** provider/id from the last assistant message. */
  model: string | undefined;
}

export const EMPTY_RUN: RunFacts = {
  startedAt: undefined,
  lastAt: undefined,
  settled: false,
  prompted: false,
  activity: { kind: "starting" },
  verdict: undefined,
  finalText: undefined,
  model: undefined,
};

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
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
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
    return isReport ? { ...facts, activity: { kind: "thinking" }, verdict: { kind: "report", report: content } } : { ...facts, activity: { kind: "thinking" } };
  }
  if (Value.Check(AssistantEndLine, parsed)) {
    const { message } = parsed;
    const text = message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("").trim();
    const failed = message.errorMessage !== undefined || message.stopReason === "error";
    return {
      ...facts,
      lastAt: message.timestamp === undefined ? facts.lastAt : millis(message.timestamp),
      finalText: text || facts.finalText,
      model: message.provider && message.model ? `${message.provider}/${message.model}` : facts.model,
      verdict: failed ? { kind: "provider-error", message: message.errorMessage ?? "provider error" } : facts.verdict?.kind === "report" ? facts.verdict : undefined,
    };
  }
  if (Value.Check(UserEndLine, parsed)) return { ...facts, prompted: true };
  if (Value.Check(SettledLine, parsed)) return { ...facts, settled: true };
  return facts;
}

const DETAIL_MAX = 60;
const ArgsRecord = Type.Record(Type.String(), Type.Unknown());

export function activityDetail(tool: string, args: unknown): string {
  const a = Value.Check(ArgsRecord, args) ? args : {};
  const pick = tool === "bash" ? a.command : (a.path ?? a.file_path ?? a.pattern);
  const text = typeof pick === "string" ? pick : JSON.stringify(a);
  return oneLine(text ?? "", DETAIL_MAX);
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export type Claim = { kind: "none" } | { kind: "empty"; at: Millis } | { kind: "started"; at: Millis };

export interface RunRecord {
  n: RunNo;
  claim: Claim;
  facts: RunFacts;
  stderrTail: string;
}

export interface TaskRecord {
  spec: TaskSpec;
  /** The spec's models, or the kitchen default when the spec has none. */
  candidates: readonly Profile[];
  events: readonly TaskEvent[];
  runs: readonly RunRecord[];
  pendingAt: readonly Millis[];
  worktreeExists: boolean;
}

export type LiveCooks = ReadonlyMap<string, Pid>;

export interface LaunchFailure {
  run: RunNo;
  at: Millis;
  reason: string;
}

interface Folded {
  last: RunRecord | undefined;
  nextRun: RunNo;
  lastStop: Extract<TaskEvent, { type: "stop" }> | undefined;
  lastPause: Extract<TaskEvent, { type: "stop" | "hold" }> | undefined;
  closed: Extract<TaskEvent, { type: "closed" }> | undefined;
  launchFailure: LaunchFailure | undefined;
  resumable: boolean;
  held: boolean;
  briefDelivered: boolean;
  fallback: boolean;
}

const providerError = (run: RunRecord): string | undefined => (run.facts.settled && run.facts.verdict?.kind === "provider-error" ? run.facts.verdict.message : undefined);

/** Each earlier run that failed with a provider error moves this run one candidate down the list. The last candidate stays. */
export function profileFor(rec: TaskRecord, n: RunNo): Profile | undefined {
  const failures = rec.runs.filter((r) => r.n < n && providerError(r) !== undefined).length;
  return rec.candidates[Math.min(failures, rec.candidates.length - 1)];
}

const runModel = (rec: TaskRecord, run: RunRecord): string | undefined => run.facts.model ?? profileFor(rec, run.n)?.model;
const DEFAULT_MODEL_TEXT = "Pi's default model";

/** The run that the next run falls back from: the last run, when it failed with a provider error. */
export function fallbackFrom(rec: TaskRecord): Tried | undefined {
  const last = rec.runs.at(-1);
  const error = last && providerError(last);
  return last && error !== undefined ? { model: runModel(rec, last) ?? DEFAULT_MODEL_TEXT, error } : undefined;
}

const errTail = (text: string): string => text.trim().split("\n").filter(Boolean).slice(-3).join(" ");

function launchFailureOf(rec: TaskRecord, last: RunRecord | undefined): LaunchFailure | undefined {
  const event = rec.events.filter((e) => e.type === "launch_failed").at(-1);
  const emptyClaim = last?.claim.kind === "empty" ? { n: last.n, at: last.claim.at, tail: errTail(last.stderrTail) } : undefined;
  const hasOutput = (run: number): boolean => rec.runs.some((r) => r.n === run && r.claim.kind === "started");
  const notBeforeLastRun = (run: number): boolean => last === undefined || run >= last.n;
  if (event && !hasOutput(event.run) && notBeforeLastRun(event.run)) {
    const reason = emptyClaim?.tail && emptyClaim.n === event.run ? `${event.reason}: ${emptyClaim.tail}` : event.reason;
    return { run: runNo(event.run), at: millis(event.at), reason };
  }
  if (emptyClaim?.tail) return { run: emptyClaim.n, at: emptyClaim.at, reason: `cook exited before its first output line: ${emptyClaim.tail}` };
  return undefined;
}

function fold(rec: TaskRecord): Folded {
  const last = rec.runs.at(-1);
  const lastStop = rec.events.filter((e) => e.type === "stop").at(-1);
  const lastPause = rec.events.filter((e) => e.type === "stop" || e.type === "hold").at(-1);
  const closed = rec.events.find((e) => e.type === "closed");
  const launchFailure = launchFailureOf(rec, last);
  const started = last?.claim.kind === "started";
  const fromRuns = last === undefined ? 1 : started ? last.n + 1 : last.n;
  const nextRun = runNo(Math.max(fromRuns, launchFailure ? launchFailure.run + 1 : 1));
  const holdAt = Math.max(lastPause?.at ?? Number.NEGATIVE_INFINITY, launchFailure?.at ?? Number.NEGATIVE_INFINITY);
  const resumable = rec.pendingAt.some((at) => at >= holdAt);
  return {
    last,
    nextRun,
    lastStop,
    lastPause,
    closed,
    launchFailure,
    resumable,
    held: lastPause !== undefined && lastPause.run === nextRun && !resumable,
    briefDelivered: rec.runs.some((r) => r.facts.prompted),
    fallback:
      started &&
      providerError(last) !== undefined &&
      lastStop?.run !== last.n &&
      rec.runs.filter((r) => providerError(r) !== undefined).length < rec.candidates.length,
  };
}

export function nextRunOf(rec: TaskRecord): RunNo {
  return fold(rec).nextRun;
}

export function deriveTask(rec: TaskRecord, live: LiveCooks, now: Millis): TaskView {
  const { last, nextRun, lastStop, lastPause, closed, launchFailure, resumable, held, fallback } = fold(rec);
  const modelOf = (state: TaskState): string | undefined => {
    if (state.kind === "closed") return undefined;
    const run = state.kind === "queued" ? undefined : rec.runs.find((r) => r.n === state.run);
    return run ? runModel(rec, run) : profileFor(rec, state.kind === "queued" || state.run === undefined ? nextRun : state.run)?.model;
  };
  const view = (state: TaskState): TaskView => ({ spec: rec.spec, state, model: modelOf(state) });
  if (closed) return view({ kind: "closed", at: millis(closed.at), discarded: closed.discarded });
  const pid = live.get(rec.spec.sessionId);
  if (pid !== undefined && last !== undefined && last.claim.kind !== "none" && !last.facts.settled) {
    return view({ kind: "cooking", run: last.n, since: last.facts.startedAt ?? last.claim.at, activity: last.facts.activity });
  }
  if (launchFailure) {
    if (resumable) return view({ kind: "queued", why: "message" });
    return view({ kind: "idle", run: launchFailure.run, since: launchFailure.at, outcome: { kind: "failed", reason: launchFailure.reason, cause: "launch" } });
  }
  const stopped = (run: RunNo | undefined): TaskView => view({ kind: "idle", run, since: millis(lastPause?.at ?? now), outcome: { kind: "stopped" } });
  if (last && last.claim.kind !== "started") return held ? stopped(rec.runs.at(-2)?.n) : view({ kind: "queued", why: "interrupted-launch" });
  if (resumable) return view({ kind: "queued", why: "message" });
  if (!last) return held ? stopped(undefined) : view({ kind: "queued", why: "new" });
  if (held) return stopped(last.n);
  if (fallback) return view({ kind: "queued", why: "fallback" });
  const since = last.facts.lastAt ?? last.facts.startedAt ?? now;
  return view({ kind: "idle", run: last.n, since, outcome: outcomeOf(last, lastStop?.run === last.n) });
}

export function outcomeOf(run: RunRecord, stopped: boolean): Outcome {
  const { facts } = run;
  if (!facts.settled) {
    if (stopped) return { kind: "stopped" };
    const tail = errTail(run.stderrTail);
    return { kind: "failed", reason: tail ? `cook exited before settling: ${tail}` : "cook exited before settling", cause: "crash" };
  }
  if (facts.verdict?.kind === "report") {
    const { status, summary } = facts.verdict.report;
    if (status === "done") return { kind: "done", summary, reported: true };
    if (status === "needs_decision") return { kind: "needs_decision", question: summary };
    if (status === "blocked") return { kind: "blocked", reason: summary };
    return { kind: "failed", reason: summary, cause: "report" };
  }
  if (facts.verdict?.kind === "provider-error") return { kind: "failed", reason: facts.verdict.message, cause: "provider" };
  if (stopped) return { kind: "stopped" };
  return { kind: "done", summary: facts.finalText ?? "(no final text)", reported: false };
}

export function noticeFor(rec: TaskRecord, view: TaskView): Notice | undefined {
  const { state } = view;
  if (state.kind !== "idle" || state.run === undefined || state.outcome.kind === "stopped") return undefined;
  const run = state.run;
  const notified = rec.events.flatMap((e) => (e.type === "notified" ? [e.run] : []));
  if (notified.includes(run)) return undefined;
  const since = Math.max(0, ...notified);
  const tried = rec.runs.flatMap((r) => {
    const error = r.n > since && r.n < run ? providerError(r) : undefined;
    return error === undefined ? [] : [{ model: runModel(rec, r) ?? DEFAULT_MODEL_TEXT, error }];
  });
  return { task: rec.spec.id, title: rec.spec.title, run, model: view.model, tried, outcome: state.outcome };
}

export type Action =
  | { kind: "launch"; task: TaskId; run: RunNo; prompt: "brief" | "messages" | "existing" | "fallback"; reclaim: boolean; profile: Profile | undefined }
  | { kind: "signal"; task: TaskId; pid: Pid; signal: "SIGTERM" | "SIGKILL" }
  | { kind: "remove-worktree"; task: TaskId; discard: boolean }
  | { kind: "notify"; notice: Notice };

export interface PlanInput {
  records: readonly TaskRecord[];
  live: LiveCooks;
  now: Millis;
  cap: number;
  killGraceMs: number;
  exitGraceMs: number;
  reclaimAfterMs: number;
}

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
    if (pid !== undefined && last?.facts.settled) {
      const settledAt = last.facts.lastAt ?? (last.claim.kind === "none" ? now : last.claim.at);
      if (now - settledAt > exitGraceMs) actions.push({ kind: "signal", task: rec.spec.id, pid, signal: escalate(settledAt + exitGraceMs) });
    }
  }

  queued.sort((a, b) => a.rec.spec.createdAt - b.rec.spec.createdAt);
  for (const { rec } of queued) {
    if (busy >= input.cap) break;
    if (live.has(rec.spec.sessionId)) continue;
    const { last, nextRun, briefDelivered, fallback } = fold(rec);
    const reuse = last !== undefined && last.n === nextRun;
    const emptyClaim = reuse && last.claim.kind === "empty" ? last.claim : undefined;
    if (emptyClaim && now - emptyClaim.at < reclaimAfterMs) continue;
    const prompt = reuse ? "existing" : !briefDelivered ? "brief" : fallback ? "fallback" : "messages";
    actions.push({ kind: "launch", task: rec.spec.id, run: nextRun, prompt, reclaim: emptyClaim !== undefined, profile: profileFor(rec, nextRun) });
    busy += 1;
  }
  return { views, actions };
}

export interface GitFacts {
  dirtyFiles: number;
  ahead: number;
  unlanded: number;
  onBranch: boolean;
}

export type CloseVerdict = { ok: true } | { ok: false; reason: string };

export function closeVerdict(spec: TaskSpec, state: TaskState, git: GitFacts | undefined, discard: boolean): CloseVerdict {
  const task = spec.id;
  if (state.kind === "closed" || discard) return { ok: true };
  if (state.kind === "cooking") return { ok: false, reason: `${task} is still cooking. chef_stop it first, or pass discard: true to drop its work.` };
  if (state.kind === "queued" && state.why === "message") {
    return { ok: false, reason: `${task} has an undelivered message and is about to relaunch. chef_stop it first, or pass discard: true to drop the message and the work.` };
  }
  if (git === undefined) return { ok: true };
  if (!git.onBranch) {
    return { ok: false, reason: `${task}'s worktree HEAD is not on ${spec.branch}: a detached HEAD, another branch, or a rebase in progress. Its commits would be lost with the worktree. Put them on ${spec.branch} first, or pass discard: true if the human said to drop them.` };
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

export interface RestartNote {
  cooking: number;
  finished: number;
}

const SUMMARY_MAX = 400;

const sentence = (text: string): string => {
  const flat = oneLine(text, SUMMARY_MAX);
  return /[.!?…]$/.test(flat) ? flat : `${flat}.`;
};

const ERROR_MAX = 160;
const triedText = (t: Tried): string => `${t.model} (${oneLine(t.error, ERROR_MAX)})`;

export function noticeLine(n: Notice): string {
  const head = `${n.task} "${n.title}"`;
  const model = n.model ?? DEFAULT_MODEL_TEXT;
  const fellBack = n.tried.length ? ` It fell back to ${model} after a provider error on ${n.tried.map(triedText).join(", then on ")}.` : "";
  const o = n.outcome;
  switch (o.kind) {
    case "done":
      return `${head} is done${o.reported ? "" : " (no chef_report, final text follows)"}: ${sentence(o.summary)}${fellBack} Review with chef_result ${n.task}.`;
    case "needs_decision":
      return `${head} needs a decision: ${sentence(o.question)}${fellBack} Answer with chef_send ${n.task}.`;
    case "blocked":
      return `${head} is blocked: ${sentence(o.reason)}${fellBack} Remove the obstacle and chef_send ${n.task}, or chef_stop it.`;
    case "failed":
      if (o.cause === "provider") {
        const all = [...n.tried, { model, error: o.reason }].map(triedText).join("; ");
        return `${head} failed with a provider error on every candidate model: ${all}. chef_send ${n.task} to retry on ${model}, or tell the human.`;
      }
      return `${head} failed: ${sentence(o.reason)}${fellBack} chef_send ${n.task} to retry, or tell the human.`;
  }
}

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
      return { new: "queued", message: "queued with a message", "interrupted-launch": "queued (relaunch)", fallback: "queued (next model)" }[state.why];
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
  return s.kind === "idle" ? outcomeDetail(s.outcome) : "";
}

export function outcomeDetail(o: Outcome): string {
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

export function boardLines(board: Board, now: Millis, width: number): string[] {
  if (board.open.length === 0 && board.broken.length === 0) return [];
  const rows = [
    ...board.open.map((v) => ({ id: `${glyph(v.state)} ${v.spec.id}`, state: stateText(v.state), model: v.model ?? "", detail: detailOf(v), age: ageOf(v, now) })),
    ...board.broken.map((b) => ({ id: `? ${b.id}`, state: "broken", model: "", detail: b.reason, age: "" })),
  ];
  const w0 = Math.max(...rows.map((r) => [...r.id].length));
  const w1 = Math.max(...rows.map((r) => r.state.length));
  const w2 = Math.max(...rows.map((r) => r.model.length));
  const lines = rows.map((r) => {
    const prefix = `${r.id.padEnd(w0)}  ${r.state.padEnd(w1)}  ${w2 ? `${r.model.padEnd(w2)}  ` : ""}`;
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

/** Why a model cannot run a cook, or undefined when it can. */
export type ModelCheck = (model: string) => string | undefined;

export interface Dropped {
  model: string;
  why: string;
}

export type Selection = { kind: "chosen"; models: Profile[]; rule: string | undefined; dropped: Dropped[] } | { kind: "refused"; reason: string };

export function selectModels(config: ModelsConfig, choice: { model?: string; rule?: string }, check: ModelCheck): Selection {
  let first: Profile[] = [];
  let rule: string | undefined;
  if (choice.model !== undefined) {
    first = [{ model: choice.model }];
  } else if (choice.rule !== undefined) {
    const name = choice.rule.trim();
    const found = config.rules.find((r) => r.name === name);
    if (!found) {
      const known = config.rules.map((r) => r.name).join(", ");
      return { kind: "refused", reason: `Unknown model rule "${choice.rule}". ${known ? `Rules: ${known}.` : "config.json has no model rules."} Leave rule out for the default models.` };
    }
    first = found.use;
    rule = found.name;
  }
  const candidates = [...first, ...config.default].filter((p, i, all) => all.findIndex((q) => q.model === p.model) === i);
  const dropped: Dropped[] = [];
  const models = candidates.filter((p) => {
    const why = check(p.model);
    if (why !== undefined) dropped.push({ model: p.model, why });
    return why === undefined;
  });
  if (candidates.length > 0 && models.length === 0) {
    return { kind: "refused", reason: `No candidate model can run: ${droppedText(dropped)}. Fix models in config.json, or pass another model.` };
  }
  return { kind: "chosen", models, rule, dropped };
}

export function droppedText(dropped: readonly Dropped[]): string {
  return dropped.map((d) => `${d.model} (${d.why})`).join(", ");
}

export function profileText(p: Profile): string {
  return p.thinking === undefined ? p.model : `${p.model} (thinking ${p.thinking})`;
}

/** The section of the chef's system prompt that lets the chef model pick a rule per task. None without rules: there is nothing to pick. */
export function modelsPrompt(config: ModelsConfig): string | undefined {
  if (config.rules.length === 0) return undefined;
  const list = (ps: readonly Profile[]): string => (ps.length ? ps.map(profileText).join(", ") : "Pi's default model");
  return [
    "## Cook models",
    "",
    "Each chef_dispatch picks the cook's models. Read the task, choose the rule whose `when` fits it best, and pass its name as `rule`. When no rule fits, leave `rule` out: the task gets the default models. Pass `model` only when the human names a model. When a model fails with a provider error, for example no credits left, the cook continues on the next model of its list by itself.",
    "",
    ...config.rules.map((r) => `- ${r.name}: when ${sentence(r.when)}${r.why ? ` Why: ${sentence(r.why)}` : ""} Models: ${list(r.use)}.`),
    `- Default models: ${list(config.default)}.`,
  ].join("\n");
}

export type PrincipleAsker = { role: "chef" } | { role: "cook"; project: ProjectName };

/** The principle set that a role gets: a set name, `none`, or undefined for no selection. */
export function principleSet(config: PrinciplesConfig, asker: PrincipleAsker): string | undefined {
  return (asker.role === "cook" ? config.projects.get(asker.project) : undefined) ?? config.default;
}

/** One error line per selected set that no installed add-on provides. */
export function missingSets(config: PrinciplesConfig, installed: readonly string[]): string[] {
  const selected = new Set([config.default, ...config.projects.values()]);
  const missing = [...selected].filter((s): s is string => s !== undefined && s !== "none" && !installed.includes(s));
  const have = installed.length ? `Installed sets: ${installed.join(", ")}.` : "No principle set add-on is installed.";
  return missing.map((s) => `config.json selects the principle set "${s}", but no installed add-on provides it. ${have}`);
}

export function principlesText(config: PrinciplesConfig, installed: readonly string[]): string {
  const head =
    config.default !== undefined
      ? `Principle set: ${config.default}.`
      : installed.length
        ? `Principle set: no selection, so every installed set applies (${installed.join(", ")}).`
        : "Principle set: no selection, and no set is installed.";
  const projects = [...config.projects].map(([project, set]) => `${project} ${set}`);
  return projects.length ? `${head} Per project: ${projects.join(", ")}.` : head;
}
