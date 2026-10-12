import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { COOKS_EVENT, COOKS_REQUEST_EVENT, type CookTask, type CooksSnapshot, WATCH_SCRIPT } from "../../../extension/events.ts";
import { fakePi } from "../../../test/fake-pi.ts";
import { until } from "../../../test/support.ts";
import { CookTabs, Herdr, herdrReport } from "../herdr.ts";
import chefHerdr from "../index.ts";

const FAKE_HERDR = join(import.meta.dirname, "fake-herdr.mjs");
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

const tabs = () => new CookTabs(new Herdr(FAKE_HERDR, WS));

type Shape = Pick<CookTask, "state" | "run" | "since" | "activity" | "outcome">;
function task(id: string, shape: Shape, taskDir = join("/kitchen/tasks", id)): CookTask {
  return { id, project: "api", title: "t", worktree: `/kitchen/worktrees/${id} x`, branch: `chef/${id}`, taskDir, viewer: { command: "node", args: [WATCH_SCRIPT, taskDir] }, ...shape };
}
const owner = (...tasks: CookTask[]): CooksSnapshot => ({ version: 1, sessionId: "s1", role: "owner", tasks });
const cooking = (run: number, activity = "bash: npm test"): Shape => ({ state: "cooking", run, since: 1, activity });
const idle = (kind: NonNullable<Shape["outcome"]>["kind"], text = ""): Shape => ({ state: "idle", run: 1, since: 1, outcome: { kind, text } });

test("a task first seen cooking opens one cook tab that runs the task's viewer in its worktree, and the next snapshot opens none", async () => {
  const t = tabs();
  assert.deepEqual(await t.apply(owner(task("api-1", cooking(1)))), []);
  const first = calls();
  assert.deepEqual(verbs(first.slice(0, 2)).sort(), ["pane list", "tab list"]);
  assert.deepEqual(verbs(first.slice(2)), ["tab create", "pane run", "pane report-agent"]);
  assert.deepEqual(
    first.filter((c) => c[1] === "create"),
    [["tab", "create", "--workspace", WS, "--label", "cook api-1", "--cwd", "/kitchen/worktrees/api-1 x", "--no-focus"]],
  );
  assert.deepEqual(
    first.filter((c) => c[1] === "run"),
    [["pane", "run", `${WS}:p1`, `exec 'node' '${WATCH_SCRIPT}' '/kitchen/tasks/api-1'`]],
  );
  assert.deepEqual(reports(first), [{ pane: `${WS}:p1`, state: "working", message: "bash: npm test" }]);

  assert.deepEqual(await t.apply(owner(task("api-1", cooking(1)))), []);
  assert.deepEqual(callsSince(first.length), [], "an unchanged task calls herdr not at all");

  await t.apply(owner(task("api-1", cooking(1, "thinking"))));
  assert.deepEqual(verbs(callsSince(first.length)), ["pane report-agent"], "a new activity only reports, it never lists or opens");
});

test("the command the tab runs starts the viewer from a shell, even for a path with a quote and a space", async () => {
  const taskDir = join(dir, "it's a task");
  mkdirSync(join(taskDir, "runs"), { recursive: true });
  writeFileSync(join(taskDir, "log.jsonl"), `${JSON.stringify({ type: "closed", at: 1, discarded: false })}\n`);
  await tabs().apply(owner(task("api-1", cooking(1), taskDir)));
  const command = calls().find((c) => c[1] === "run")![3]!;
  const out = execFileSync("sh", ["-c", command], { encoding: "utf8", timeout: 10_000 });
  assert.match(out, /task closed/);
});

test("an existing cook tab is adopted and no second tab opens", async () => {
  seedTab("cook api-1", `${WS}:p7`);
  await tabs().apply(owner(task("api-1", cooking(1))));
  const cs = calls();
  assert.equal(cs.filter((c) => c[1] === "create").length, 0);
  assert.deepEqual(reports(cs), [{ pane: `${WS}:p7`, state: "working", message: "bash: npm test" }]);
});

test("an idle task's adopted tab gets its outcome once after a chef restart", async () => {
  seedTab("cook api-1", `${WS}:p7`);
  const t = tabs();
  const asks = owner(task("api-1", idle("needs_decision", "cookie or bearer token?")));
  await t.apply(asks);
  await t.apply(asks);
  assert.deepEqual(reports(calls()), [{ pane: `${WS}:p7`, state: "blocked", message: "needs decision: cookie or bearer token?" }]);
  assert.deepEqual(verbs(calls()).filter((v) => v.endsWith("list")).sort(), ["pane list", "tab list"], "the tabs are listed once, at the first snapshot");
});

