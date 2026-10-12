import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCook } from "../extension/cook.ts";
import { ROLE_ENV, TASK_DIR_ENV } from "../extension/cooks.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const sent: { text: string; deliverAs: string | undefined }[] = [];
  const pi = {
    registerTool: () => undefined,
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    events: { on: () => () => undefined },
    sendUserMessage: (text: string, options?: { deliverAs?: string }) => {
      sent.push({ text, deliverAs: options?.deliverAs });
    },
  };
  const emit = (event: string) => {
    for (const h of handlers.get(event) ?? []) h({ type: event }, {});
  };
  return { pi: pi as unknown as ExtensionAPI, emit, sent };
}

const settle = () => new Promise((ok) => setTimeout(ok, 450));

function taskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chef-cook-"));
  mkdirSync(join(dir, "inbox", "handled"), { recursive: true });
  const spec = { id: "api-1", project: "api", title: "t", brief: "b", branch: "chef/api-1", worktree: dir, baseBranch: "main", sessionId: "sid", createdAt: 1 };
  writeFileSync(join(dir, "task.json"), JSON.stringify(spec));
  return dir;
}

test("the cook claims inbox messages only while a turn is active: not before the first turn, not after agent_before_settle, not after SIGTERM", async () => {
  const dir = taskDir();
  const { pi, emit, sent } = fakePi();
  const env: NodeJS.ProcessEnv = { [TASK_DIR_ENV]: dir, [ROLE_ENV]: "cook" };
  installCook(pi, env);
  assert.deepEqual([env[ROLE_ENV], env[TASK_DIR_ENV]], [undefined, undefined], "a nested pi must not load as a cook of this task");
  const post = (name: string) => writeFileSync(join(dir, "inbox", `${name}.msg`), name);
  const pending = () => readdirSync(join(dir, "inbox")).filter((f) => f.endsWith(".msg")).sort();
  try {
    emit("session_start");
    post("1-before-first-turn");
    await settle();
    assert.deepEqual(pending(), ["1-before-first-turn.msg"], "no turn yet: a steer now would race the print-mode prompt");
    assert.deepEqual(sent, []);

    emit("turn_start");
    await settle();
    assert.deepEqual(pending(), []);
    assert.deepEqual(sent, [{ text: "Message from the chef:\n1-before-first-turn", deliverAs: "steer" }]);

    emit("agent_before_settle");
    post("2-after-settle");
    await settle();
    assert.deepEqual(pending(), ["2-after-settle.msg"], "the run is ending: the owner relaunches with it");

    emit("turn_start");
    await settle();
    assert.deepEqual(pending(), [], "a settle that continued into a new turn claims again");
    assert.equal(sent.length, 2);

    process.emit("SIGTERM");
    post("3-after-sigterm");
    await settle();
    assert.deepEqual(pending(), ["3-after-sigterm.msg"], "a stopped cook leaves the message for the relaunch");
    assert.equal(sent.length, 2);
    assert.equal(existsSync(join(dir, "inbox", "handled", "1-before-first-turn.msg")), true);
  } finally {
    emit("session_shutdown");
    rmSync(dir, { recursive: true, force: true });
  }
});
