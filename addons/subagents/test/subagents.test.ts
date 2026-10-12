import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { COOKS_EVENT, COOKS_REQUEST_EVENT, type CookTask, type CooksSnapshot } from "../../../extension/events.ts";
import { fakePi } from "../../../test/fake-pi.ts";
import { installFakeSubagents } from "../../../test/support.ts";
import chefSubagents from "../index.ts";

const SESSION = "/sessions/sid-1.jsonl";

interface FakeApi {
  calls: unknown[][];
  runs: Map<string, Record<string, unknown>>;
  registerExternalRun(run: Record<string, unknown>): unknown;
}

let home: string;
let project: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chef-subagents-"));
  project = join(home, "project");
  mkdirSync(project);
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
});
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(home, { recursive: true, force: true });
});

/** The fake's module is the same instance the add-on imports. */
const installFake = async (npmRoot: string): Promise<FakeApi> => (await import(pathToFileURL(installFakeSubagents(npmRoot)).href)) as FakeApi;

type Shape = Pick<CookTask, "state" | "run" | "since" | "activity" | "outcome" | "transcript">;
function task(id: string, shape: Shape): CookTask {
  const taskDir = `/k/tasks/${id}`;
  return { id, project: "api", title: `Add ${id}`, worktree: `/k/worktrees/${id}`, branch: `chef/${id}`, taskDir, viewer: { command: "node", args: ["/chef/watch.mjs", taskDir] }, ...shape };
}
const snapshot = (role: CooksSnapshot["role"], ...tasks: CookTask[]): CooksSnapshot => ({ version: 1, sessionId: "sid-1", role, tasks });
const cooking = (activity = "bash: npm test"): Shape => ({ state: "cooking", run: 1, since: 1000, activity, transcript: "/k/tasks/api-1/runs/1.jsonl" });
const idle = (kind: NonNullable<Shape["outcome"]>["kind"], text: string): Shape => ({ state: "idle", run: 1, since: 2000, outcome: { kind, text }, transcript: "/k/tasks/api-1/runs/1.jsonl" });

const shown = (api: FakeApi) =>
  [...api.runs.values()].map((r) => {
    const { updatedAt, ...rest } = r;
    assert.equal(typeof updatedAt, "number", "every write sets updatedAt");
    return rest;
  });

async function started() {
  const fake = fakePi(project);
  chefSubagents(fake.pi);
  await fake.lifecycle("session_start");
  return fake;
}

test("a cooking task shows as one running FleetView job of the session file, with its activity and transcript", async () => {
  const api = await installFake(join(home, "agent", "npm"));
  const { publish, emitted } = await started();
  assert.deepEqual(emitted, [{ channel: COOKS_REQUEST_EVENT, data: undefined }], "the add-on asks for the current snapshot at session start");
  await publish(COOKS_EVENT, snapshot("owner", task("api-1", cooking())));
  assert.deepEqual(shown(api), [
    {
      id: "chef-api-1",
      sessionId: SESSION,
      source: "pi-chef",
      label: "api-1 Add api-1",
      state: "running",
      startedAt: 1000,
      currentAction: "bash: npm test",
      transcriptPath: "/k/tasks/api-1/runs/1.jsonl",
    },
  ]);
});

test("each outcome maps to its FleetView state, and an unchanged snapshot writes nothing", async () => {
  const api = await installFake(join(home, "agent", "npm"));
  const { publish } = await started();
  const job = () => shown(api)[0]!;
  await publish(COOKS_EVENT, snapshot("owner", task("api-1", { state: "queued" })));
  assert.deepEqual([job().state, job().currentAction], ["queued", "queued"]);

  await publish(COOKS_EVENT, snapshot("owner", task("api-1", cooking())));
  await publish(COOKS_EVENT, snapshot("owner", task("api-1", idle("needs_decision", "cookie or bearer?"))));
  assert.deepEqual(job(), {
    id: "chef-api-1",
    sessionId: SESSION,
    source: "pi-chef",
    label: "api-1 Add api-1",
    state: "stopped",
    startedAt: 1000,
    endedAt: 2000,
    currentAction: "needs decision: cookie or bearer?",
    preview: "cookie or bearer?",
    transcriptPath: "/k/tasks/api-1/runs/1.jsonl",
  });
  const writes = api.calls.length;
  await publish(COOKS_EVENT, snapshot("owner", task("api-1", idle("needs_decision", "cookie or bearer?"))));
  assert.equal(api.calls.length, writes, "an unchanged task is not written again");

  const outcomes = [
    [idle("blocked", "no network"), "stopped", "blocked: no network"],
    [idle("failed", "tests fail"), "failed", "failed: tests fail"],
    [idle("done", "added a.txt"), "completed", "done: added a.txt"],
    [idle("stopped", ""), "stopped", "stopped"],
  ] as const;
  for (const [shape, state, action] of outcomes) {
    await publish(COOKS_EVENT, snapshot("owner", task("api-1", shape)));
    assert.deepEqual([job().state, job().currentAction], [state, action]);
  }
  assert.equal(job().preview, undefined, "a stopped task has no preview");
  assert.equal(api.calls.filter((c) => c[0] === "register").length, 1, "one task is registered once");
});

