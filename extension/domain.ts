// Domain vocabulary. Persisted shapes are typebox schemas with their types from
// Static, so a file shape has one source. Derived shapes are plain unions.

import { type Static, Type } from "typebox";

// pstack's pattern (pi/agent-tools.ts:25): a string enum that every provider accepts.
export const stringEnum = <const T extends readonly string[]>(values: T, description?: string) =>
  Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `[a-z0-9][a-z0-9-]{0,31}`. Parsed once by parseProjectName. */
export type ProjectName = Brand<string, "ProjectName">;
/** `<project>-<seq>`, for example `api-7`. */
export type TaskId = Brand<string, "TaskId">;
/** 1-based. Run n is the n-th cook process lifetime of a task. */
export type RunNo = Brand<number, "RunNo">;
/** The Pi session uuid every run of a task shares (`--session-id`). */
export type SessionId = Brand<string, "SessionId">;
export type Pid = Brand<number, "Pid">;
/** Epoch milliseconds. */
export type Millis = Brand<number, "Millis">;

export const runNo = (n: number): RunNo => n as RunNo;
export const millis = (n: number): Millis => n as Millis;

/** A failure the chef model can act on. Its message is the tool error text. */
export class ChefError extends Error {}

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseProjectName(raw: string): ProjectName {
  const name = raw.trim().toLowerCase();
  if (!PROJECT_NAME.test(name)) {
    throw new ChefError(`Project name "${raw}" must match ${PROJECT_NAME}: lowercase letters, digits, and dashes, 1 to 32 characters.`);
  }
  return name as ProjectName;
}

/** A model goes after `--model` in the cook's argv, so it must not look like a flag. */
export function parseModel(raw: string): string {
  const model = raw.trim();
  if (!model || model.startsWith("-")) throw new ChefError(`"${raw}" is not a model. Pass provider/model, for example anthropic/claude-sonnet-5-5.`);
  return model;
}

/** Derives a project name from a directory name. An explicit name goes through parseProjectName unchanged. */
export function slugProjectName(raw: string): ProjectName {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  if (!slug) {
    throw new ChefError(`Cannot derive a project name from "${raw}". Pass an explicit name: lowercase letters, digits, and dashes, 1 to 32 characters.`);
  }
  return parseProjectName(slug);
}

export const TASK_ID = /^([a-z0-9][a-z0-9-]*)-(\d+)$/;

/** Accepts `api-7`, ` API-7 `, and a bare `7` when exactly one known task has that sequence. */
export function parseTaskId(raw: string, known: readonly TaskId[]): TaskId {
  const text = raw.trim().toLowerCase();
  if (known.includes(text as TaskId)) return text as TaskId;
  if (/^\d+$/.test(text)) {
    const matches = known.filter((id) => id.endsWith(`-${text}`));
    if (matches.length === 1) return matches[0] as TaskId;
  }
  const list = known.length ? known.join(", ") : "none";
  throw new ChefError(`Unknown task "${raw}". Known tasks: ${list}.`);
}

// ---------- Persisted: written by the owner ----------

/** kitchen/projects/<name>.json. Written once by chef_add_project. */
export const ProjectSchema = Type.Object(
  {
    name: Type.String(),
    path: Type.String({ description: "absolute repo root" }),
    baseBranch: Type.String({ description: "branch tasks fork from and land into" }),
    note: Type.Optional(Type.String()),
    addedAt: Type.Number(),
  },
  { additionalProperties: false },
);
export type ProjectFile = Static<typeof ProjectSchema>;
export type Project = Omit<ProjectFile, "name" | "addedAt"> & { name: ProjectName; addedAt: Millis };

/** kitchen/tasks/<id>/task.json. Written once at dispatch, never rewritten. */
export const TaskSpecSchema = Type.Object(
  {
    id: Type.String(),
    project: Type.String(),
    title: Type.String(),
    brief: Type.String(),
    branch: Type.String({ description: "chef/<id>" }),
    worktree: Type.String({ description: "kitchen/worktrees/<id>" }),
    baseBranch: Type.String(),
    sessionId: Type.String(),
    model: Type.Optional(Type.String()),
    createdAt: Type.Number(),
  },
  { additionalProperties: false },
);
export type TaskSpecFile = Static<typeof TaskSpecSchema>;
export type TaskSpec = Omit<TaskSpecFile, "id" | "project" | "sessionId" | "createdAt"> & {
  id: TaskId;
  project: ProjectName;
  sessionId: SessionId;
  createdAt: Millis;
};

/**
 * kitchen/tasks/<id>/log.jsonl. The owner's decisions only. Launches, messages,
 * and cook facts have files of their own, so the log never restates them.
 */
