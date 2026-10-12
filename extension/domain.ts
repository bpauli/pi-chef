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
    branchPrefix: Type.Optional(Type.String({ description: "task branches are <branchPrefix><task id>" })),
    note: Type.Optional(Type.String()),
    addedAt: Type.Number(),
  },
  { additionalProperties: false },
);
export type ProjectFile = Static<typeof ProjectSchema>;
export type Project = Omit<ProjectFile, "name" | "addedAt" | "branchPrefix"> & { name: ProjectName; branchPrefix: string; addedAt: Millis };

export const DEFAULT_BRANCH_PREFIX = "issue/";

export const taskBranch = (branchPrefix: string, task: string): string => `${branchPrefix}${task}`;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ThinkingSchema = StringEnum(THINKING_LEVELS, { description: "pi --thinking level" });

export const ProfileSchema = Type.Object(
  { model: Type.String({ pattern: "\\S", description: "provider/model" }), thinking: Type.Optional(ThinkingSchema) },
  { additionalProperties: false },
);
export type Profile = Static<typeof ProfileSchema>;

export const TaskSpecSchema = Type.Object(
  {
    id: Type.String(),
    project: Type.String(),
    title: Type.String(),
    brief: Type.String(),
    branch: Type.String({ description: "<branchPrefix><id>, fixed at dispatch" }),
    worktree: Type.String({ description: "kitchen/worktrees/<id>" }),
    baseBranch: Type.String(),
    sessionId: Type.String(),
    models: Type.Optional(Type.Array(ProfileSchema, { description: "candidate models, in order, frozen at dispatch" })),
    rule: Type.Optional(Type.String({ description: "the model rule chosen at dispatch" })),
    model: Type.Optional(Type.String({ description: "written before models existed, read as models: [{ model }]" })),
    createdAt: Type.Number(),
  },
  { additionalProperties: false },
);
export type TaskSpecFile = Static<typeof TaskSpecSchema>;
export type TaskSpec = Omit<TaskSpecFile, "id" | "project" | "sessionId" | "createdAt" | "models" | "model"> & {
  id: TaskId;
  project: ProjectName;
  sessionId: SessionId;
  /** Empty: no frozen list, so each launch uses the kitchen default of that moment. */
  models: Profile[];
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

const ProfilesSchema = Type.Union([ProfileSchema, Type.Array(ProfileSchema, { minItems: 1 })]);
const RULE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const ModelRuleSchema = Type.Object(
  {
    name: Type.String({ pattern: RULE_NAME.source, description: "what chef_dispatch passes as rule" }),
    when: Type.String({ description: "the kind of task, in plain words" }),
    use: ProfilesSchema,
    why: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ConfigSchema = Type.Object(
  {
    maxCooks: Type.Optional(Type.Integer({ minimum: 1 })),
    model: Type.Optional(Type.String({ description: "shorthand for models.default: [{ model, thinking }]" })),
    thinking: Type.Optional(ThinkingSchema),
    models: Type.Optional(
      Type.Object({ rules: Type.Optional(Type.Array(ModelRuleSchema)), default: Type.Optional(ProfilesSchema) }, { additionalProperties: false }),
    ),
    cookArgs: Type.Optional(Type.Array(Type.String(), { description: "extra pi args for every cook" })),
  },
  { additionalProperties: false },
);
export type ConfigFile = Static<typeof ConfigSchema>;

export interface ModelRule {
  name: string;
  when: string;
  use: Profile[];
  why: string | undefined;
}
export interface ModelsConfig {
  rules: ModelRule[];
  default: Profile[];
}
export interface Config {
  maxCooks: number;
  models: ModelsConfig;
  cookArgs: string[];
}
export const DEFAULT_CONFIG: Config = { maxCooks: 3, models: { rules: [], default: [] }, cookArgs: [] };

const listOf = (p: Profile | Profile[]): Profile[] => (Array.isArray(p) ? p : [p]);

/** Normalizes a parsed config file. The old top-level `model` and `thinking` become the default list. */
export function configOf(file: ConfigFile, path: string): Config {
  if (file.models !== undefined && (file.model !== undefined || file.thinking !== undefined)) {
    throw new ChefError(`${path} has both models and the old model or thinking field. Move them into models.default.`);
  }
  if (file.thinking !== undefined && file.model === undefined) throw new ChefError(`${path} has thinking without model. Set both, or use models.default.`);
  const names = new Set<string>();
  for (const rule of file.models?.rules ?? []) {
    if (names.has(rule.name)) throw new ChefError(`${path} has two model rules named "${rule.name}". Rule names must be unique.`);
    names.add(rule.name);
  }
  const shorthand: Profile[] = file.model === undefined ? [] : [file.thinking === undefined ? { model: file.model } : { model: file.model, thinking: file.thinking }];
  return {
    maxCooks: file.maxCooks ?? DEFAULT_CONFIG.maxCooks,
    models: {
      rules: (file.models?.rules ?? []).map((r) => ({ name: r.name, when: r.when, use: listOf(r.use), why: r.why })),
      default: file.models?.default === undefined ? shorthand : listOf(file.models.default),
    },
    cookArgs: file.cookArgs ?? [],
  };
}

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
        "done: what changed, the commits, and the verify command you ran with what it printed. needs_decision: the question and the options. blocked or failed: what stopped you and what you tried.",
    }),
  },
  { additionalProperties: false },
);
export type CookReport = Static<typeof CookReportSchema>;

export type Activity = { kind: "starting" } | { kind: "thinking" } | { kind: "tool"; tool: string; detail: string };

/** provider: the model call failed after Pi's own retries. crash: the cook died before it settled. launch: no output at all. report: the cook reported failed. */
export type FailCause = "provider" | "crash" | "launch" | "report";

export type Outcome =
  | { kind: "done"; summary: string; reported: boolean }
  | { kind: "needs_decision"; question: string }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string; cause: FailCause }
  | { kind: "stopped" };

export type TaskState =
  | { kind: "queued"; why: "new" | "message" | "interrupted-launch" | "fallback" }
  | { kind: "cooking"; run: RunNo; since: Millis; activity: Activity }
  | { kind: "idle"; run: RunNo | undefined; since: Millis; outcome: Outcome }
  | { kind: "closed"; at: Millis; discarded: boolean };

export interface TaskView {
  spec: TaskSpec;
  state: TaskState;
  /** The model of the current or last run, or of the next run while queued. Undefined: Pi's default model. */
  model: string | undefined;
}

/** A run that failed with a provider error and was followed by a run on the next candidate. */
export interface Tried {
  model: string;
  error: string;
}

export interface Notice {
  task: TaskId;
  title: string;
  run: RunNo;
  model: string | undefined;
  /** The runs since the last notice that fell back to the next candidate, oldest first. */
  tried: Tried[];
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
