# pi-chef design

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
| `chef_add_project` | `path`, `name?`, `note?`, `baseBranch?` | Registers a git repo. The name defaults to the directory name. The base branch defaults to the current branch of the repo. A given base branch must pass `git check-ref-format --branch` and exist locally. |
| `chef_dispatch` | `project`, `title`, `brief`, `model?` | Creates a task and launches a cook, or queues it behind the cap. A blank `model` is refused. Pi 1.0.3 takes the argument after `--model` and `--thinking` as the value even when it starts with a dash (`dist/cli/args.js`), so a model is never read as a flag. |
| `chef_board` | none | Projects, open tasks with state and activity, cook count. |
| `chef_send` | `task`, `message` | One verb for steer, answer, and resume. Cooking: the cook takes it after its current tool call. Idle: the task relaunches on the same session with the message. A cook that reported and is still exiting blocks the relaunch, so `send` ticks until the exit (bounded by `exitWaitMs`, default 5 s) and reports the new run, or `after-exit` when the wait runs out. It reports `queued` only when the cook cap holds the task. |
| `chef_stop` | `task` | Stops a cooking cook (process group SIGTERM, SIGKILL after a grace period), or holds a queued task. The worktree stays. |
| `chef_result` | `task` | Outcome, summary, branch, commits ahead of base, landed or not, worktree clean or dirty, diffstat, file pointers. |
| `chef_close` | `task`, `discard?` | Removes the worktree and closes the task. Refuses dirty or unlanded work, a cooking task, and a task with an undelivered message unless `discard: true`. |

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
| `tasks/<id>/log.jsonl` | owner, append | Decisions only: `stop`, `hold`, `notified`, `launch_failed`, `closed`. |
| `tasks/<id>/runs/<n>.prompt.md` | owner | Launch intent for run `n`: brief or messages. |
| `tasks/<id>/runs/<n>.jsonl` | the cook's Pi stdout | Everything the cook did. The owner only creates it empty with O_EXCL. That create is the launch claim. |
| `tasks/<id>/runs/<n>.err` | the cook's Pi stderr | Diagnostics. Opened for append, so a relaunch of the same run keeps the earlier attempt's output. |
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

A run that settled without `chef_report` derives `done` with `reported: false` and the final assistant text as the summary. A provider error, a crash, or an exit before `agent_settled` derives `failed`. A prompt file with no run file, or a zero-byte run file with no live process and an empty err file, derives `queued(interrupted-launch)`, not `failed`: the chef crashed between the claim and the spawn, and the tick relaunches the same run from its prompt. An empty claim is reclaimed only when it is older than `reclaimAfterMs` (default 30 s), so two owners in a takeover window never unlink each other's fresh claim.

### Launch failures

A launch that produces no output is a failure, not a retry. Three facts derive it, in this order:

- A `launch_failed {run, reason}` event for the run that would launch next, written by the owner when the launch threw (worktree creation, the claim), when `spawn` reported an error, or when the cook process exited before its run file had a first line. The owner that spawned the cook sees its exit; `failLaunchIfNoOutput` checks that the run file is still zero bytes before it writes the event.
- Without an event: a zero-byte run file with no live process and a non-empty err file. This covers a cook that died while no owner ran. The reason is the err tail.
- A `launch_failed` event for a run that has output after all is ignored. The run's own outcome wins.

The task derives `idle(failed)` for that run, with the event reason plus the err tail, and the chef gets a wake. The run number is used up: the retry is the next run. A message newer than the failure resumes the task as `queued(message)`. The relaunch prompt is the brief plus the messages when no run has delivered the brief yet (`prompted`: the run file holds a user `message_end`), else only the messages. `chef_dispatch` answers `failed to launch: <reason>` when the first tick fails the launch.

`chef_stop` logs `stop {run}` for a cooking run and `hold {run}` for a queued task, where `run` is the run that would launch next. Either event holds the task. A pending message older than the last `stop` or `hold` does not relaunch it; the next newer message does, and the relaunch prompt carries every pending message. A message with the same millisecond as the event counts as newer: the serialized chain wrote the event first. A held task is `idle(stopped)`. Only a `stop` signals the cook of its run and ends that run as `stopped`, so the run that a message resumes after a `hold` runs to its report. Kitchens written before `hold` existed logged a hold as a `stop` that names a run that was never claimed. `loadRecord` reads such a `stop` as a `hold`.

