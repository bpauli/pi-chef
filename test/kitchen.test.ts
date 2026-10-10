// Kitchen e2e: real cook Pi processes on the fake model, a temp PI_CODING_AGENT_DIR
// and CHEF_HOME. The test drives ticks itself; the chef shell owns the timer.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { ChefError, type Notice, type Pid, type SessionId, type TaskId, millis, parseProjectName, runNo } from "../extension/domain.ts";
import { alive, scanCooks, signalCook } from "../extension/cooks.ts";
import { Kitchen, KitchenReader, type Opened } from "../extension/kitchen.ts";
import { Store } from "../extension/store.ts";
import { CHEF_ENTRY, COMMIT_STEP, PI_CLI, REPORT_STEP, type TempKitchen, git, makeRepo, startFakeModel, tempKitchen, until } from "./support.ts";

let fake: Awaited<ReturnType<typeof startFakeModel>>;
let tk: TempKitchen;
before(async () => {
  fake = await startFakeModel();
});
after(() => fake.stop());
afterEach(async () => {
  await reapCooks(new Store(tk.kitchenDir));
  tk.dispose();
});

/** Kills every cook of this kitchen that a test left behind. */
async function reapCooks(store: Store): Promise<void> {
  const cooks = await scanCooks();
  for (const id of store.listTaskIds()) {
    const pid = cooks.get(store.readSpec(id).sessionId);
    if (pid) await signalCook(pid, store.readSpec(id).sessionId, "SIGKILL");
  }
}

const self = (sessionId = "chef-test") => ({ pid: process.pid as Pid, sessionId });
const pi = { command: process.execPath, args: [PI_CLI] };

async function openOwner(sessionId = "chef-test", takeover = false): Promise<Kitchen> {
  const opened = await Kitchen.open({ store: new Store(tk.kitchenDir), pi, chefEntry: CHEF_ENTRY, self: self(sessionId), killGraceMs: 2000 }, { takeover });
  assert.equal(opened.kind, "owner");
  return (opened as Extract<Opened, { kind: "owner" }>).kitchen;
}

async function setup(config: Record<string, unknown> = {}): Promise<{ kitchen: Kitchen; store: Store; repos: { api: string; web: string } }> {
  tk = tempKitchen(config);
  const repos = { api: makeRepo(tk.home, "api"), web: makeRepo(tk.home, "web") };
  const kitchen = await openOwner();
  await kitchen.addProject({ path: repos.api, note: "api service" });
  await kitchen.addProject({ path: join(repos.web, "."), name: "web" });
  return { kitchen, store: new Store(tk.kitchenDir), repos };
}

/** Ticks until a notice for `task` arrives, then marks it, so the next tick is quiet. */
async function waitNotice(kitchen: Kitchen, task: string, timeoutMs = 40_000): Promise<Notice> {
  const notice = await until(`notice for ${task}`, async () => {
    const report = await kitchen.tick();
    assert.equal(report.kind, "ok");
    if (report.kind === "ok" && report.errors.length) throw new Error(report.errors.join("; "));
    return report.kind === "ok" ? report.notices.find((n) => n.task === task) : undefined;
  }, timeoutMs);
  kitchen.markNotified([notice]);
  return notice;
}

async function waitState(kitchen: Kitchen, task: string, kind: string, timeoutMs = 30_000) {
  return until(`${task} ${kind}`, async () => {
    const report = await kitchen.tick();
    if (report.kind !== "ok") return undefined;
    const view = report.board.open.find((v) => v.spec.id === task);
    return view?.state.kind === kind ? view : undefined;
  }, timeoutMs);
}

const runFiles = (store: Store, task: string) => readdirSync(join(store.taskDir(task as TaskId), "runs")).sort();

