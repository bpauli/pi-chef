import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChefError,
  type Pid,
  type TaskEvent,
  type TaskId,
  type TaskSpec,
  millis,
  parseProjectName,
  parseTaskId,
  runNo,
} from "../extension/domain.ts";
import {
  EMPTY_RUN,
  type RunFacts,
  type RunRecord,
  type TaskRecord,
  activityDetail,
  boardLines,
  closeVerdict,
  deriveTask,
  foldRunLine,
  formatWake,
  noticeFor,
  outcomeOf,
  plan,
  statusText,
} from "../extension/derive.ts";

const fixture = (name: string): string[] => readFileSync(join(import.meta.dirname, "fixtures", `${name}.jsonl`), "utf8").split("\n");
const foldAll = (lines: string[]): RunFacts => lines.reduce(foldRunLine, EMPTY_RUN);
const NOW = millis(1_000_000);
const id = (s: string) => s as TaskId;

function spec(over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: id("api-1"),
    project: parseProjectName("api"),
    title: "Add rate limiting",
    brief: "do it",
    branch: "chef/api-1",
    worktree: "/k/worktrees/api-1",
    baseBranch: "main",
    sessionId: "sid-1" as TaskSpec["sessionId"],
    model: undefined,
    createdAt: millis(1000),
    ...over,
  };
}

function run(n: number, facts: Partial<RunFacts>, over: Partial<RunRecord> = {}): RunRecord {
  return { n: runNo(n), claimed: true, bytes: 100, claimedAt: millis(900), facts: { ...EMPTY_RUN, prompted: true, ...facts }, stderrTail: "", ...over };
}

function record(over: Partial<TaskRecord> = {}): TaskRecord {
  return { spec: spec(), events: [], runs: [], pendingAt: [], worktreeExists: true, ...over };
}

const settledDone = (summary = "ok"): RunFacts => ({ ...EMPTY_RUN, settled: true, prompted: true, startedAt: millis(500), report: { status: "done", summary } });
const live = (sid = "sid-1", pid = 4242): Map<string, Pid> => new Map([[sid, pid as Pid]]);
const none = new Map<string, Pid>();

// ---- ids ----

test("parseTaskId accepts case and spaces, resolves a unique bare sequence, and lists known ids on a miss", () => {
  const known = [id("api-7"), id("web-2")];
  assert.equal(parseTaskId(" API-7 ", known), "api-7");
  assert.equal(parseTaskId("2", known), "web-2");
  assert.throws(() => parseTaskId("9", known), (e: unknown) => e instanceof ChefError && e.message.includes("api-7, web-2"));
});

test("parseTaskId refuses a bare sequence that two projects share", () => {
  assert.throws(() => parseTaskId("1", [id("api-1"), id("web-1")]), ChefError);
});

test("parseProjectName lowercases and refuses names outside the slug rule", () => {
  assert.equal(parseProjectName(" Api "), "api");
  assert.throws(() => parseProjectName("my repo"), ChefError);
  assert.throws(() => parseProjectName("-x"), ChefError);
});

// ---- foldRunLine over recorded Pi streams ----

test("a recorded run that ends with chef_report done yields the report, the start time, and settled", () => {
  const lines = fixture("done");
  const facts = foldAll(lines);
  assert.deepEqual(facts.report, { status: "done", summary: "echoed hello" });
  assert.equal(facts.settled, true);
  const header = JSON.parse(lines[0]!) as { timestamp: string };
  assert.equal(facts.startedAt, Date.parse(header.timestamp));
  assert.equal(facts.turns, 2);
});

test("a recorded needs_decision report is read from the tool_execution_end structuredContent", () => {
  const facts = foldAll(fixture("needs-decision"));
  assert.deepEqual(facts.report, { status: "needs_decision", summary: "cookie or bearer token?" });
  assert.equal(facts.settled, true);
});

test("a recorded run without chef_report keeps the final assistant text and no report", () => {
  const facts = foldAll(fixture("no-report"));
  assert.equal(facts.report, undefined);
  assert.equal(facts.finalText, "finished without a report");
  assert.equal(facts.providerError, undefined);
  assert.equal(facts.settled, true);
});

test("a recorded provider failure after retries yields providerError and settled", () => {
  const facts = foldAll(fixture("provider-error"));
  assert.equal(facts.providerError, "Connection error.");
  assert.equal(facts.settled, true);
  assert.equal(facts.report, undefined);
});

