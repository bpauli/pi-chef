import assert from "node:assert/strict";
import { test } from "node:test";
import { resultText } from "../extension/chef.ts";
import type { TaskResult } from "../extension/kitchen.ts";
import { type TaskSpec, millis, parseProjectName, runNo } from "../extension/domain.ts";

const spec: TaskSpec = {
  id: "api-1" as TaskSpec["id"],
  project: parseProjectName("api"),
  title: "Add limiter",
  brief: "b",
  branch: "chef/api-1",
  worktree: "/k/worktrees/api-1",
  baseBranch: "main",
  sessionId: "sid" as TaskSpec["sessionId"],
  model: undefined,
  createdAt: millis(1),
};

test("resultText cuts a long summary and a long diffstat, and keeps the branch line and the transcript path", () => {
  const diffstat = Array.from({ length: 40 }, (_, i) => ` ${"deep/".repeat(20)}file-${i}.ts | 12 ++++++------`).join("\n");
  const result: TaskResult = {
    view: { spec, state: { kind: "idle", run: runNo(1), since: millis(0), outcome: { kind: "done", summary: "x".repeat(10_000), reported: true } } },
    project: { name: parseProjectName("api"), path: "/r", baseBranch: "main", note: undefined, addedAt: millis(1) },
    git: { dirtyFiles: 0, ahead: 1, unlanded: 1, onBranch: true },
    diffstat,
    finalText: undefined,
    transcript: "/k/tasks/api-1/runs/1.jsonl",
  };
  const text = resultText(result, millis(60_000));
  assert.ok(text.length <= 4000, `${text.length} chars`);
  assert.match(text, /^api-1 "Add limiter": idle 1m, done, run 1\.\nSummary: x+ \[cut\]\n/);
  assert.match(text, /\nBranch chef\/api-1 in \/k\/worktrees\/api-1: 1 commit ahead of main, 1 not landed, clean\.\n/);
  assert.match(text, /file-0\.ts/);
  assert.match(text, /\nTranscript: \/k\/tasks\/api-1\/runs\/1\.jsonl$/);
});