test("dispatch to two projects: each cook commits and reports done, one notice per task, and the result shows one unlanded commit", async () => {
  const { kitchen, store, repos } = await setup();
  const brief = (f: string) => `Intent: add ${f}.\n${COMMIT_STEP(f)}\n${REPORT_STEP("done", `added ${f}`)}`;
  const a = await kitchen.dispatch({ project: "api", title: "Add a", brief: brief("a.txt") });
  const w = await kitchen.dispatch({ project: "web", title: "Add w", brief: brief("w.txt") });
  assert.equal(a.spec.id, "api-1");
  assert.equal(w.spec.id, "web-1");
  assert.equal(a.state.kind, "cooking");
  assert.ok(existsSync(store.runFile(a.spec.id, runNo(1))));

  const na = await waitNotice(kitchen, "api-1");
  const nw = await waitNotice(kitchen, "web-1");
  assert.deepEqual(na.outcome, { kind: "done", summary: "added a.txt", reported: true });
  assert.deepEqual(nw.outcome, { kind: "done", summary: "added w.txt", reported: true });

  const result = await kitchen.result(a.spec.id);
  assert.equal(result.view.state.kind, "idle");
  assert.deepEqual(result.git, { dirtyFiles: 0, ahead: 1, unlanded: 1 });
  assert.match(result.diffstat, /a\.txt/);
  assert.equal(result.transcript, store.runFile(a.spec.id, runNo(1)));
  assert.equal(git(repos.api, "rev-list", "--count", "main..chef/api-1"), "1");

  const quiet = await kitchen.tick();
  assert.equal(quiet.kind, "ok");
  assert.deepEqual(quiet.kind === "ok" && quiet.notices, []);
  assert.deepEqual(runFiles(store, "api-1"), ["1.err", "1.jsonl", "1.prompt.md"]);
  assert.equal(quiet.kind === "ok" && quiet.board.cooks.busy, 0);
});

test("needs_decision wakes with the question; chef_send relaunches run 2 on the same session and the cook commits and reports done", async () => {
  const { kitchen, store } = await setup();
  const brief = [REPORT_STEP("needs_decision", "cookie or bearer token?"), COMMIT_STEP("b.txt"), REPORT_STEP("done", "used cookies")].join("\n");
  const view = await kitchen.dispatch({ project: "api", title: "Fix login", brief });
  const n1 = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(n1.outcome, { kind: "needs_decision", question: "cookie or bearer token?" });
  assert.equal(n1.run, 1);

  const delivery = await kitchen.send(view.spec.id, "use cookies");
  assert.deepEqual(delivery, { kind: "relaunched", run: 2 });
  const n2 = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(n2.outcome, { kind: "done", summary: "used cookies", reported: true });
  assert.equal(n2.run, 2);

  const run2 = readFileSync(store.runFile(view.spec.id, runNo(2)), "utf8");
  const header = JSON.parse(run2.split("\n")[0]!) as { id: string };
  assert.equal(header.id, view.spec.sessionId);
  assert.match(run2, /Messages from the chef/);
  assert.match(run2, /use cookies/);
  assert.equal(readdirSync(join(store.inboxDir(view.spec.id), "handled")).length, 1);
  assert.deepEqual(store.pendingMessages(view.spec.id), []);
  assert.equal((await kitchen.result(view.spec.id)).git?.ahead, 1);
});

test("a message sent while the cook runs is steered into the same run and no second run starts", async () => {
  const { kitchen, store } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Listen", brief: "STEP bash: sleep 4\nSTEP echo-users:" });
  await until("cook is inside bash", async () => {
    const v = await waitState(kitchen, view.spec.id, "cooking", 5000);
    return v.state.kind === "cooking" && v.state.activity.kind === "tool" ? v : undefined;
  });
  const delivery = await kitchen.send(view.spec.id, "hello cook");
  assert.deepEqual(delivery, { kind: "steer" });
  const notice = await waitNotice(kitchen, view.spec.id);
  assert.equal(notice.outcome.kind, "done");
  assert.ok(notice.outcome.kind === "done" && !notice.outcome.reported);
  assert.match(notice.outcome.kind === "done" ? notice.outcome.summary : "", /hello cook/);
  assert.deepEqual(runFiles(store, view.spec.id), ["1.err", "1.jsonl", "1.prompt.md"]);
  assert.equal(readdirSync(join(store.inboxDir(view.spec.id), "handled")).length, 1);
});