test("a chef_report with isError true or a wrong status is not a report", () => {
  const bad = JSON.stringify({ type: "tool_execution_end", toolName: "chef_report", isError: true, result: { structuredContent: { status: "done", summary: "x" } } });
  const wrong = JSON.stringify({ type: "tool_execution_end", toolName: "chef_report", isError: false, result: { structuredContent: { status: "maybe", summary: "x" } } });
  assert.equal(foldRunLine(EMPTY_RUN, bad).report, undefined);
  assert.equal(foldRunLine(EMPTY_RUN, wrong).report, undefined);
});

test("message_update lines, non-JSON lines, and torn lines leave the facts unchanged", () => {
  const done = fixture("done");
  const facts = foldAll(done);
  assert.deepEqual(foldRunLine(facts, '{"type":"message_update","usage":{}}'), facts);
  assert.deepEqual(foldRunLine(facts, "not json"), facts);
  assert.deepEqual(foldRunLine(facts, done[5]!.slice(0, 40)), facts);
});

test("tool_execution_start sets the activity to the tool and its argument, capped at 60 chars", () => {
  const long = "x".repeat(100);
  const facts = foldRunLine(EMPTY_RUN, JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: long } }));
  assert.equal(facts.activity.kind, "tool");
  assert.equal(facts.activity.kind === "tool" && facts.activity.detail.length, 60);
  assert.equal(activityDetail("bash", { command: "npm  test" }), "npm test");
  assert.equal(activityDetail("read", { path: "README.md" }), "README.md");
});

// ---- outcomeOf and deriveTask: one row per edge ----

test("a live process on an unsettled run is cooking, even while the run file is still empty", () => {
  const rec = record({ runs: [run(1, {}, { bytes: 0 })] });
  const view = deriveTask(rec, live(), NOW);
  assert.equal(view.state.kind, "cooking");
  assert.equal(view.state.kind === "cooking" && view.state.run, 1);
});

test("settled beats liveness: a settled run whose process is still exiting is idle", () => {
  const rec = record({ runs: [run(1, settledDone())] });
  assert.equal(deriveTask(rec, live(), NOW).state.kind, "idle");
});

test("a dead process without agent_settled is failed and carries the stderr tail", () => {
  const rec = record({ runs: [run(1, { startedAt: millis(1) }, { stderrTail: "line1\nError: boom\n" })] });
  const state = deriveTask(rec, none, NOW).state;
  assert.equal(state.kind, "idle");
  assert.deepEqual(state.kind === "idle" && state.outcome, { kind: "failed", reason: "cook exited before settling: line1 Error: boom" });
});

test("a dead process without agent_settled after a stop event is stopped, not failed", () => {
  const events: TaskEvent[] = [{ type: "stop", at: 900, run: 1 }];
  const rec = record({ events, runs: [run(1, { startedAt: millis(1) })] });
  const state = deriveTask(rec, none, NOW).state;
  assert.deepEqual(state.kind === "idle" && state.outcome, { kind: "stopped" });
});

test("needs_decision, blocked, and failed reports map to their outcomes with the summary text", () => {
  const of = (status: "needs_decision" | "blocked" | "failed") => outcomeOf(run(1, { settled: true, report: { status, summary: "why" } }), false);
  assert.deepEqual(of("needs_decision"), { kind: "needs_decision", question: "why" });
  assert.deepEqual(of("blocked"), { kind: "blocked", reason: "why" });
  assert.deepEqual(of("failed"), { kind: "failed", reason: "why" });
});

test("a clean settle without chef_report is done with reported false and the final text", () => {
  assert.deepEqual(outcomeOf(run(1, { settled: true, finalText: "all good" }), false), { kind: "done", summary: "all good", reported: false });
  assert.deepEqual(outcomeOf(run(1, { settled: true, providerError: "Connection error." }), false), { kind: "failed", reason: "Connection error." });
});

test("a prompt file without a run file is queued as an interrupted launch", () => {
  const rec = record({ runs: [run(1, {}, { claimed: false, bytes: 0 })] });
  assert.deepEqual(deriveTask(rec, none, NOW).state, { kind: "queued", why: "interrupted-launch" });
});

test("an empty run file with no live process and an empty err file is an interrupted launch, not a failure", () => {
  const rec = record({ runs: [run(1, {}, { bytes: 0 })] });
  assert.deepEqual(deriveTask(rec, none, NOW).state, { kind: "queued", why: "interrupted-launch" });
});