test("a task that leaves the snapshot leaves FleetView, and role off removes every job", async () => {
  const api = await installFake(join(home, "agent", "npm"));
  const { publish } = await started();
  await publish(COOKS_EVENT, snapshot("read-only", task("api-1", cooking()), task("api-2", { state: "queued" })));
  assert.deepEqual(shown(api).map((r) => r.id).sort(), ["chef-api-1", "chef-api-2"], "a read-only session shows its cooks too");
  await publish(COOKS_EVENT, snapshot("read-only", task("api-2", { state: "queued" })));
  assert.deepEqual(shown(api).map((r) => r.id), ["chef-api-2"]);
  await publish(COOKS_EVENT, snapshot("off"));
  assert.deepEqual(shown(api), []);
});

test("session shutdown removes every job", async () => {
  const api = await installFake(join(home, "agent", "npm"));
  const { publish, lifecycle } = await started();
  await publish(COOKS_EVENT, snapshot("owner", task("api-1", cooking())));
  await lifecycle("session_shutdown");
  assert.deepEqual(shown(api), []);
});

test("a snapshot that arrives before session start is shown at session start", async () => {
  const api = await installFake(join(home, "agent", "npm"));
  const fake = fakePi(project);
  chefSubagents(fake.pi);
  await fake.publish(COOKS_EVENT, snapshot("owner", task("api-1", cooking())));
  assert.deepEqual(shown(api), []);
  await fake.lifecycle("session_start");
  assert.deepEqual(shown(api).map((r) => r.id), ["chef-api-1"]);
});

test("a job left by an earlier copy of the add-on is updated, not an error", async () => {
  const api = await installFake(join(home, "agent", "npm"));
  const stale = { id: "chef-api-1", sessionId: SESSION, source: "pi-chef", label: "old", state: "running", startedAt: 1 };
  api.registerExternalRun(stale);
  const { publish, notices } = await started();
  await publish(COOKS_EVENT, snapshot("owner", task("api-1", idle("done", "added a.txt"))));
  assert.deepEqual(notices, []);
  assert.deepEqual([shown(api)[0]!.label, shown(api)[0]!.state], ["api-1 Add api-1", "completed"]);
});

test("a project-local pi-subagents under .pi/npm is used", async () => {
  const api = await installFake(join(project, ".pi", "npm"));
  const { publish } = await started();
  await publish(COOKS_EVENT, snapshot("owner", task("api-1", cooking())));
  assert.deepEqual(shown(api).map((r) => r.id), ["chef-api-1"]);
});

test("without pi-subagents the add-on shows nothing and says so once", async () => {
  const absent = await started();
  await absent.publish(COOKS_EVENT, snapshot("owner", task("api-1", cooking())));
  await absent.publish(COOKS_EVENT, snapshot("owner", task("api-1", cooking("thinking"))));
  assert.deepEqual(absent.notices, [{ text: "pi-chef-subagents: pi-subagents is not installed, so FleetView shows no cooks.", level: "info" }]);

  const api = await installFake(join(home, "agent", "npm"));
  const present = await started();
  await present.publish(COOKS_EVENT, snapshot("owner", task("api-1", cooking())));
  assert.deepEqual(present.notices, [], "the same setup with the package installed shows the job and says nothing");
  assert.deepEqual(shown(api).map((r) => r.id), ["chef-api-1"]);
});