export const TaskEventSchema = Type.Union([
  // The owner stopped run `run`, or held the task before run `run` started.
  Type.Object({ type: Type.Literal("stop"), at: Type.Number(), run: Type.Number() }, { additionalProperties: false }),
  // The chef session was told the outcome of run `run`. At least once.
  Type.Object({ type: Type.Literal("notified"), at: Type.Number(), run: Type.Number() }, { additionalProperties: false }),
  // Run `run` never produced output: the launch threw, spawn failed, or the cook exited before its first line.
  Type.Object({ type: Type.Literal("launch_failed"), at: Type.Number(), run: Type.Number(), reason: Type.String() }, { additionalProperties: false }),
  // Written before the worktree is removed. The tick finishes the removal.
  Type.Object({ type: Type.Literal("closed"), at: Type.Number(), discarded: Type.Boolean() }, { additionalProperties: false }),
]);
export type TaskEvent = Static<typeof TaskEventSchema>;

/** kitchen/config.json. Human-edited, optional. Every field has a default. */
export const ConfigSchema = Type.Object(
  {
    maxCooks: Type.Optional(Type.Integer({ minimum: 1 })),
    model: Type.Optional(Type.String({ description: "cook model, provider/id", pattern: "^[^-]" })),
    thinking: Type.Optional(Type.String({ pattern: "^[^-]" })),
    cookArgs: Type.Optional(Type.Array(Type.String(), { description: "extra pi args for every cook" })),
  },
  { additionalProperties: false },
);
export interface Config {
  maxCooks: number;
  model: string | undefined;
  thinking: string | undefined;
  cookArgs: string[];
}
export const DEFAULT_CONFIG: Config = { maxCooks: 3, model: undefined, thinking: undefined, cookArgs: [] };

/** kitchen/pass.lock. pidStart guards against a reused pid. */
export const LeaseSchema = Type.Object(
  { pid: Type.Number(), pidStart: Type.String(), sessionId: Type.String(), since: Type.Number() },
  { additionalProperties: false },
);
export type Lease = Static<typeof LeaseSchema>;

/** The `chef-mode` session entry that turns chef mode on again on resume. */
export const ChefModeEntrySchema = Type.Object({ on: Type.Boolean() });

/** The `details` of a `chef-wake` message: which runs it told the chef about. Read back on its `message_end`. */
export const WakeDetailsSchema = Type.Object({ notices: Type.Array(Type.Object({ task: Type.String(), run: Type.Number() })) });
export interface NoticeRef {
  task: TaskId;
  run: RunNo;
}
export interface WakeDetails {
  notices: NoticeRef[];
}

// ---------- Persisted: written by the cook's Pi ----------

/**
 * Arguments and structuredContent of the cook's `chef_report` tool. The owner
 * reads it from the `tool_execution_end` line of runs/<n>.jsonl.
 */
export const CookReportSchema = Type.Object(
  {
    status: stringEnum(["done", "needs_decision", "blocked", "failed"] as const),
    summary: Type.String({
      description:
        "done: what changed, the commits, how you verified it. needs_decision: the question and the options. blocked or failed: what stopped you and what you tried.",
    }),
  },
  { additionalProperties: false },
);
export type CookReport = Static<typeof CookReportSchema>;

// ---------- Derived: never persisted ----------

/** What the cook does now, from its last tool_execution_start or turn_start. */
export type Activity = { kind: "starting" } | { kind: "thinking" } | { kind: "tool"; tool: string; detail: string };

export type Outcome =
  | { kind: "done"; summary: string; reported: boolean }
  | { kind: "needs_decision"; question: string }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "stopped" };

export type TaskState =
  | { kind: "queued"; why: "new" | "message" | "interrupted-launch" }
  | { kind: "cooking"; run: RunNo; since: Millis; activity: Activity }
  | { kind: "idle"; run: RunNo | undefined; since: Millis; outcome: Outcome }
  | { kind: "closed"; at: Millis; discarded: boolean };

export interface TaskView {
  spec: TaskSpec;
  state: TaskState;
}

/** One line of a kitchen update. A stopped run never wakes the chef. */
export interface Notice {
  task: TaskId;
  title: string;
  run: RunNo;
  outcome: Exclude<Outcome, { kind: "stopped" }>;
}

export interface Holder {
  pid: Pid;
  sessionId: string;
}

/** A task directory whose files do not parse. Shown, never derived. */
export interface BrokenTask {
  id: TaskId;
  reason: string;
}

export interface Board {
  role: "owner" | "read-only";
  holder: Holder | undefined;
  projects: Project[];
  open: TaskView[];
  broken: BrokenTask[];
  closedCount: number;
  cooks: { busy: number; cap: number };
}