test("an empty run file with no live process and a non-empty err file is a failed launch that used its run number up", () => {
  const rec = record({ runs: [run(1, { prompted: false }, { bytes: 0, claimedAt: millis(7000), stderrTail: 'Error: Model "nope/none" not found.\n' })] });
  assert.deepEqual(deriveTask(rec, none, NOW).state, {
    kind: "idle",
    run: 1,
    since: 7000,
    outcome: { kind: "failed", reason: 'cook exited before its first output line: Error: Model "nope/none" not found.' },
  });
  assert.equal(noticeFor(rec, deriveTask(rec, none, NOW))?.run, 1);
  const retried = record({ ...rec, pendingAt: [millis(8000)] });
  assert.deepEqual(deriveTask(retried, none, NOW).state, { kind: "queued", why: "message" });
  assert.deepEqual(plan({ ...base, records: [retried] }).actions, [{ kind: "launch", task: "api-1", run: 2, prompt: "brief", reclaim: false }]);
  const alive = deriveTask(rec, live(), NOW).state;
  assert.equal(alive.kind, "cooking", "a live cook that has not written yet is cooking, whatever the err file says");
});

test("a launch_failed event for the next run derives idle(failed), and a message newer than it relaunches with the brief", () => {
  const events: TaskEvent[] = [{ type: "launch_failed", at: 6000, run: 1, reason: "git worktree add failed: base branch nope not found" }];
  const failed = record({ events });
  assert.deepEqual(deriveTask(failed, none, NOW).state, {
    kind: "idle",
    run: 1,
    since: 6000,
    outcome: { kind: "failed", reason: "git worktree add failed: base branch nope not found" },
  });
  assert.deepEqual(plan({ ...base, records: [failed] }).actions.map((a) => a.kind), ["notify"]);
  const older = record({ events, pendingAt: [millis(5000)] });
  assert.equal(deriveTask(older, none, NOW).state.kind, "idle", "a message older than the failure does not retry it");
  const retried = record({ events, pendingAt: [millis(6500)] });
  assert.deepEqual(plan({ ...base, records: [retried] }).actions, [{ kind: "launch", task: "api-1", run: 2, prompt: "brief", reclaim: false }]);
  const afterRun = record({ events: [{ type: "launch_failed", at: 6000, run: 2, reason: "spawn of pi failed: ENOENT" }], runs: [run(1, settledDone())] });
  assert.deepEqual(deriveTask(afterRun, none, NOW).state.kind, "idle");
  assert.deepEqual(plan({ ...base, records: [{ ...afterRun, pendingAt: [millis(6500)] }] }).actions, [{ kind: "launch", task: "api-1", run: 3, prompt: "messages", reclaim: false }]);
});

test("a launch_failed event for a run that started after all is ignored", () => {
  const events: TaskEvent[] = [{ type: "launch_failed", at: 400, run: 1, reason: "cook exited with code 1 before its first output line" }];
  const rec = record({ events, runs: [run(1, settledDone("fine"))] });
  const state = deriveTask(rec, none, NOW).state;
  assert.deepEqual(state.kind === "idle" && state.outcome, { kind: "done", summary: "fine", reported: true });
  assert.deepEqual(plan({ ...base, records: [{ ...rec, pendingAt: [millis(9000)] }] }).actions, [{ kind: "launch", task: "api-1", run: 2, prompt: "messages", reclaim: false }]);
});

test("a pending message turns an idle task into queued(message)", () => {
  const rec = record({ runs: [run(1, settledDone())], pendingAt: [millis(2000)] });
  assert.deepEqual(deriveTask(rec, none, NOW).state, { kind: "queued", why: "message" });
});

test("a task with no runs and a stop event is idle(stopped), and a newer message resumes it", () => {
  const events: TaskEvent[] = [{ type: "stop", at: 5000, run: 1 }];
  const held = deriveTask(record({ events, pendingAt: [millis(4000)] }), none, NOW).state;
  assert.deepEqual(held, { kind: "idle", run: undefined, since: 5000, outcome: { kind: "stopped" } });
  const resumed = deriveTask(record({ events, pendingAt: [millis(4000), millis(6000)] }), none, NOW).state;
  assert.deepEqual(resumed, { kind: "queued", why: "message" });
});

test("a stop that names the next run holds an idle task that has pending messages", () => {
  const events: TaskEvent[] = [{ type: "stop", at: 5000, run: 2 }];
  const rec = record({ events, runs: [run(1, settledDone())], pendingAt: [millis(4000)] });
  const state = deriveTask(rec, none, NOW).state;
  assert.equal(state.kind, "idle");
  assert.deepEqual(state.kind === "idle" && state.outcome, { kind: "stopped" });
});

