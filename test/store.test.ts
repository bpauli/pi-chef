import assert from "node:assert/strict";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChefError, type TaskId, type TaskSpec, millis, parseProjectName, runNo } from "../extension/domain.ts";
import { EMPTY_RUN, deriveTask } from "../extension/derive.ts";
import { RunTail, RunTails, Store } from "../extension/store.ts";

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "chef-store-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const id = "api-1" as TaskId;
const spec = (store: Store, over: Partial<TaskSpec> = {}): TaskSpec => ({
  id,
  project: parseProjectName("api"),
  title: "t",
  brief: "b",
  branch: "chef/api-1",
  worktree: store.worktreeDir(id),
  baseBranch: "main",
  sessionId: "sid" as TaskSpec["sessionId"],
  model: undefined,
  createdAt: millis(1),
  ...over,
});

const line = (type: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ type, ...extra })}\n`;

test("RunTail reads only appended bytes and keeps a partial last line for the next poll", () => {
  withDir((dir) => {
    const path = join(dir, "1.jsonl");
    writeFileSync(path, line("session", { timestamp: "2026-01-01T00:00:00.000Z" }) + line("turn_start") + '{"type":"agent_sett');
    const tail = new RunTail(path);
    assert.deepEqual(tail.poll(), { ...EMPTY_RUN, activity: { kind: "thinking" } }, "the torn last line is not folded yet");
    appendFileSync(path, 'led"}\n' + line("tool_execution_start", { toolName: "bash", args: { command: "ls" } }));
    const facts = tail.poll();
    assert.equal(facts.settled, true);
    assert.deepEqual(facts.activity, { kind: "tool", tool: "bash", detail: "ls" });
  });
});

test("RunTail splits on LF only: a U+2028 inside a JSON string does not end a line", () => {
  withDir((dir) => {
    const path = join(dir, "1.jsonl");
    const text = `before after`;
    writeFileSync(path, line("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } }));
    assert.equal(new RunTail(path).poll().finalText, text);
  });
});

test("RunTail decodes a multi-byte character split across two appends", () => {
  withDir((dir) => {
    const path = join(dir, "1.jsonl");
    const full = Buffer.from(line("message_end", { message: { role: "assistant", content: [{ type: "text", text: "café \u{1F35F}" }] } }));
    const cut = full.indexOf(Buffer.from("\u{1F35F}")) + 2;
    writeFileSync(path, full.subarray(0, cut));
    const tail = new RunTail(path);
    assert.equal(tail.poll().finalText, undefined);
    appendFileSync(path, full.subarray(cut));
    assert.equal(tail.poll().finalText, "café \u{1F35F}");
  });
});

test("RunTail starts over when the file shrinks (an empty claim was reclaimed)", () => {
  withDir((dir) => {
    const path = join(dir, "1.jsonl");
    writeFileSync(path, line("turn_start") + line("agent_settled"));
    const tail = new RunTail(path);
    assert.equal(tail.poll().settled, true);
    writeFileSync(path, line("turn_start"));
    assert.equal(tail.poll().settled, false, "a shorter file is a new run file: the old facts are dropped");
  });
});

test("claimRun returns undefined when runs/<n>.jsonl already exists, and releaseEmptyClaim frees only an empty one", () => {
  withDir((dir) => {
    const store = new Store(dir);
    store.createTask(spec(store));
    const first = store.claimRun(id, runNo(1));
    assert.ok(first);
    assert.equal(store.claimRun(id, runNo(1)), undefined);
    assert.equal(store.releaseEmptyClaim(id, runNo(1)), true);
    assert.ok(store.claimRun(id, runNo(1)));
    appendFileSync(store.runFile(id, runNo(1)), "x");
    assert.equal(store.releaseEmptyClaim(id, runNo(1)), false);
    assert.equal(store.releaseEmptyClaim(id, runNo(9)), true);
  });
});

test("nextTaskId derives max sequence + 1 from the task directories and survives a gap", () => {
  withDir((dir) => {
    const store = new Store(dir);
    const api = parseProjectName("api");
    assert.equal(store.nextTaskId(api), "api-1");
    store.createTask(spec(store, { id: "api-1" as TaskId }));
    store.createTask(spec(store, { id: "api-7" as TaskId }));
    store.createTask(spec(store, { id: "web-3" as TaskId }));
    assert.equal(store.nextTaskId(api), "api-8");
    assert.equal(store.nextTaskId(parseProjectName("web")), "web-4");
    assert.equal(store.createTask(spec(store, { id: "api-7" as TaskId })), false);
  });
});

test("postMessage leaves no partial .msg behind and pendingMessages returns them in posting order with their time", () => {
  withDir((dir) => {
    const store = new Store(dir);
    store.createTask(spec(store));
    store.postMessage(id, "second", millis(1700000000002));
    store.postMessage(id, "first", millis(1700000000001));
    const files = readdirSync(store.inboxDir(id));
    assert.deepEqual(files.filter((f) => !f.endsWith(".msg")), ["handled"]);
    const pending = store.pendingMessages(id);
    assert.deepEqual(pending.map((m) => m.text), ["first", "second"]);
    assert.deepEqual(pending.map((m) => m.at), [1700000000001, 1700000000002]);
  });
});

test("moveToHandled tolerates a message the cook already moved", () => {
  withDir((dir) => {
    const store = new Store(dir);
    store.createTask(spec(store));
    const m = store.postMessage(id, "hi", millis(1700000000001));
    store.moveToHandled(id, [m.file, "1700000000009-abcd.msg"]);
    assert.deepEqual(store.pendingMessages(id), []);
    assert.ok(existsSync(join(store.inboxDir(id), "handled", m.file)));
  });
});

test("loadConfig: a missing file gives defaults, a wrong type gives defaults plus an error that names the field", () => {
  withDir((dir) => {
    const store = new Store(dir);
    assert.deepEqual(store.readConfig(), { maxCooks: 3, model: undefined, thinking: undefined, cookArgs: [] });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ maxCooks: "three" }));
    const bad = store.loadConfig();
    assert.deepEqual(bad.config, { maxCooks: 3, model: undefined, thinking: undefined, cookArgs: [] });
    assert.match(bad.error ?? "", /config\.json is invalid at \/maxCooks/);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ maxCooks: 1, cookArgs: ["-e", "x.ts"] }));
    assert.deepEqual(store.readConfig(), { maxCooks: 1, model: undefined, thinking: undefined, cookArgs: ["-e", "x.ts"] });
  });
});

test("addProject is idempotent for the same path and refuses the same name for another path", () => {
  withDir((dir) => {
    const store = new Store(dir);
    const p = { name: parseProjectName("api"), path: "/r/api", baseBranch: "main", addedAt: millis(1) };
    assert.deepEqual(store.addProject(p), p);
    assert.deepEqual(store.addProject({ ...p, addedAt: millis(2) }), p);
    assert.throws(() => store.addProject({ ...p, path: "/other" }), ChefError);
    assert.deepEqual(store.readProjects(), [p]);
  });
});

test("loadRecord folds the run files, counts pending messages, and skips a torn last log line", () => {
  withDir((dir) => {
    const store = new Store(dir);
    store.createTask(spec(store));
    store.appendEvent(id, { type: "notified", at: 5, run: 1 });
    appendFileSync(join(store.taskDir(id), "log.jsonl"), '{"type":"sto');
    store.writePrompt(id, runNo(1), "p1");
    const fds = store.claimRun(id, runNo(1))!;
    appendFileSync(store.runFile(id, runNo(1)), line("session", { timestamp: "2026-01-01T00:00:00.000Z" }) + line("agent_settled"));
    writeFileSync(store.runErr(id, runNo(1)), "warn\n");
    store.writePrompt(id, runNo(2), "p2");
    store.postMessage(id, "m", millis(1700000000001));
    mkdirSync(store.worktreeDir(id), { recursive: true });
    const tails = new RunTails();
    const rec = store.loadRecord(id, tails);
    assert.deepEqual(rec.events, [{ type: "notified", at: 5, run: 1 }]);
    assert.equal(rec.runs.length, 2);
    assert.equal(rec.runs[0]!.claimed, true);
    assert.equal(rec.runs[0]!.facts.settled, true);
    assert.equal(rec.runs[0]!.stderrTail, "");
    assert.equal(rec.runs[1]!.claimed, false);
    assert.deepEqual(rec.pendingAt, [1700000000001]);
    assert.equal(rec.worktreeExists, true);
    assert.equal(store.loadRecord(id, tails).runs[0]!.facts.settled, true);
    void fds;
  });
});

test("an old kitchen's stop for a run that was never claimed loads as a hold, and a stop for a claimed run stays a stop", () => {
  withDir((dir) => {
    const store = new Store(dir);
    store.createTask(spec(store));
    store.writePrompt(id, runNo(1), "p1");
    const fds = store.claimRun(id, runNo(1))!;
    closeSync(fds.stdout);
    closeSync(fds.stderr);
    appendFileSync(store.runFile(id, runNo(1)), line("message_end", { message: { role: "user", timestamp: 1 } }));
    appendFileSync(join(store.taskDir(id), "log.jsonl"), '{"type":"stop","at":5,"run":1}\n{"type":"stop","at":9,"run":2}\n');
    const rec = store.loadRecord(id, new RunTails());
    assert.deepEqual(rec.events, [
      { type: "stop", at: 5, run: 1 },
      { type: "hold", at: 9, run: 2 },
    ]);
    assert.deepEqual(deriveTask(rec, new Map(), millis(20)).state, { kind: "idle", run: 1, since: 9, outcome: { kind: "stopped" } });
  });
});

test("loadRecord reads the stderr tail for every claimed run that did not settle, including an empty claim", () => {
  withDir((dir) => {
    const store = new Store(dir);
    store.createTask(spec(store));
    store.writePrompt(id, runNo(1), "p1");
    store.claimRun(id, runNo(1));
    writeFileSync(store.runErr(id, runNo(1)), "Error: boom\n");
    assert.equal(store.loadRecord(id, new RunTails()).runs[0]!.stderrTail, "Error: boom\n");
    appendFileSync(store.runFile(id, runNo(1)), line("turn_start"));
    assert.equal(store.loadRecord(id, new RunTails()).runs[0]!.stderrTail, "Error: boom\n");
    appendFileSync(store.runFile(id, runNo(1)), line("agent_settled"));
    assert.equal(store.loadRecord(id, new RunTails()).runs[0]!.stderrTail, "");
  });
});

test("a relaunch of the same run appends to the err file instead of erasing the earlier attempt's diagnostic", () => {
  withDir((dir) => {
    const store = new Store(dir);
    store.createTask(spec(store));
    store.writePrompt(id, runNo(1), "p1");
    const first = store.claimRun(id, runNo(1))!;
    writeFileSync(store.runErr(id, runNo(1)), "attempt 1 died\n");
    assert.equal(store.releaseEmptyClaim(id, runNo(1)), true);
    const second = store.claimRun(id, runNo(1))!;
    assert.equal(readFileSync(store.runErr(id, runNo(1)), "utf8"), "attempt 1 died\n");
    assert.equal(store.runBytes(id, runNo(1)), 0);
    for (const fd of [first.stdout, first.stderr, second.stdout, second.stderr]) closeSync(fd);
  });
});

test("lease round-trips through tmp plus rename and an unreadable lease reads as none", () => {
  withDir((dir) => {
    const store = new Store(dir);
    assert.equal(store.readLease(), undefined);
    const lease = { pid: 1, pidStart: "x", sessionId: "s", since: 2 };
    store.writeLease(lease);
    assert.deepEqual(store.readLease(), lease);
    writeFileSync(store.lockFile(), "{garbage");
    assert.equal(store.readLease(), undefined);
    store.removeLease();
    store.removeLease();
    assert.equal(existsSync(store.lockFile()), false);
  });
});
