import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type Activity, type Outcome, type ProjectName, type SessionId, type TaskId, type TaskState, type TaskView, millis, runNo } from "../extension/domain.ts";
import { CookTabs, Herdr, WATCH_SCRIPT, herdrReport, shellQuote } from "../extension/herdr.ts";
import { FAKE_HERDR } from "./support.ts";
const WS = "w9";

let dir: string;
let logPath: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chef-herdr-"));
  logPath = join(dir, "herdr.log");
  statePath = join(dir, "herdr.json");
  process.env.FAKE_HERDR_LOG = logPath;
  process.env.FAKE_HERDR_STATE = statePath;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls = (): string[][] => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
const callsSince = (n: number): string[][] => calls().slice(n);
const verbs = (cs: string[][]): string[] => cs.map((c) => c.slice(0, 2).join(" "));
const reports = (cs: string[][]) => cs.filter((c) => c[1] === "report-agent").map((c) => ({ pane: c[2], state: c[c.indexOf("--state") + 1], message: c[c.indexOf("--message") + 1] }));
const seedTab = (label: string, pane: string) => writeFileSync(statePath, JSON.stringify({ next: 50, tabs: [{ tab_id: `${WS}:t7`, label, pane_id: pane }] }));
const closeAllTabs = () => writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), tabs: [] }));

const taskDir = (id: TaskId) => join("/kitchen/tasks", id);
const tabs = () => new CookTabs(new Herdr(FAKE_HERDR, WS), taskDir);

function view(id: string, state: TaskState): TaskView {
  const spec = {
    id: id as TaskId,
    project: "api" as ProjectName,
    title: "t",
    brief: "b",
    branch: `chef/${id}`,
    worktree: `/kitchen/worktrees/${id} x`,
    baseBranch: "main",
    sessionId: `sid-${id}` as SessionId,
    createdAt: millis(1),
  };
  return { spec, state };
}
const cooking = (run: number, activity: Activity = { kind: "tool", tool: "bash", detail: "npm test" }): TaskState => ({ kind: "cooking", run: runNo(run), since: millis(1), activity });
const idle = (outcome: Outcome): TaskState => ({ kind: "idle", run: runNo(1), since: millis(1), outcome });

test("a task first seen cooking opens one cook tab that runs the viewer in the task worktree, and the next sync opens none", async () => {
  const t = tabs();
  assert.deepEqual(await t.sync([view("api-1", cooking(1))]), []);
  const first = calls();
  assert.deepEqual(verbs(first.slice(0, 2)).sort(), ["pane list", "tab list"]);
  assert.deepEqual(verbs(first.slice(2)), ["tab create", "pane run", "pane report-agent"]);
  const create = first.filter((c) => c[1] === "create");
  assert.equal(create.length, 1);
  assert.deepEqual(create[0], ["tab", "create", "--workspace", WS, "--label", "cook api-1", "--cwd", "/kitchen/worktrees/api-1 x", "--no-focus"]);
  const run = first.filter((c) => c[1] === "run");
  assert.deepEqual(run, [["pane", "run", `${WS}:p1`, `exec node ${shellQuote(WATCH_SCRIPT)} '/kitchen/tasks/api-1'`]]);
  assert.deepEqual(reports(first), [{ pane: `${WS}:p1`, state: "working", message: "bash: npm test" }]);

  assert.deepEqual(await t.sync([view("api-1", cooking(1))]), []);
  assert.deepEqual(callsSince(first.length), [], "an unchanged board calls herdr not at all");

  await t.sync([view("api-1", cooking(1, { kind: "thinking" }))]);
  assert.deepEqual(verbs(callsSince(first.length)), ["pane report-agent"], "a new activity only reports, it never lists or opens");
});

test("the command the tab runs starts the viewer from a shell, even for a path with a quote and a space", async () => {
  const task = join(dir, "it's a task");
  mkdirSync(join(task, "runs"), { recursive: true });
  writeFileSync(join(task, "log.jsonl"), `${JSON.stringify({ type: "closed", at: 1, discarded: false })}\n`);
  await new CookTabs(new Herdr(FAKE_HERDR, WS), () => task).sync([view("api-1", cooking(1))]);
  const command = calls().find((c) => c[1] === "run")![3]!;
  const out = execFileSync("sh", ["-c", command], { encoding: "utf8", timeout: 10_000 });
  assert.match(out, /task closed/);
});

