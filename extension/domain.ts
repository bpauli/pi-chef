import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectName = Brand<string, "ProjectName">;
export type TaskId = Brand<string, "TaskId">;
export type RunNo = Brand<number, "RunNo">;
export type SessionId = Brand<string, "SessionId">;
export type Pid = Brand<number, "Pid">;
export type Millis = Brand<number, "Millis">;

export const runNo = (n: number): RunNo => n as RunNo;
export const millis = (n: number): Millis => n as Millis;

export class ChefError extends Error {}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const isCode = (e: unknown, code: string): boolean => e instanceof Error && "code" in e && e.code === code;

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseProjectName(raw: string): ProjectName {
  const name = raw.trim().toLowerCase();
  if (!PROJECT_NAME.test(name)) {
    throw new ChefError(`Project name "${raw}" must match ${PROJECT_NAME}: lowercase letters, digits, and dashes, 1 to 32 characters.`);
  }
  return name as ProjectName;
}

export function parseModel(raw: string): string {
  const model = raw.trim();
  if (!model) throw new ChefError(`"${raw}" is not a model. Pass provider/model, for example anthropic/claude-sonnet-5-5.`);
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

export function parseTaskId(raw: string, known: readonly TaskId[]): TaskId {
  const text = raw.trim().toLowerCase();
  const exact = known.find((id) => id === text);
  if (exact) return exact;
  if (/^\d+$/.test(text)) {
    const [match, ...others] = known.filter((id) => id.endsWith(`-${text}`));
    if (match && others.length === 0) return match;
  }
  const list = known.length ? known.join(", ") : "none";
  throw new ChefError(`Unknown task "${raw}". Known tasks: ${list}.`);
}

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

export const TaskEventSchema = Type.Union([
  Type.Object({ type: Type.Literal("stop"), at: Type.Number(), run: Type.Number() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("hold"), at: Type.Number(), run: Type.Number() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("notified"), at: Type.Number(), run: Type.Number() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("launch_failed"), at: Type.Number(), run: Type.Number(), reason: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("closed"), at: Type.Number(), discarded: Type.Boolean() }, { additionalProperties: false }),
]);
export type TaskEvent = Static<typeof TaskEventSchema>;

export const ConfigSchema = Type.Object(
  {
    maxCooks: Type.Optional(Type.Integer({ minimum: 1 })),
    model: Type.Optional(Type.String({ description: "cook model, provider/id" })),
    thinking: Type.Optional(Type.String()),
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

export const LeaseSchema = Type.Object(
  { pid: Type.Number(), pidStart: Type.String(), sessionId: Type.String(), since: Type.Number() },
  { additionalProperties: false },
);
export type Lease = Static<typeof LeaseSchema>;

export const ChefModeEntrySchema = Type.Object({ on: Type.Boolean() });

export const WakeDetailsSchema = Type.Object({ notices: Type.Array(Type.Object({ task: Type.String(), run: Type.Number() })) });
export interface NoticeRef {
  task: TaskId;
  run: RunNo;
}
export interface WakeDetails {
  notices: NoticeRef[];
}

export const CookReportSchema = Type.Object(
  {
    status: StringEnum(["done", "needs_decision", "blocked", "failed"] as const),
    summary: Type.String({
      description:
        "done: what changed, the commits, how you verified it. needs_decision: the question and the options. blocked or failed: what stopped you and what you tried.",
    }),
  },
  { additionalProperties: false },
);
export type CookReport = Static<typeof CookReportSchema>;

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