test("a closed event wins over every other fact", () => {
  const events: TaskEvent[] = [{ type: "closed", at: 7, discarded: true }];
  const rec = record({ events, runs: [run(1, {})], pendingAt: [millis(9)] });
  assert.deepEqual(deriveTask(rec, live(), NOW).state, { kind: "closed", at: 7, discarded: true });
});

test("a task with no runs and no events is queued(new)", () => {
  assert.deepEqual(deriveTask(record(), none, NOW).state, { kind: "queued", why: "new" });
});

// ---- noticeFor ----

test("no notice for stopped outcomes, notified runs, or a task with a pending relaunch", () => {
  const due = record({ runs: [run(1, settledDone("x"))] });
  assert.equal(noticeFor(due, deriveTask(due, none, NOW))?.run, 1);
  const notified = record({ runs: [run(1, settledDone())], events: [{ type: "notified", at: 1, run: 1 }] });
  assert.equal(noticeFor(notified, deriveTask(notified, none, NOW)), undefined);
  const stopped = record({ runs: [run(1, {})], events: [{ type: "stop", at: 1, run: 1 }] });
  assert.equal(noticeFor(stopped, deriveTask(stopped, none, NOW)), undefined);
  const relaunch = record({ runs: [run(1, settledDone())], pendingAt: [millis(5)] });
  assert.equal(noticeFor(relaunch, deriveTask(relaunch, none, NOW)), undefined);
});

// ---- plan ----

const base = { live: none, now: NOW, cap: 3, killGraceMs: 5000, exitGraceMs: 10_000, reclaimAfterMs: 30_000 };

test("plan launches the oldest queued tasks first and never more than cap minus busy", () => {
  const cooking = record({ spec: spec({ id: id("api-1"), sessionId: "s1" as TaskSpec["sessionId"], createdAt: millis(1) }), runs: [run(1, {})] });
  const q2 = record({ spec: spec({ id: id("api-2"), sessionId: "s2" as TaskSpec["sessionId"], createdAt: millis(3) }) });
  const q3 = record({ spec: spec({ id: id("api-3"), sessionId: "s3" as TaskSpec["sessionId"], createdAt: millis(2) }) });
  const { actions } = plan({ ...base, records: [cooking, q2, q3], live: live("s1"), cap: 2 });
  const launches = actions.filter((a) => a.kind === "launch");
  assert.deepEqual(launches, [{ kind: "launch", task: "api-3", run: 1, prompt: "brief", reclaim: false }]);
});

test("plan never launches a task whose session still has a live process", () => {
  const rec = record({ runs: [run(1, { ...settledDone(), lastAt: millis(NOW - 1000) })], pendingAt: [millis(5)] });
  const { actions } = plan({ ...base, records: [rec], live: live() });
  assert.deepEqual(actions, []);
});

test("plan relaunches an interrupted launch with the existing prompt, and reclaims an empty run file", () => {
  const promptOnly = record({ runs: [run(1, {}, { claimed: false, bytes: 0 })] });
  const emptyClaim = record({ spec: spec({ id: id("api-2"), sessionId: "s2" as TaskSpec["sessionId"] }), runs: [run(1, {}, { bytes: 0 })] });
  const { actions } = plan({ ...base, records: [promptOnly, emptyClaim] });
  assert.deepEqual(actions, [
    { kind: "launch", task: "api-1", run: 1, prompt: "existing", reclaim: false },
    { kind: "launch", task: "api-2", run: 1, prompt: "existing", reclaim: true },
  ]);
});

test("plan relaunches an idle task with a message on the next run number", () => {
  const rec = record({ runs: [run(1, settledDone())], pendingAt: [millis(5)] });
  const { actions } = plan({ ...base, records: [rec] });
  assert.deepEqual(actions, [{ kind: "launch", task: "api-1", run: 2, prompt: "messages", reclaim: false }]);
});

test("a live process of a stopped run gets SIGTERM, then SIGKILL after the grace period", () => {
  const events: TaskEvent[] = [{ type: "stop", at: NOW - 1000, run: 1 }];
  const rec = record({ events, runs: [run(1, {})] });
  const soon = plan({ ...base, records: [rec], live: live() }).actions;
  assert.deepEqual(soon, [{ kind: "signal", task: "api-1", pid: 4242, signal: "SIGTERM" }]);
  const late = plan({ ...base, records: [rec], live: live(), now: millis(NOW + 6000) }).actions;
  assert.deepEqual(late, [{ kind: "signal", task: "api-1", pid: 4242, signal: "SIGKILL" }]);
});

