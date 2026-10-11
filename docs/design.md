# chef design

This file is the contract for the code in `extension/`. Terms follow `CONTEXT.md`. It was synthesized from a three-model architect arena. The base was the Opus candidate, and a Fable cross-judge agreed. The grafts and the facts measured on Pi 1.0.3 are listed at the end.

## Usage

The human starts chef mode with `pi --chef`, or types `/chef` in any Pi session. A normal Pi session has no chef tools.

```text
> Add rate limiting to the api login route, and fix the web login redirect bug.
```

The chef model loads the `chef` skill, then calls tools. Each tool result is a few lines with file pointers, not dumps.

```text
chef_add_project {"path": "~/dev/api", "note": "Go service, run make test"}
  -> Registered api: /home/p/dev/api, tasks fork from main.

chef_dispatch {"project": "api", "title": "Add rate limiting to /login", "brief": "..."}
  -> api-7 is cooking on branch chef/api-7 (2/3 cooks busy). You will get a kitchen update when it needs you.
```

Later, with no polling, one wake starts a chef turn:

```text
Kitchen update (2):
- api-7 "Add rate limiting to /login" is done: token bucket in limit.go, make test passes. Review with chef_result api-7.
- web-2 "Fix login redirect" needs a decision: keep the cookie session or move to bearer tokens? Answer with chef_send web-2.
```

After a chef restart, the first wake starts with `Chef restarted: 1 cook still cooking, 2 runs finished while you were away.`

The widget below the editor shows one line per open task:

```text
chef  2/3 cooks  1 needs you
● api-7  cooking  bash: npm test                  4m
! web-2  needs decision: cookie or bearer token?   1m
```

## Tools

All tools are registered with `defaultActive: false` and `exposure: "model-only"`, and chef mode activates them with `setActiveTools`. All are `executionMode: "sequential"`.

| Tool | Parameters | Does |
|---|---|---|
| `chef_add_project` | `path`, `name?`, `note?`, `baseBranch?` | Registers a git repo. The name defaults to the directory name. The base branch defaults to the current branch of the repo. |
| `chef_dispatch` | `project`, `title`, `brief`, `model?` | Creates a task and launches a cook, or queues it behind the cap. |
| `chef_board` | none | Projects, open tasks with state and activity, cook count. |
| `chef_send` | `task`, `message` | One verb for steer, answer, and resume. Cooking: the cook takes it after its current tool call. Idle: the task relaunches on the same session with the message. A cook that reported and is still exiting blocks the relaunch, so `send` ticks until the exit (bounded by `exitWaitMs`, default 5 s) and reports the new run. It reports `queued` only when the cook cap holds the task. |
| `chef_stop` | `task` | Stops a cooking cook (process group SIGTERM, SIGKILL after a grace period), or holds a queued task. The worktree stays. |
| `chef_result` | `task` | Outcome, summary, branch, commits ahead of base, landed or not, worktree clean or dirty, diffstat, file pointers. |
| `chef_close` | `task`, `discard?` | Removes the worktree and closes the task. Refuses dirty or unlanded work unless `discard: true`. |

The cook role registers one tool, `chef_report {status, summary}`, with `status` one of `done`, `needs_decision`, `blocked`, `failed`. It returns `structuredContent` (the parsed report) and `terminate: true`, so the run ends with no further model call.

The command `/chef` takes `on` (default), `off`, `takeover`, and `board`.

## Files and writers

One writer per file. No file is shared by two writers.

| File under the kitchen | Writer | Meaning |
|---|---|---|
| `config.json` | the human | Optional. `maxCooks` (default 3), `model`, `thinking`, `cookArgs` (extra pi args for every cook). |
| `pass.lock` | the lease holder | `{pid, pidStart, sessionId, since}`. |
| `projects/<name>.json` | owner, once | Project spec. |
| `tasks/<id>/task.json` | owner, once (O_EXCL) | Immutable task spec: project, title, brief, branch, worktree, base branch, session id, model. |
| `tasks/<id>/log.jsonl` | owner, append | Decisions only: `stop`, `notified`, `closed`. |
| `tasks/<id>/runs/<n>.prompt.md` | owner | Launch intent for run `n`: brief or messages. |
| `tasks/<id>/runs/<n>.jsonl` | the cook's Pi stdout | Everything the cook did. The owner only creates it empty with O_EXCL. That create is the launch claim. |
| `tasks/<id>/runs/<n>.err` | the cook's Pi stderr | Diagnostics. |
| `tasks/<id>/session/` | the cook's Pi | The task's Pi session, shared by all runs. |
| `tasks/<id>/inbox/*.msg` | owner creates with tmp plus rename | Messages to the task. |
| `tasks/<id>/inbox/handled/` | one mover | The cooking cook moves a message here before it steers. While no cook is live, the owner moves messages here when it writes them into a prompt. |
| `worktrees/<id>/` | git, then the cook | The task's worktree on branch `chef/<id>`. |

The cook writes no chef file of its own. Its report is the `tool_execution_end` line of `chef_report` in its own run file.

## Task state

No task state is stored. `deriveTask` folds `task.json`, the log, the run files, the inbox count, and the live process map into one union:

```ts
type TaskState =
  | { kind: "queued"; why: "new" | "message" | "interrupted-launch" }
  | { kind: "cooking"; run: RunNo; since: Millis; activity: Activity }
  | { kind: "idle"; run: RunNo | undefined; since: Millis; outcome: Outcome }
  | { kind: "closed"; at: Millis; discarded: boolean };

type Outcome =
  | { kind: "done"; summary: string; reported: boolean }
  | { kind: "needs_decision"; question: string }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "stopped" };
```

A run that settled without `chef_report` derives `done` with `reported: false` and the final assistant text as the summary. A provider error, a crash, or an exit before `agent_settled` derives `failed`. A prompt file with no run file, or a zero-byte run file with no live process, derives `queued(interrupted-launch)`, not `failed`.

A `stop` event holds a task. A pending message older than the last stop does not relaunch it; the next newer message does, and the relaunch prompt carries every pending message. A held task is `idle(stopped)`.

## Cook identity and liveness

No pid is stored on disk. A cook is identified by `CHEF_SESSION_ID=<uuid>` in its start-time process environment, set by the launcher. Argv is not usable: Pi 1.0.3 sets `process.title = "pi"` at startup (`dist/cli/setup.js`), which overwrites `/proc/<pid>/cmdline` within the first second, so `--session-id` disappears from `ps`. The cook role deletes `CHEF_SESSION_ID`, `CHEF_ROLE`, and `CHEF_TASK_DIR` from its `process.env` when it loads, so the processes a cook spawns (Pi's bash runs them in their own process groups) carry no marker and a nested `pi` is never taken for a cook. As a guard for the load window, the cook is the marked process whose parent carries no marker. The owner keeps an in-memory map from session id to pid:

- At launch it records the pid that `spawn` returns.
- At activation (restart) it scans once: `/proc/*/environ` on Linux, `ps -E -eo pid=,ppid=,command=` elsewhere. This adopts cooks that outlived the last chef.
- On each tick it checks a known pid with `process.kill(pid, 0)` and confirms the environment still holds the marker (`/proc/<pid>/environ` on Linux, `ps -E -o command= -p <pid>` elsewhere). This guards against pid reuse.
- A claimed, unsettled run with no known pid gets one scan before it counts as dead. The scan adopts a cook another session launched. After that scan the run is dead for good.

A stop sends SIGTERM to the cook's process group, and Pi kills its own bash tree. SIGKILL after the grace period gives Pi no chance, so a command it was running can outlive it.

All subprocess calls (`ps`, `git`) are async. Git facts are computed only for `chef_result`, `chef_close`, and dispatch, never on the tick.

## Launch order

Each step is safe if a crash stops it halfway.

1. Ensure the worktree (create or re-attach `worktrees/<id>` on `chef/<id>` from the base branch).
2. Write `runs/<n>.prompt.md`. For a relaunch it holds the pending inbox messages.
3. Move those messages to `inbox/handled/`.
4. Create `runs/<n>.jsonl` with O_EXCL (the claim). A failed claim means another launch won. Stop.
5. Spawn `pi --mode json -p --session-id <uuid> --session-dir <task>/session -e <chef entry> [--model] [--thinking] [cookArgs...] @<prompt file>`, detached in its own process group, stdin `ignore`, stdout to the claimed file, stderr to `runs/<n>.err`, env `CHEF_ROLE=cook`, `CHEF_TASK_DIR=<task dir>`, `CHEF_SESSION_ID=<uuid>`.

The child runs the same Pi as the chef: `process.execPath` plus `process.argv[1]` when Pi runs under Node, `process.execPath` alone for the compiled binary. It never resolves `pi` from `PATH`.

## The tick

`plan(records, live, now, cap)` is pure. It returns task views plus actions: `launch`, `signal`, `remove-worktree`, `notify`. The owner runs a tick every second and after every mutating tool call. Every action is idempotent: launch claims with O_EXCL, signal re-checks identity, worktree removal accepts a missing path, notify dedupes by `task#run`. Startup reconciliation is the first tick. A second tick right after it finds nothing to do.

A stop request on a live run escalates to SIGKILL after the grace period. A `closed` event with a worktree still on disk finishes the removal.

## Wakes

A notice is due when a task is idle with a final outcome other than `stopped`, its run has no `notified` event, and it has no pending relaunch. The `Waker` batches notices: the first opens a 1.5 s quiet window, each new notice extends it, and the total wait is capped at 5 s. Then it sends one message:

```ts
pi.sendMessage({ customType: "chef-wake", content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
```

The owner appends `notified` for each run only after `sendMessage` returns. A crash in between repeats a notice. It never loses one.

## Lease and session roles

`Kitchen.open()` returns `{ kind: "owner"; kitchen: Kitchen } | { kind: "read-only"; reader: KitchenReader; holder }`. A read-only session has no `dispatch` method to call. The lease is stale when its pid is dead or the pid start time differs. `/chef takeover` replaces a live lease on purpose. The O_EXCL run claim is the hard guard against a double launch. The lease only decides who gets woken.

Chef mode persists as a `chef-mode` session entry (`pi.appendEntry`), so a resumed chef session turns chef mode on again in `session_start`.

## Cook role

`extension/index.ts` reads `CHEF_ROLE`. With `cook`, it installs only the cook half:

- `chef_report`, as above.
- A cook contract appended to the system prompt in `before_agent_start`: work only in this worktree, commit on the task branch, never wait for a human, end every run with exactly one `chef_report`.
- The inbox poller (300 ms). It renames a message into `handled/` first, then calls `pi.sendUserMessage(text, { deliverAs: "steer" })`. On `agent_before_settle` it sets a closing flag and stops claiming, so a late message stays in the inbox for the owner to relaunch.

Double loading is guarded with `globalThis[Symbol.for("chef.loaded")]`. The guard is cleared on `session_shutdown`, so `/reload` registers the tools again.

## Module map

About 2k lines of source. Any flow passes through at most three files: tool, then `kitchen.ts`, then one of `store`, `cooks`, `git`, `derive`.

| Module | Owns |
|---|---|
| `index.ts` | Double-load guard and role switch. |
| `domain.ts` | Branded ids, typebox schemas for persisted shapes (types via `Static`), derived unions, `ChefError`. |
| `derive.ts` | Pure decisions: run-file fold, task state, plan, close verdict, wake text, board text. |
| `store.ts` | The only module that knows the kitchen layout. Includes the incremental LF-only run-file reader. |
| `cooks.ts` | Launch argv, spawn, the liveness map, group signals, prompt text. |
| `git.ts` | Worktree ensure and remove, landed facts, diffstat. |
| `kitchen.ts` | The deep module: the seven operations plus `tick`. It imports no Pi types. |
| `chef.ts` | The Pi shell: tools as one-call adapters, `/chef`, the widget, the `Waker`, activation. |
| `cook.ts` | The cook half. |

Every file line and run-file line is checked with `Value.Check` before a field is read. A bad line is skipped and counted, never a crash of the tick.

## Measured facts on Pi 1.0.3

These were measured with probe scripts against the real binary. The fake model is `test/fake-model/`.

- Closing a `pi --mode rpc` child's stdin ends it within about 20 ms, mid-run, with no `agent_settled`. RPC cooks cannot outlive the chef.
- A detached `pi --mode json -p` with stdin `ignore` and stdout to a file keeps running after its parent exits, and exits by itself after `agent_settled`.
- `pi -p` with an open non-TTY stdin waits on stdin. Cooks need stdin `ignore`.
- `sendUserMessage(text, { deliverAs: "steer" })` from the cook's own extension lands mid-run as a user message after the current tool call.
- Two extensions that register the same tool name make Pi exit with `Tool "x" conflicts`. The `globalThis` guard makes double loading harmless.
- A tool result with `terminate: true` ends a `-p` run with no further model call.
- `structuredContent` appears on `tool_execution_end` in the JSONL stream.
- `@<absolute path>` works as the prompt of `-p`. A relaunch with the same `--session-id` and `--session-dir` continues the conversation.
- A `defaultActive: false` tool is absent from the model and its `promptGuidelines` are absent from the system prompt until `setActiveTools` names it.
- Pi sets `process.title = "pi"` at startup. After about 800 ms `/proc/<pid>/cmdline` reads `pi` only. `/proc/<pid>/environ` keeps the launcher's variables (probe-title.mjs).
- Pi's bash tool spawns its command with `detached: true`, in its own process group, and kills that tree itself on SIGTERM.

## Grafts and fixes from the arena

- From the Sonnet candidate: the settle-aware cook poller (claim before steer, stop at `agent_before_settle`), the owner and reader type split, inbox writes by tmp plus rename, and the restart prefix in the first wake.
- From the Fable candidate: `kill(pid, 0)` on the hot path with `ps` only at activation and launch, and the rule that git facts stay off the tick.
- From the cross-judge: `exposure: "model-only"`, zero-byte run file as interrupted launch, and async subprocess calls.

## Not in v1

PR creation or merge automation (a brief can tell the cook to run `gh`), per-project capacity, remote workers, a separate supervision model, removing projects, Windows.

## Test plan

- Unit (`node --test`, no Pi): run-file fold over recorded Pi streams, `deriveTask` per state, `plan` (cap, interrupted launch, stop escalation, closed with worktree), close verdict, wake batching, board text, the LF-only reader with split UTF-8 input.
- Git (real temp repos): ensure worktree twice, landed by base and by remote branch, dirty refusal.
- Kitchen e2e (real cook Pi processes, fake model, temp `PI_CODING_AGENT_DIR` and `CHEF_HOME`): dispatch to two projects; a cook reports `needs_decision`; `send` relaunches and the cook commits and reports `done`; a message sent mid-run is steered; stop; close refuses then succeeds; a new `Kitchen` instance adopts a live cook and derives the outcome of a cook that exited while no owner ran; a second tick does nothing.
- Chef e2e (a chef `pi --mode rpc --chef` on the fake model): tools are active only with `--chef`; a dispatch leads to one `chef-wake` that starts a turn.