test("stop ends a running cook as stopped with no notice, and chef_send resumes it on run 2", async () => {
  const { kitchen, store } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Long", brief: `STEP bash: sleep 60\n${REPORT_STEP("done", "resumed")}` });
  await until("cook is inside bash", async () => {
    const v = await waitState(kitchen, view.spec.id, "cooking", 5000);
    return v.state.kind === "cooking" && v.state.activity.kind === "tool" ? v : undefined;
  });
  const pid = (await scanCooks()).get(view.spec.sessionId);
  assert.ok(pid);
  const stopped = await kitchen.stop(view.spec.id);
  const idle = stopped.state.kind === "idle" ? stopped : await waitState(kitchen, view.spec.id, "idle");
  assert.deepEqual(idle.state.kind === "idle" && idle.state.outcome, { kind: "stopped" });
  await until("cook process exit", () => (alive(pid) ? undefined : true));
  const quiet = await kitchen.tick();
  assert.deepEqual(quiet.kind === "ok" && quiet.notices, []);
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type), ["stop"]);

  assert.deepEqual(await kitchen.send(view.spec.id, "go on"), { kind: "relaunched", run: 2 });
  const notice = await waitNotice(kitchen, view.spec.id);
  assert.deepEqual(notice.outcome, { kind: "done", summary: "resumed", reported: true });
});

test("close refuses unlanded work, then succeeds after a merge and removes the worktree and branch", async () => {
  const { kitchen, store, repos } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Add c", brief: `${COMMIT_STEP("c.txt")}\n${REPORT_STEP("done", "added c")}` });
  await waitNotice(kitchen, view.spec.id);
  await assert.rejects(kitchen.close(view.spec.id, false), (e: unknown) => e instanceof ChefError && /1 commit not on the base branch/.test(e.message));
  assert.ok(existsSync(view.spec.worktree));

  git(repos.api, "merge", "-q", "--ff-only", "chef/api-1");
  const closed = await kitchen.close(view.spec.id, false);
  assert.equal(closed.view.state.kind, "closed");
  assert.equal(closed.branchKept, false);
  assert.equal(existsSync(view.spec.worktree), false);
  assert.equal(git(repos.api, "branch", "--list", "chef/api-1"), "");
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type), ["notified", "closed"]);
  const again = await kitchen.close(view.spec.id, false);
  assert.equal(again.view.state.kind, "closed");
  const board = await kitchen.tick();
  assert.equal(board.kind === "ok" && board.board.open.length, 0);
  assert.equal(board.kind === "ok" && board.board.closedCount, 1);
});

test("close with discard stops a running cook and removes its worktree and branch", async () => {
  const { kitchen, repos } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Drop me", brief: `${COMMIT_STEP("d.txt")}\nSTEP bash: sleep 60` });
  await until("cook has committed", async () => {
    await kitchen.tick();
    return git(repos.api, "branch", "--list", "chef/api-1") && git(repos.api, "rev-list", "--count", "main..chef/api-1") === "1" ? true : undefined;
  });
  await assert.rejects(kitchen.close(view.spec.id, false), /still cooking/);
  const closed = await kitchen.close(view.spec.id, true);
  assert.equal(closed.view.state.kind, "closed");
  await until("worktree removed", async () => {
    await kitchen.tick();
    return existsSync(view.spec.worktree) ? undefined : true;
  });
  assert.equal(git(repos.api, "branch", "--list", "chef/api-1"), "");
});