## Cook identity and liveness

No pid is stored on disk. A cook is identified by `CHEF_SESSION_ID=<uuid>` in its start-time process environment, set by the launcher. Argv is not usable: Pi 1.0.3 sets `process.title = "pi"` at startup (`dist/cli/setup.js`), which overwrites `/proc/<pid>/cmdline` within the first second, so `--session-id` disappears from `ps`. The cook role deletes `CHEF_SESSION_ID`, `CHEF_ROLE`, and `CHEF_TASK_DIR` from its `process.env` when it loads, so the processes a cook spawns (Pi's bash runs them in their own process groups) carry no marker and a nested `pi` is never taken for a cook. As a guard for the load window, the cook is the marked process whose parent carries no marker. The owner keeps an in-memory map from session id to pid:

- At launch it records the pid that `spawn` returns.
- At activation (restart) it scans once: `/proc/*/environ` on Linux, `ps -E -eo pid=,ppid=,command=` elsewhere. This adopts cooks that outlived the last chef.
- On each tick it checks a known pid with `process.kill(pid, 0)` and confirms the environment still holds the marker (`/proc/<pid>/environ` on Linux, `ps -E -o command= -p <pid>` elsewhere). This guards against pid reuse.
- A claimed, unsettled run with no known pid gets one scan before it counts as dead. The scan adopts a cook another session launched. After that scan the run is dead for the tick, but every launch scans once more right before it claims, so a cook the scan missed never gets a sibling on its session.

A stop sends SIGTERM to the cook's process group, and Pi kills its own bash tree. SIGKILL after the grace period gives Pi no chance, so a command it was running can outlive it.

A settled run whose process is still alive after the exit grace period (`exitGraceMs`, default 10 s from the run's last message) gets SIGTERM from the tick, then SIGKILL after the kill grace period. `chef_stop` on such a task sends SIGTERM at once. The task stays `idle` with its outcome throughout; the signal frees the session for the next run.

All subprocess calls (`ps`, `git`) are async. Git facts are computed only for `chef_result`, `chef_close`, and dispatch, never on the tick. Every git argv puts `--end-of-options` before the refs it takes from the kitchen, and the only model-controlled ref, the base branch, is validated at `chef_add_project`.

## Launch order

Each step is safe if a crash stops it halfway.

1. Ensure the worktree (create or re-attach `worktrees/<id>` on `chef/<id>` from the base branch).
2. Write `runs/<n>.prompt.md`. The brief plus the pending inbox messages until a run has delivered the brief, then only the messages. An interrupted launch reuses its prompt and appends new messages.
3. Move those messages to `inbox/handled/`.
4. Create `runs/<n>.jsonl` with O_EXCL (the claim) and open `runs/<n>.err` for append. A failed claim means another launch won. Stop.
5. Spawn `pi --mode json -p --session-id <uuid> --session-dir <task>/session -e <chef entry> [--model] [--thinking] [cookArgs...] @<prompt file>`, detached in its own process group, stdin `ignore`, stdout to the claimed file, stderr to `runs/<n>.err`, env `CHEF_ROLE=cook`, `CHEF_TASK_DIR=<task dir>`, `CHEF_SESSION_ID=<uuid>`.

The child runs the same Pi as the chef: `process.execPath` plus `process.argv[1]` when Pi runs under Node, `process.execPath` alone for the compiled binary. It never resolves `pi` from `PATH`.

## The tick

`plan(records, live, now, cap)` is pure. It returns task views plus actions: `launch`, `signal`, `remove-worktree`, `notify`. The owner runs a tick every second and after every mutating tool call. Every action is idempotent: launch claims with O_EXCL, signal re-checks identity, worktree removal accepts a missing path, notify dedupes by `task#run`. Startup reconciliation is the first tick. A second tick right after it finds nothing to do.

Ticks and mutations (`addProject`, `dispatch`, `send`, `stop`, `close`, `markNotified`) run on one serialized chain. A mutation runs in the order lease check, read, decide, write, then the tick body. A lost lease is found before the first write, and no interval tick can change a task between the decision and the write. `send` holds the chain while it waits for a reported cook to exit.

A stop request on a live run escalates to SIGKILL after the grace period. A `closed` event with a worktree still on disk finishes the removal.

### Close and branch deletion

`chef_close` refuses, unless `discard`: a cooking task, a task queued with an undelivered message, a dirty worktree, commits on neither the base branch nor a remote-tracking ref, and a worktree whose HEAD is not the task branch (detached, another branch, a rebase in progress), because commits made there go away with the worktree. "Landed by a remote branch" means a remote-tracking ref as of the last fetch; `chef_result` says so.

The close operation appends `closed`, removes the worktree itself, and reports what git did: worktree removed or already gone, branch deleted, kept, or already gone, or the git error. The branch is deleted only when it is an ancestor of the base branch (`merge-base --is-ancestor`) or when discarding. `git branch -d` is not used: it deletes a branch whose upstream contains it, and that remote-tracking ref can be stale. A pushed but unmerged task closes with its branch kept.

## Wakes

A notice is due when a task is idle with a final outcome other than `stopped`, its run has no `notified` event, and it has no pending relaunch. The `Waker` batches notices: the first opens a 1.5 s quiet window, each new notice extends it, and the total wait is capped at 5 s. Then it sends one message:

```ts
pi.sendMessage({ customType: "chef-wake", content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
```

`sendMessage` is not delivery. While the chef is mid-turn, Pi holds the message in its follow-up queue, and Escape, an abort, or quitting Pi drops it. The owner appends `notified` for each run only in the `message_end` handler for the `chef-wake` message, which reads the runs back from `details`. Until then the tick derives the notice again every second, and the `Waker` keeps the sent notices in an in-flight set so they are not sent twice. When `agent_settled` fires with wakes still in flight, Pi dropped them: the set is cleared and the next tick sends them again. A crash in between repeats a notice. It never loses one.

The restart prefix is set only when the first tick has notices, and cleared after that wake is sent.

## Lease and session roles

`Kitchen.open()` returns `{ kind: "owner"; kitchen: Kitchen } | { kind: "read-only"; reader: KitchenReader; holder }`. A read-only session has no `dispatch` method to call. The lease is stale when its pid is dead or the pid start time differs. `/chef takeover` replaces a live lease on purpose. The O_EXCL run claim is the hard guard against a double launch. The lease only decides who gets woken.

A read-only session's tick calls `promote()` every second: it takes the lease when it is free or stale and the session becomes the owner, with a Waker and a first tick that may carry the restart prefix. While a live holder keeps the lease, the session stays read-only until `/chef takeover`.

Chef mode persists as a `chef-mode` session entry (`pi.appendEntry`), so a resumed chef session turns chef mode on again in `session_start`.

## Cook role

`extension/index.ts` reads `CHEF_ROLE`. With `cook`, it installs only the cook half:

- `chef_report`, as above.
- A cook contract appended to the system prompt in `before_agent_start`: work only in this worktree, commit on the task branch, never wait for a human, end every run with exactly one `chef_report`. The cook principles block follows the contract (see "Principles").
- The inbox poller (300 ms). It claims only while a turn is active: `turn_start` opens the window, `agent_before_settle`, `session_shutdown`, SIGTERM, and SIGHUP close it. Inside the window it renames a message into `handled/` first, then calls `pi.sendUserMessage(text, { deliverAs: "steer" })`. Outside it (before the first turn, where a steer races the print-mode prompt; while the run ends; while the cook dies after a stop) the message stays in the inbox for the owner to relaunch. `chef_send` to a cook that is being stopped answers `after-stop`: the message restarts the task once the cook has exited.

Double loading is guarded with `globalThis[Symbol.for("chef.loaded")]`. The guard is cleared on `session_shutdown`, so `/reload` registers the tools again.

## Principles

`principles/<name>/SKILL.md` holds the 24 pstack principle skills, vendored by `tools/sync-pstack.mjs` (MIT, `principles/LICENSE`, upstream commit in `principles/SOURCE.md`). These files are the single source. `loadPrinciples` parses `name` and `description` from each frontmatter with typebox, and a file without them is a load error. `principlesBlock(role, principles)` is pure. It returns a frame, the always-on rules of that role (`RULES` in `extension/principles.ts`, each rule names its principles), and an index derived from the files: one line per principle with its name, its description, and its absolute path. The block ends with "Before you apply a principle, read its file in full."

| Session | Block | Where |
|---|---|---|
| cook | cook rules and the index | `cook.ts`, after the cook contract in `before_agent_start` |
| chef, while chef mode is on | chef rules and the index | `chef.ts`, `before_agent_start` when the session has the kitchen open |
| normal Pi session, or chef mode off | none | |

Each process loads the principles once, when the extension installs. The chef handler reads the chef-mode state at each turn, so `/chef` and `/chef off` mid-session change the next turn's prompt.

Two other deliveries were rejected:

- The files are not under `skills/`, because `pi.skills` would list all 24 in every Pi session that has chef installed.
- `resources_discover` can add the directory as skills for `--chef` sessions and cooks, but it runs before `/chef` can turn chef mode on mid-session, so that session gets nothing.

`principle-explain-the-number` links to `../benchmark-checklist/`, which is not vendored. The link stays as upstream wrote it.

## Module map

About 2.8k lines of source. Any flow passes through at most three files: tool, then `kitchen.ts`, then one of `store`, `cooks`, `git`, `derive`.

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
| `principles.ts` | Loads the vendored principles and builds the block for each role. |

Every file line and run-file line is checked with `Value.Check` before a field is read. A bad line is skipped and counted, never a crash of the tick. The tick reads the kitchen through one `Store.snapshot`, each file in isolation: a task whose `task.json` does not parse is listed on the board as `broken` with the reason, a bad `config.json` yields the defaults plus an error line, a bad project file is skipped plus an error line. The shell shows an error when it starts and again only after it went away and came back. `task.json` is written through tmp plus rename inside the task directory, whose `mkdir` is the exclusive step.

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

- Unit (`node --test`, no Pi): run-file fold over recorded Pi streams, `deriveTask` per state (including launch failures and the same-millisecond stop), `plan` (cap, interrupted launch and the reclaim threshold, stop escalation, the stuck settled cook, closed with worktree), close verdict, wake batching with the in-flight set, board text, result text truncation, the LF-only reader with split UTF-8 input, the cook poller gate against a fake extension API, the principle index against the vendored files, the rules of each role.
- Git (real temp repos): ensure worktree twice, landed by base and by remote branch, dirty refusal, a stale remote-tracking ref never deletes the branch, a detached HEAD is off the branch.
- Kitchen e2e (real cook Pi processes, fake model, temp `PI_CODING_AGENT_DIR` and `CHEF_HOME`): dispatch to two projects; a cook reports `needs_decision`; `send` relaunches and the cook commits and reports `done`; a message sent mid-run is steered; stop, and send right after a stop; close refuses then succeeds; a new `Kitchen` instance adopts a live cook and derives the outcome of a cook that exited while no owner ran; a second tick does nothing; a bad model and a broken worktree path are launch failures that a send retries; a broken task.json and config.json do not stop the tick; a cook that never exits is killed; a ghost cook blocks a second launch; a lost lease is found before any write; a read-only session promotes.
- Chef e2e (a chef `pi --mode rpc --chef` on the fake model): tools are active only with `--chef`; a dispatch leads to one `chef-wake` that starts a turn; a wake queued behind a busy turn is marked notified only on delivery; a wake dropped with `clear_queue` is sent again after the turn settles; the model gets the chef principles with `--chef` and after `/chef`, and none in a plain session or after `/chef off`. A kitchen e2e test proves the cook's model gets the cook principles and no chef rules.
- Sync (a fixture tree, no network): `tools/sync-pstack.mjs` vendors the principles, drops a removed one, and a second run changes nothing.