test("a cook still alive after its run settled gets SIGTERM after the exit grace period and SIGKILL after the kill grace period", () => {
  const rec = record({ runs: [run(1, { ...settledDone(), lastAt: millis(NOW - 11_000) })] });
  const kinds = (now: number) => plan({ ...base, records: [rec], live: live(), now: millis(now) }).actions.map((a) => (a.kind === "signal" ? a.signal : a.kind));
  assert.deepEqual(kinds(NOW - 5000), ["notify"], "6 s after settling the cook may still be shutting down");
  assert.deepEqual(kinds(NOW), ["notify", "SIGTERM"]);
  assert.deepEqual(kinds(NOW + 5000), ["notify", "SIGKILL"]);
  assert.deepEqual(plan({ ...base, records: [rec], now: millis(NOW) }).actions.map((a) => a.kind), ["notify"], "no process, nothing to signal");
});

test("an empty claim younger than the reclaim threshold is left alone, an older one is reclaimed", () => {
  const young = record({ runs: [run(1, { prompted: false }, { bytes: 0, claimedAt: millis(NOW - 5000) })] });
  assert.deepEqual(deriveTask(young, none, NOW).state, { kind: "queued", why: "interrupted-launch" });
  assert.deepEqual(plan({ ...base, records: [young] }).actions, []);
  const old = record({ runs: [run(1, { prompted: false }, { bytes: 0, claimedAt: millis(NOW - 31_000) })] });
  assert.deepEqual(plan({ ...base, records: [old] }).actions, [{ kind: "launch", task: "api-1", run: 1, prompt: "existing", reclaim: true }]);
});

test("a closed task with a worktree yields remove-worktree, and its live cook is signalled", () => {
  const events: TaskEvent[] = [{ type: "closed", at: NOW, discarded: true }];
  const rec = record({ events, runs: [run(1, {})], worktreeExists: true });
  const { actions } = plan({ ...base, records: [rec], live: live() });
  assert.deepEqual(actions, [
    { kind: "remove-worktree", task: "api-1", discard: true },
    { kind: "signal", task: "api-1", pid: 4242, signal: "SIGTERM" },
  ]);
  const gone = plan({ ...base, records: [{ ...rec, worktreeExists: false }] }).actions;
  assert.deepEqual(gone, []);
});

test("plan on the state its own launches produce yields no new launch (idempotent)", () => {
  const first = plan({ ...base, records: [record()] });
  assert.equal(first.actions.filter((a) => a.kind === "launch").length, 1);
  const after = record({ runs: [run(1, {}, { bytes: 0 })] });
  const second = plan({ ...base, records: [after], live: live() });
  assert.deepEqual(second.actions, []);
});

test("plan emits one notify per idle task with an unnotified final outcome", () => {
  const rec = record({ runs: [run(1, settledDone("added f"))] });
  const { actions } = plan({ ...base, records: [rec] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.kind, "notify");
  assert.deepEqual(actions[0]!.kind === "notify" && actions[0]!.notice.outcome, { kind: "done", summary: "added f", reported: true });
});

// ---- closeVerdict ----

test("close refuses dirty or unlanded work unless discard, and names the counts", () => {
  const idle = deriveTask(record({ runs: [run(1, settledDone())] }), none, NOW).state;
  const refused = closeVerdict(id("api-1"), idle, { dirtyFiles: 2, ahead: 3, unlanded: 3, onBranch: true }, false);
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.reason, "api-1 has 3 commits not on the base branch or any remote branch and 2 changed files in the worktree. Merge or push the work, or pass discard: true if the human said to drop it.");
  assert.deepEqual(closeVerdict(id("api-1"), idle, { dirtyFiles: 2, ahead: 3, unlanded: 3, onBranch: true }, true), { ok: true });
  assert.deepEqual(closeVerdict(id("api-1"), idle, { dirtyFiles: 0, ahead: 3, unlanded: 0, onBranch: true }, false), { ok: true });
  assert.match((closeVerdict(id("api-1"), idle, { dirtyFiles: 0, ahead: 0, unlanded: 0, onBranch: false }, false) as { reason: string }).reason, /HEAD is not on chef\/api-1/);
  assert.deepEqual(closeVerdict(id("api-1"), idle, undefined, false), { ok: true });
});