test("a new Kitchen adopts a live cook without a second launch and wakes once when it finishes", async () => {
  const { kitchen: first, store } = await setup();
  const view = await first.dispatch({ project: "api", title: "Slow", brief: `STEP bash: sleep 5\n${REPORT_STEP("done", "slept")}` });
  await until("cook is inside bash", async () => {
    const v = await waitState(first, view.spec.id, "cooking", 5000);
    return v.state.kind === "cooking" && v.state.activity.kind === "tool" ? v : undefined;
  });
  first.release();
  assert.equal(existsSync(store.lockFile()), false);

  const second = await openOwner("chef-second");
  const report = await second.tick();
  assert.equal(report.kind, "ok");
  const adopted = report.kind === "ok" ? report.board.open[0]! : undefined;
  assert.equal(adopted?.state.kind, "cooking");
  assert.equal(adopted?.state.kind === "cooking" && adopted.state.run, 1);
  assert.deepEqual(runFiles(store, view.spec.id), ["1.err", "1.jsonl", "1.prompt.md"]);

  const notice = await waitNotice(second, view.spec.id);
  assert.deepEqual(notice.outcome, { kind: "done", summary: "slept", reported: true });
  assert.deepEqual(runFiles(store, view.spec.id), ["1.err", "1.jsonl", "1.prompt.md"]);
  assert.deepEqual(store.readEvents(view.spec.id).map((e) => e.type), ["notified"]);
});

test("a cook that finished while no owner ran is reported by the next owner's first tick, and the second tick adds nothing", async () => {
  const { kitchen: first, store } = await setup();
  const view = await first.dispatch({ project: "api", title: "Quick", brief: `${COMMIT_STEP("q.txt")}\n${REPORT_STEP("done", "quick")}` });
  first.release();
  await until("cook settles on its own", () => (readFileSync(store.runFile(view.spec.id, runNo(1)), "utf8").includes('"agent_settled"') ? true : undefined));
  await until("cook process exit", async () => ((await scanCooks()).has(view.spec.sessionId) ? undefined : true));

  const second = await openOwner("chef-second");
  const first_tick = await second.tick();
  assert.equal(first_tick.kind, "ok");
  assert.deepEqual(first_tick.kind === "ok" && first_tick.notices.map((n) => [n.task, n.outcome]), [[view.spec.id, { kind: "done", summary: "quick", reported: true }]]);
  assert.deepEqual(first_tick.kind === "ok" && first_tick.errors, []);
  second.markNotified(first_tick.kind === "ok" ? first_tick.notices : []);
  const second_tick = await second.tick();
  assert.deepEqual(second_tick.kind === "ok" && second_tick.notices, []);
  assert.deepEqual(runFiles(store, view.spec.id), ["1.err", "1.jsonl", "1.prompt.md"]);
  assert.equal(second_tick.kind === "ok" && second_tick.board.cooks.busy, 0);
});

test("maxCooks 1: the second task queues and starts after the first finishes", async () => {
  const { kitchen, store } = await setup({ maxCooks: 1 });
  const t1 = await kitchen.dispatch({ project: "api", title: "First", brief: `STEP bash: sleep 3\n${REPORT_STEP("done", "first")}` });
  const t2 = await kitchen.dispatch({ project: "web", title: "Second", brief: REPORT_STEP("done", "second") });
  assert.equal(t1.state.kind, "cooking");
  assert.deepEqual(t2.state, { kind: "queued", why: "new" });
  assert.equal(existsSync(store.runFile(t2.spec.id, runNo(1))), false);
  const n1 = await waitNotice(kitchen, t1.spec.id);
  assert.equal(n1.outcome.kind, "done");
  const n2 = await waitNotice(kitchen, t2.spec.id);
  assert.deepEqual(n2.outcome, { kind: "done", summary: "second", reported: true });
});

