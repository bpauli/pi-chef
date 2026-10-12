import { fileURLToPath } from "node:url";
import { activityText, outcomeDetail } from "./derive.ts";
import type { Board, Outcome, RunNo, TaskId, TaskView } from "./domain.ts";

/**
 * The integration contract. Chef emits a full snapshot of the open tasks on
 * `pi.events`, never a delta, so a consumer converges from any snapshot it
 * receives. Add-on packages import these types with `import type` only.
 */
export const COOKS_EVENT = "pi-chef:cooks:v1";
/** A consumer that starts late emits this. Chef answers with its current snapshot. */
export const COOKS_REQUEST_EVENT = "pi-chef:cooks:v1:request";

export interface CooksSnapshot {
  version: 1;
  /** The chef Pi session id. */
  sessionId: string;
  /** `off`: chef mode closed in this session. A consumer drops what it shows. */
  role: "owner" | "read-only" | "off";
  /** Open tasks only. A task that leaves the list is closed. */
  tasks: CookTask[];
}

export interface CookTask {
  id: string;
  project: string;
  title: string;
  state: "queued" | "cooking" | "idle";
  run?: number;
  since?: number;
  /** Cooking only: what the cook does now, one line. */
  activity?: string;
  /** Idle only. */
  outcome?: { kind: Outcome["kind"]; text: string };
  worktree: string;
  branch: string;
  taskDir: string;
  /** The run file of `run`. A launch that failed before its claim has none on disk. */
  transcript?: string;
  /** Shows the task live in a terminal: the viewer, `node watch.ts <task dir>`. */
  viewer: { command: string; args: string[] };
}

export const WATCH_SCRIPT = fileURLToPath(new URL("./watch.ts", import.meta.url));

export interface KitchenPaths {
  taskDir(id: TaskId): string;
  runFile(id: TaskId, n: RunNo): string;
}

export function cookTask(view: TaskView, paths: KitchenPaths): CookTask | undefined {
  const { spec, state } = view;
  const taskDir = paths.taskDir(spec.id);
  const base = { id: spec.id, project: spec.project, title: spec.title, worktree: spec.worktree, branch: spec.branch, taskDir, viewer: { command: "node", args: [WATCH_SCRIPT, taskDir] } };
  const run = (n: RunNo | undefined) => (n === undefined ? {} : { run: n, transcript: paths.runFile(spec.id, n) });
  switch (state.kind) {
    case "cooking":
      return { ...base, state: "cooking", ...run(state.run), since: state.since, activity: activityText(state.activity) };
    case "idle":
      return { ...base, state: "idle", ...run(state.run), since: state.since, outcome: { kind: state.outcome.kind, text: outcomeDetail(state.outcome) } };
    case "queued":
      return { ...base, state: "queued" };
    case "closed":
      return undefined;
  }
}

export function cooksSnapshot(sessionId: string, board: Board, paths: KitchenPaths): CooksSnapshot {
  const tasks = board.open.flatMap((v) => cookTask(v, paths) ?? []);
  return { version: 1, sessionId, role: board.role, tasks };
}

export const offSnapshot = (sessionId: string): CooksSnapshot => ({ version: 1, sessionId, role: "off", tasks: [] });