test("each task state change reports once with the mapped herdr state", async () => {
  const t = tabs();
  const shapes: Shape[] = [
    cooking(1),
    idle("needs_decision", "cookie or bearer token?"),
    idle("needs_decision", "cookie or bearer token?"),
    idle("blocked", "no network"),
    idle("failed", "tests fail"),
    idle("done", "added a.txt"),
    idle("stopped"),
    { state: "queued" },
  ];
  for (const s of shapes) await t.apply(owner(task("api-1", s)));
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

test("herdrReport has no herdr state for a queued task and maps a cooking one to working", () => {
  assert.equal(herdrReport(task("api-1", { state: "queued" })), undefined);
  assert.deepEqual(herdrReport(task("api-1", cooking(1, "read: a.ts"))), { state: "working", message: "read: a.ts" });
});

test("a tab the human closed is not reopened for the same run, and the next run opens a new one", async () => {
  const t = tabs();
  await t.apply(owner(task("api-1", cooking(1))));
  closeAllTabs();
  const before = calls().length;
  assert.deepEqual(await t.apply(owner(task("api-1", cooking(1, "thinking")))), [], "a report to a closed tab is no error");
  await t.apply(owner(task("api-1", cooking(1, "read: a.ts"))));
  assert.deepEqual(verbs(callsSince(before)), ["pane report-agent"], "after the pane is gone, the same run calls herdr no more");

  await t.apply(owner(task("api-1", cooking(2))));
  assert.equal(calls().filter((c) => c[1] === "create").length, 2, "run 2 opens a new tab");
});

test("a read-only or off snapshot calls herdr not at all, and the next owner snapshot adopts the live tabs again", async () => {
  const t = tabs();
  await t.apply(owner(task("api-1", cooking(1))));
  const before = calls().length;
  assert.deepEqual(await t.apply({ ...owner(task("api-1", cooking(1, "thinking"))), role: "read-only" }), []);
  assert.deepEqual(await t.apply({ ...owner(), role: "off" }), []);
  assert.deepEqual(callsSince(before), [], "only the owner writes to the tabs");

  await t.apply(owner(task("api-1", cooking(1, "thinking"))));
  const after = callsSince(before);
  assert.deepEqual(verbs(after).filter((v) => v.endsWith("list")).sort(), ["pane list", "tab list"]);
  assert.equal(after.filter((c) => c[1] === "create").length, 0, "the tab of the run is adopted, not opened twice");
  assert.deepEqual(reports(after), [{ pane: `${WS}:p1`, state: "working", message: "thinking" }]);
});

test("a herdr failure becomes an error line and never throws", async () => {
  const t = new CookTabs(new Herdr(join(dir, "no-such-herdr"), WS));
  const errors = await t.apply(owner(task("api-1", cooking(1))));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^herdr: /);
});

test("Herdr.fromEnv needs HERDR_ENV=1 and a workspace", () => {
  assert.equal(Herdr.fromEnv({ HERDR_WORKSPACE_ID: WS, HERDR_BIN_PATH: FAKE_HERDR }), undefined);
  assert.equal(Herdr.fromEnv({ HERDR_ENV: "1" }), undefined);
  assert.equal(Herdr.fromEnv({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: WS })?.bin, "herdr");
  assert.equal(Herdr.fromEnv({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: WS, HERDR_BIN_PATH: FAKE_HERDR })?.bin, FAKE_HERDR);
});

function withHerdrEnv(env: Record<string, string>, body: () => Promise<void>): Promise<void> {
  Object.assign(process.env, env);
  return body().finally(() => {
    for (const key of Object.keys(env)) delete process.env[key];
  });
}

test("the add-on asks for the current snapshot at session start, opens tabs from snapshot events, and skips a snapshot of another version", () =>
  withHerdrEnv({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: WS, HERDR_BIN_PATH: FAKE_HERDR }, async () => {
    const { pi, lifecycle, emitted, notices } = fakePi();
    chefHerdr(pi);
    await lifecycle("session_start");
    assert.deepEqual(emitted, [{ channel: COOKS_REQUEST_EVENT, data: undefined }]);

    pi.events.emit(COOKS_EVENT, { ...owner(task("api-9", cooking(1))), version: 2 });
    pi.events.emit(COOKS_EVENT, owner(task("api-1", cooking(1))));
    await until("the report", () => (reports(calls()).length ? true : undefined), 10_000, 20);
    const labels = calls().filter((c) => c[1] === "create").map((c) => c[c.indexOf("--label") + 1]);
    assert.deepEqual(labels, ["cook api-1"], "the version 2 snapshot is skipped");
    assert.deepEqual(notices, []);
  }));

test("a herdr error from a snapshot is shown once while it lasts", () =>
  withHerdrEnv({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: WS, HERDR_BIN_PATH: join(tmpdir(), "no-such-herdr") }, async () => {
    const { pi, lifecycle, notices } = fakePi();
    chefHerdr(pi);
    await lifecycle("session_start");
    pi.events.emit(COOKS_EVENT, owner(task("api-1", cooking(1))));
    await until("the first error", () => (notices.length ? true : undefined), 10_000, 20);
    pi.events.emit(COOKS_EVENT, owner(task("api-1", cooking(1, "thinking"))));
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(notices.length, 1, "the same error is not shown twice");
    assert.match(notices[0]!.text, /^pi-chef-herdr: herdr: /);
    assert.equal(notices[0]!.level, "error");
  }));

test("outside herdr the add-on does not listen and asks for nothing", () =>
  withHerdrEnv({ HERDR_WORKSPACE_ID: WS, HERDR_BIN_PATH: FAKE_HERDR }, async () => {
    const { pi, lifecycle, emitted } = fakePi();
    chefHerdr(pi);
    await lifecycle("session_start");
    pi.events.emit(COOKS_EVENT, owner(task("api-1", cooking(1))));
    await new Promise((ok) => setTimeout(ok, 300));
    assert.deepEqual(calls(), []);
    assert.deepEqual(emitted.map((e) => e.channel), [COOKS_EVENT], "no request at session start");
  }));