test("an existing cook tab found at activation is adopted and no second tab opens", async () => {
  seedTab("cook api-1", `${WS}:p7`);
  const t = tabs();
  await t.sync([view("api-1", cooking(1))]);
  const cs = calls();
  assert.equal(cs.filter((c) => c[1] === "create").length, 0);
  assert.deepEqual(reports(cs), [{ pane: `${WS}:p7`, state: "working", message: "bash: npm test" }]);
});

test("an idle task's adopted tab gets its outcome once after a chef restart", async () => {
  seedTab("cook api-1", `${WS}:p7`);
  const t = tabs();
  const asks = view("api-1", idle({ kind: "needs_decision", question: "cookie or bearer token?" }));
  await t.sync([asks]);
  await t.sync([asks]);
  assert.deepEqual(reports(calls()), [{ pane: `${WS}:p7`, state: "blocked", message: "needs decision: cookie or bearer token?" }]);
  assert.deepEqual(verbs(calls()).filter((v) => v.endsWith("list")).sort(), ["pane list", "tab list"], "the tabs are listed once, at activation");
});

test("each derived state change reports once with the mapped herdr state", async () => {
  const t = tabs();
  const states: TaskState[] = [
    cooking(1),
    idle({ kind: "needs_decision", question: "cookie or bearer token?" }),
    idle({ kind: "needs_decision", question: "cookie or bearer token?" }),
    idle({ kind: "blocked", reason: "no network" }),
    idle({ kind: "failed", reason: "tests fail" }),
    idle({ kind: "done", summary: "added a.txt", reported: true }),
    idle({ kind: "stopped" }),
    { kind: "queued", why: "message" },
  ];
  for (const s of states) await t.sync([view("api-1", s)]);
  assert.deepEqual(
    reports(calls()).map((r) => [r.state, r.message]),
    [
      ["working", "bash: npm test"],
      ["blocked", "needs decision: cookie or bearer token?"],
      ["blocked", "blocked: no network"],
      ["blocked", "failed: tests fail"],
      ["idle", "done"],
      ["idle", "stopped"],
    ],
  );
});

test("herdrReport has no herdr state for a queued or closed task", () => {
  assert.equal(herdrReport({ kind: "queued", why: "new" }), undefined);
  assert.equal(herdrReport({ kind: "closed", at: millis(1), discarded: false }), undefined);
});

test("a tab the human closed is not reopened for the same run, and the next run opens a new one", async () => {
  const t = tabs();
  await t.sync([view("api-1", cooking(1))]);
  closeAllTabs();
  const before = calls().length;
  assert.deepEqual(await t.sync([view("api-1", cooking(1, { kind: "thinking" }))]), [], "a report to a closed tab is no error");
  await t.sync([view("api-1", cooking(1, { kind: "tool", tool: "read", detail: "a.ts" }))]);
  assert.deepEqual(verbs(callsSince(before)), ["pane report-agent"], "after the pane is gone, the same run calls herdr no more");

  await t.sync([view("api-1", cooking(2))]);
  const created = calls().filter((c) => c[1] === "create");
  assert.equal(created.length, 2, "run 2 opens a new tab");
});

test("a herdr failure becomes an error line for the chef and never throws", async () => {
  const t = new CookTabs(new Herdr(join(dir, "no-such-herdr"), WS), taskDir);
  const errors = await t.sync([view("api-1", cooking(1))]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^herdr: /);
});

test("Herdr.fromEnv needs HERDR_ENV=1 and a workspace", () => {
  assert.equal(Herdr.fromEnv({ HERDR_WORKSPACE_ID: WS, HERDR_BIN_PATH: FAKE_HERDR }), undefined);
  assert.equal(Herdr.fromEnv({ HERDR_ENV: "1" }), undefined);
  const h = Herdr.fromEnv({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: WS });
  assert.equal(h?.bin, "herdr");
  assert.equal(Herdr.fromEnv({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: WS, HERDR_BIN_PATH: FAKE_HERDR })?.bin, FAKE_HERDR);
});
