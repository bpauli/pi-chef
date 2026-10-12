import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type CookReport, CookReportSchema, type TaskSpec } from "./domain.ts";
import { ROLE_ENV, SESSION_ENV, TASK_DIR_ENV } from "./cooks.ts";
import { recipeFor } from "./derive.ts";
import { ROLE_EVENT, answerRole } from "./events.ts";
import { Store, kitchenOfTaskDir, parseSpec } from "./store.ts";

const INBOX_POLL_MS = 300;

export function cookContract(spec: TaskSpec): string {
  return [
    `You are a cook in chef's kitchen: a Pi agent that works alone on task ${spec.id} "${spec.title}". No human watches this run.`,
    `Work only in ${spec.worktree} on branch ${spec.branch}. Commit there with clear messages. Do not touch other checkouts.`,
    "Messages from the chef can arrive as user messages during the run. Follow them.",
    "End every run with exactly one chef_report call:",
    "- done: what changed, the commits, and the command you ran to verify it with what it printed.",
    "- needs_decision: a product, scope, or destructive choice you must not make alone. Give the options.",
    "- blocked: the same obstacle twice, or access you do not have.",
    "- failed: you cannot do the task. Say why.",
    "After chef_report the run ends. The chef's answer comes back as a new message in this session.",
    "Never wait for a human. Never poll or sleep to wait for input.",
  ].join("\n");
}

export function installCook(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
  const taskDir = env[TASK_DIR_ENV];
  if (!taskDir) throw new Error(`${TASK_DIR_ENV} is not set for a cook`);
  // The owner finds this cook by CHEF_SESSION_ID in /proc/<pid>/environ, which keeps
  // the start-time environment. Processes the cook spawns get process.env, so
  // without these variables a bash child or a nested pi is never taken for a cook.
  for (const name of [SESSION_ENV, ROLE_ENV, TASK_DIR_ENV]) delete env[name];
  const specPath = join(taskDir, "task.json");
  const spec = parseSpec(specPath, readFileSync(specPath, "utf8"));
  const inbox = join(taskDir, "inbox");
  let timer: NodeJS.Timeout | undefined;
  // A steer lands only inside a turn. Before the first turn it races the print-mode
  // prompt, after agent_before_settle or a stop signal the run is ending, and in
  // both cases a claimed message would be lost. Unclaimed, it waits for the relaunch.
  let claimable = false;

  pi.registerTool({
    name: "chef_report",
    label: "Report to chef",
    description: "Tell the chef how this run ended. Call it exactly once, as your last action. The run ends after it.",
    promptSnippet: "Report done, needs_decision, blocked, or failed to the chef",
    parameters: CookReportSchema,
    outputSchema: CookReportSchema,
    executionMode: "sequential",
    async execute(_id, report: CookReport) {
      return {
        content: [{ type: "text", text: `Reported ${report.status} to the chef. This run ends now.` }],
        details: report,
        structuredContent: report,
        terminate: true,
      };
    },
  });

  const contract = cookContract(spec);
  pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${contract}` }));
  const kitchen = new Store(kitchenOfTaskDir(taskDir));
  pi.events.on(ROLE_EVENT, (data) => answerRole(data, "cook", recipeFor(kitchen.loadConfig().config.recipe, { role: "cook", project: spec.project })));

  const poll = () => {
    if (!claimable) return;
    let files: string[];
    try {
      files = readdirSync(inbox).filter((f) => f.endsWith(".msg")).sort();
    } catch {
      return;
    }
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(inbox, file), "utf8");
        renameSync(join(inbox, file), join(inbox, "handled", file));
      } catch {
        continue;
      }
      pi.sendUserMessage(`Message from the chef:\n${text}`, { deliverAs: "steer" });
    }
  };

  const stopClaiming = () => {
    claimable = false;
  };
  pi.on("session_start", () => {
    timer ??= setInterval(poll, INBOX_POLL_MS);
    timer.unref();
  });
  pi.on("turn_start", () => {
    claimable = true;
  });
  pi.on("agent_before_settle", stopClaiming);
  pi.on("session_shutdown", () => {
    stopClaiming();
    if (timer) clearInterval(timer);
    timer = undefined;
  });
  // Pi's own handlers for these signals dispose the session and exit. Ours only closes the inbox first.
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, stopClaiming);
}