test("a prompt file without a run file is relaunched from that prompt (interrupted launch)", async () => {
  const { kitchen, store } = await setup();
  const id = store.nextTaskId(parseProjectName("api"));
  store.createTask({
    id,
    project: parseProjectName("api"),
    title: "Interrupted",
    brief: "unused",
    branch: `chef/${id}`,
    worktree: store.worktreeDir(id),
    baseBranch: "main",
    sessionId: "0199c0de-1111-7000-8000-000000000001" as SessionId,
    model: undefined,
    createdAt: millis(Date.now()),
  });
  const prompt = `handwritten prompt\n${REPORT_STEP("done", "from the old prompt")}\n`;
  store.writePrompt(id, runNo(1), prompt);
  const notice = await waitNotice(kitchen, id);
  assert.deepEqual(notice.outcome, { kind: "done", summary: "from the old prompt", reported: true });
  assert.equal(store.readPrompt(id, runNo(1)), prompt);
  assert.deepEqual(runFiles(store, id), ["1.err", "1.jsonl", "1.prompt.md"]);
});

test("a cook killed with SIGKILL derives failed with the stderr tail", async () => {
  const { kitchen, store } = await setup();
  const view = await kitchen.dispatch({ project: "api", title: "Doomed", brief: "STEP bash: sleep 60" });
  await until("cook is inside bash", async () => {
    const v = await waitState(kitchen, view.spec.id, "cooking", 5000);
    return v.state.kind === "cooking" && v.state.activity.kind === "tool" ? v : undefined;
  });
  const pid = (await scanCooks()).get(view.spec.sessionId)!;
  writeFileSync(store.runErr(view.spec.id, runNo(1)), "fatal: out of memory\n", { flag: "a" });
  process.kill(-pid, "SIGKILL");
  const notice = await waitNotice(kitchen, view.spec.id);
  assert.equal(notice.outcome.kind, "failed");
  assert.match(notice.outcome.kind === "failed" ? notice.outcome.reason : "", /^cook exited before settling: .*fatal: out of memory$/);
});

test("a second session opens read-only and cannot dispatch; takeover moves the lease and the old owner loses it", async () => {
  const { kitchen } = await setup();
  const other = await Kitchen.open({ store: new Store(tk.kitchenDir), pi, chefEntry: CHEF_ENTRY, self: self("chef-other") });
  assert.equal(other.kind, "read-only");
  if (other.kind !== "read-only") return;
  assert.equal(other.holder.pid, process.pid);
  assert.equal(other.holder.sessionId, "chef-test");
  assert.ok(other.reader instanceof KitchenReader && !(other.reader instanceof Kitchen));
  assert.equal(!("dispatch" in other.reader), true);
  const board = await other.reader.board();
  assert.equal(board.role, "read-only");
  assert.equal(board.projects.length, 2);
  assert.equal((await kitchen.tick()).kind, "ok");

  const taken = await openOwner("chef-other", true);
  assert.equal((await taken.tick()).kind, "ok");
  const lost = await kitchen.tick();
  assert.equal(lost.kind, "lost");
  assert.equal(lost.kind === "lost" && lost.holder?.sessionId, "chef-other");
  await assert.rejects(kitchen.dispatch({ project: "api", title: "x", brief: "y" }), /takeover/);
});

test("a stale lease from a dead pid or a reused pid is replaced", async () => {
  tk = tempKitchen();
  const store = new Store(tk.kitchenDir);
  store.ensureLayout();
  store.writeLease({ pid: 2_000_000, pidStart: "x", sessionId: "dead", since: 1 });
  const first = await Kitchen.open({ store, pi, chefEntry: CHEF_ENTRY, self: self("new") });
  assert.equal(first.kind, "owner");
  store.writeLease({ pid: process.pid, pidStart: "not-our-start", sessionId: "reused", since: 1 });
  const second = await Kitchen.open({ store, pi, chefEntry: CHEF_ENTRY, self: self("newer") });
  assert.equal(second.kind, "owner");
  assert.equal(store.readLease()?.sessionId, "newer");
  mkdirSync(join(tk.home, "unused"));
});
