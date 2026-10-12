import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type Board, type ProjectName, type SessionId, type TaskId, type TaskState, type TaskView, millis, runNo } from "../extension/domain.ts";
import { cooksSnapshot, offSnapshot } from "../extension/events.ts";
import { Store } from "../extension/store.ts";
import { ROOT } from "./support.ts";

const WATCH = join(ROOT, "extension/watch.ts");
const store = new Store("/k");

function view(id: string, state: TaskState): TaskView {
  const spec = {
    id: id as TaskId,
    project: "api" as ProjectName,
    title: `title of ${id}`,
    brief: "b",
    branch: `chef/${id}`,
    worktree: `/k/worktrees/${id}`,
    baseBranch: "main",
    sessionId: `sid-${id}` as SessionId,
    createdAt: millis(1),
  };
  return { spec, state };
}

const board = (role: Board["role"], open: TaskView[]): Board => ({ role, holder: undefined, projects: [], open, broken: [], closedCount: 0, cooks: { busy: 0, cap: 3 } });
const common = (id: string) => ({
  id,
  project: "api",
  title: `title of ${id}`,
  worktree: `/k/worktrees/${id}`,
  branch: `chef/${id}`,
  taskDir: `/k/tasks/${id}`,
  viewer: { command: "node", args: [WATCH, `/k/tasks/${id}`] },
});

test("a cooking task carries its run, start, one-line activity, transcript, and viewer", () => {
  const snap = cooksSnapshot("s1", board("owner", [view("api-1", { kind: "cooking", run: runNo(2), since: millis(500), activity: { kind: "tool", tool: "bash", detail: "npm test" } })]), store);
  assert.deepEqual(snap, {
    version: 1,
    sessionId: "s1",
    role: "owner",
    tasks: [{ ...common("api-1"), state: "cooking", run: 2, transcript: "/k/tasks/api-1/runs/2.jsonl", since: 500, activity: "bash: npm test" }],
  });
});

test("an idle task carries its outcome kind and text for every outcome", () => {
  const outcomes = [
    [{ kind: "done", summary: "added a.txt", reported: true }, "added a.txt"],
    [{ kind: "needs_decision", question: "cookie or bearer?" }, "cookie or bearer?"],
    [{ kind: "blocked", reason: "no network" }, "no network"],
    [{ kind: "failed", reason: "tests fail" }, "tests fail"],
    [{ kind: "stopped" }, ""],
  ] as const;
  for (const [outcome, text] of outcomes) {
    const [task] = cooksSnapshot("s1", board("owner", [view("api-1", { kind: "idle", run: runNo(1), since: millis(900), outcome })]), store).tasks;
    assert.deepEqual(task, { ...common("api-1"), state: "idle", run: 1, transcript: "/k/tasks/api-1/runs/1.jsonl", since: 900, outcome: { kind: outcome.kind, text } });
  }
});

test("a task held before its first run is idle with no run and no transcript", () => {
  const [task] = cooksSnapshot("s1", board("owner", [view("api-1", { kind: "idle", run: undefined, since: millis(900), outcome: { kind: "stopped" } })]), store).tasks;
  assert.deepEqual(task, { ...common("api-1"), state: "idle", since: 900, outcome: { kind: "stopped", text: "" } });
});

test("a queued task has no run, activity, or outcome, and a closed task is not in the snapshot", () => {
  const snap = cooksSnapshot(
    "s1",
    board("read-only", [view("api-1", { kind: "queued", why: "new" }), view("api-2", { kind: "closed", at: millis(1), discarded: false })]),
    store,
  );
  assert.deepEqual(snap, { version: 1, sessionId: "s1", role: "read-only", tasks: [{ ...common("api-1"), state: "queued" }] });
});

test("the off snapshot has no tasks", () => {
  assert.deepEqual(offSnapshot("s1"), { version: 1, sessionId: "s1", role: "off", tasks: [] });
});