test("close of a cooking task or a task with an undelivered message is refused without discard, and close of a closed task is ok", () => {
  const cooking = deriveTask(record({ runs: [run(1, {})] }), live(), NOW).state;
  assert.equal(closeVerdict(id("api-1"), cooking, undefined, false).ok, false);
  assert.equal(closeVerdict(id("api-1"), cooking, undefined, true).ok, true);
  const relaunching = deriveTask(record({ runs: [run(1, settledDone())], pendingAt: [millis(2000)] }), none, NOW).state;
  assert.deepEqual(relaunching, { kind: "queued", why: "message" });
  assert.match((closeVerdict(id("api-1"), relaunching, undefined, false) as { reason: string }).reason, /undelivered message/);
  assert.equal(closeVerdict(id("api-1"), relaunching, undefined, true).ok, true);
  assert.deepEqual(closeVerdict(id("api-1"), { kind: "closed", at: NOW, discarded: false }, undefined, false), { ok: true });
});

// ---- text ----

test("formatWake renders the kitchen update the chef model reads, with the next tool per outcome", () => {
  const text = formatWake([
    { task: id("api-7"), title: "Add rate limiter", run: runNo(2), outcome: { kind: "done", summary: "token bucket in limit.go, make test passes.", reported: true } },
    { task: id("web-2"), title: "Fix login", run: runNo(1), outcome: { kind: "needs_decision", question: "cookie or bearer token?" } },
    { task: id("web-3"), title: "Fix search", run: runNo(1), outcome: { kind: "failed", reason: "Connection error." } },
  ]);
  assert.equal(
    text,
    [
      "Kitchen update (3):",
      '- api-7 "Add rate limiter" is done: token bucket in limit.go, make test passes. Review with chef_result api-7.',
      '- web-2 "Fix login" needs a decision: cookie or bearer token? Answer with chef_send web-2.',
      '- web-3 "Fix search" failed: Connection error. chef_send web-3 to retry, or tell the human.',
    ].join("\n"),
  );
});

test("the first wake after a restart starts with the restart line", () => {
  const text = formatWake([{ task: id("api-1"), title: "t", run: runNo(1), outcome: { kind: "blocked", reason: "no access" } }], { cooking: 1, finished: 2 });
  assert.match(text, /^Chef restarted: 1 cook still cooking, 2 runs finished while you were away\.\nKitchen update \(1\):\n- api-1 "t" is blocked: no access/);
});

test("boardLines fits every line to the width, counts who needs you, and is empty for an empty board", () => {
  const cooking = deriveTask(record({ runs: [run(1, { startedAt: millis(NOW - 240_000), activity: { kind: "tool", tool: "bash", detail: "npm test" } })] }), live(), NOW);
  const asks = deriveTask(record({ spec: spec({ id: id("web-2") }), runs: [run(1, { settled: true, lastAt: millis(NOW - 60_000), report: { status: "needs_decision", summary: "cookie or bearer token?" } })] }), none, NOW);
  const board = { role: "owner" as const, holder: undefined, projects: [], open: [cooking, asks], broken: [], closedCount: 0, cooks: { busy: 1, cap: 3 } };
  const lines = boardLines(board, NOW, 60);
  assert.equal(lines[0], "chef  1/3 cooks  1 needs you");
  assert.equal(lines[1], "● api-1  cooking         bash: npm test  4m");
  assert.equal(lines[2], "! web-2  needs decision  cookie or bearer token?  1m");
  const narrow = boardLines(board, NOW, 36);
  assert.ok(narrow.every((l) => [...l].length <= 36), narrow.join("\n"));
  assert.equal(narrow[1], "● api-1  cooking         bash: …  4m");
  assert.deepEqual(boardLines({ ...board, open: [] }, NOW, 60), []);
  const withBroken = boardLines({ ...board, open: [], broken: [{ id: id("api-9"), reason: "task.json is not valid JSON." }] }, NOW, 60);
  assert.deepEqual(withBroken, ["chef  1/3 cooks", "? api-9  broken  task.json is not valid JSON."]);
  assert.equal(statusText(board), "chef 1 cooking, 1 needs you");
  assert.equal(statusText({ ...board, open: [] }), undefined);
});

test("a read-only board names the owner pid in its header", () => {
  const view = deriveTask(record(), none, NOW);
  const board = { role: "read-only" as const, holder: { pid: 77 as Pid, sessionId: "s", since: millis(0) }, projects: [], open: [view], broken: [], closedCount: 0, cooks: { busy: 0, cap: 3 } };
  assert.equal(boardLines(board, NOW, 80)[0], "chef (read-only, pid 77 owns the kitchen)");
});
