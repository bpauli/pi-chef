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
  -> Registered api: /home/p/dev/api, tasks fork from main on branches issue/<task id>.

chef_dispatch {"project": "api", "title": "Add rate limiting to /login", "brief": "..."}
  -> api-7 is cooking on branch issue/api-7 (2/3 cooks busy). You will get a kitchen update when it needs you.
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
| `chef_add_project` | `path`, `name?`, `note?`, `baseBranch?`, `branchPrefix?` | Registers a git repo. The name defaults to the directory name. The base branch defaults to the current branch of the repo. A given base branch must pass `git check-ref-format --branch` and exist locally. The branch prefix defaults to `issue/`. The prefix plus a sample task id (`<name>-1`) must pass `git check-ref-format --branch`. The result names the prefix. |
| `chef_dispatch` | `project`, `title`, `brief`, `model?`, `rule?` | Creates a task with its candidate models (see "Cook models") and launches a cook, or queues it behind the cap. A blank `model` and an unknown `rule` are refused. The result names each skipped candidate and why. Pi 1.0.3 takes the argument after `--model` and `--thinking` as the value even when it starts with a dash (`dist/cli/args.js`), so a model is never read as a flag. |
| `chef_board` | none | Projects, open tasks with state and activity, cook count. |
| `chef_send` | `task`, `message` | One verb for steer, answer, and resume. Cooking: the cook takes it after its current tool call. Idle: the task relaunches on the same session with the message. A cook that reported and is still exiting blocks the relaunch, so `send` ticks until the exit (bounded by `exitWaitMs`, default 5 s) and reports the new run, or `after-exit` when the wait runs out. It reports `queued` only when the cook cap holds the task. |
| `chef_stop` | `task` | Stops a cooking cook (process group SIGTERM, SIGKILL after a grace period), or holds a queued task. The worktree stays. |
| `chef_result` | `task` | Outcome, summary, branch, commits ahead of base, landed or not, worktree clean or dirty, diffstat, file pointers. |
| `chef_close` | `task`, `discard?` | Removes the worktree and closes the task. Refuses dirty or unlanded work, a cooking task, and a task with an undelivered message unless `discard: true`. |

The cook role registers one tool, `chef_report {status, summary}`, with `status` one of `done`, `needs_decision`, `blocked`, `failed`. It returns `structuredContent` (the parsed report) and `terminate: true`, so the run ends with no further model call.

The command `/chef` takes `on` (default), `off`, `takeover`, and `board`.

## Cook models

The human lists the cook models in `config.json`. The shape follows the crew dispatch config of firstmate, without its harness, quota, and approval fields, because a cook is always Pi:

```ts
type Profile = { model: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
type ModelRule = { name: string; when: string; use: Profile | Profile[]; why?: string };
config.models?: { rules?: ModelRule[]; default?: Profile | Profile[] };
```

`model` is `provider/id`, as `pi --model` takes it. `thinking` is a `pi --thinking` level. A rule `name` matches `[a-z0-9][a-z0-9-]*` and is unique. `when` says in plain words which tasks the rule fits. A single profile in `use` or `default` is a list of one. `loadConfig` normalizes the file to `{ rules: { name, when, use: Profile[], why }[]; default: Profile[] }`.

The old top-level `model` and `thinking` still load, as `models.default: [{ model, thinking }]`. A file with `models` and one of the old fields, or with `thinking` and no `model`, is a config error line, and the kitchen uses the defaults.

The chef model selects, not code. In chef mode, a second `before_agent_start` handler in `chef.ts` adds a "Cook models" section to the chef's system prompt: each rule with its name, `when`, `why`, and models, then the default list, and the instruction to pass the name of the best-fitting rule as `rule`, or no rule for the default. `modelsPrompt` in `derive.ts` builds the text. The handler reads `config.json` on every turn, so an edit applies without a restart. A config without rules adds no section, because there is nothing to choose.

`selectModels` (pure, `derive.ts`) builds the candidates. An explicit `model` wins over `rule` and is candidate one. Else the rule's `use` comes first. The default list follows in both cases. Each model is a candidate once, at its first place. An unknown rule is refused with the names of the rules.

Then the kitchen drops each candidate that cannot run, through `KitchenDeps.modelCheck`. `chef.ts` builds that check from Pi's model registry on the extension context: `ctx.modelRegistry.getAll()` and `hasConfiguredAuth(model)` (`dist/core/model-registry.js:18` and `:31` in Pi 1.0.3). A model matches as `provider/id`, else as an id that only one model has. The check does not do the partial match of `pi --model`. A model that Pi does not know, or whose provider has no credentials, is dropped. The `chef_dispatch` result names each dropped model and why. When candidates were configured and none is left, the dispatch is refused with every reason. With no check (the kitchen tests), every candidate counts as available.

A dispatch freezes the task's candidates in `task.json` as `models: Profile[]`, in order, and the chosen rule as `rule`. Run 1 uses the first candidate: `--model <model>`, plus `--thinking <level>` when the profile has one. A provider failure moves the task to the next candidate (see "Model fallback"). An empty list means that the task has no frozen candidates: each launch uses the kitchen default of that moment, and with no default the cook gets no `--model`, so Pi picks its own default. A `task.json` written before candidates existed loads its `model` as `models: [{ model }]`, and one without a model as `[]`. Thus a task that relied on the config `model` keeps it.

## Files and writers

One writer per file. No file is shared by two writers.

| File under the kitchen | Writer | Meaning |
|---|---|---|
| `config.json` | the human | Optional. `maxCooks` (default 3), `models` (see "Cook models"), `cookArgs` (extra pi args for every cook), `recipe` (see "Recipes"). The chef and the cooks only read it. |
| `pass.lock` | the lease holder | `{pid, pidStart, sessionId, since}`. |
| `projects/<name>.json` | owner, once | Project spec: name, path, base branch, branch prefix, note. A file without `branchPrefix` uses `issue/`. |
| `tasks/<id>/task.json` | owner, once (O_EXCL) | Immutable task spec: project, title, brief, branch (`<branchPrefix><id>` at dispatch), worktree, base branch, session id, the candidate models, and the model rule. |
| `tasks/<id>/log.jsonl` | owner, append | Decisions only: `stop`, `hold`, `notified`, `launch_failed`, `closed`. |
| `tasks/<id>/runs/<n>.prompt.md` | owner | Launch intent for run `n`: brief or messages. |
| `tasks/<id>/runs/<n>.jsonl` | the cook's Pi stdout | Everything the cook did. The owner only creates it empty with O_EXCL. That create is the launch claim. The cook's fd 1 is this file, which identifies the cook. |
| `tasks/<id>/runs/<n>.err` | the cook's Pi stderr | Diagnostics. Opened for append, so a relaunch of the same run keeps the earlier attempt's output. |
| `tasks/<id>/session/` | the cook's Pi | The task's Pi session, shared by all runs. |
| `tasks/<id>/inbox/*.msg` | owner creates with tmp plus rename | Messages to the task. |
| `tasks/<id>/inbox/handled/` | one mover | The cooking cook moves a message here before it steers. While no cook is live, the owner moves messages here when it writes them into a prompt. |
| `worktrees/<id>/` | git, then the cook | The task's worktree on the branch in `task.json`. |

The cook writes no chef file of its own. Its report is the `tool_execution_end` line of `chef_report` in its own run file.

## Task state

No task state is stored. `deriveTask` folds `task.json`, the log, the run files, the inbox count, and the live process map into one union:

```ts
type TaskState =
  | { kind: "queued"; why: "new" | "message" | "interrupted-launch" | "fallback" }
  | { kind: "cooking"; run: RunNo; since: Millis; activity: Activity }
  | { kind: "idle"; run: RunNo | undefined; since: Millis; outcome: Outcome }
  | { kind: "closed"; at: Millis; discarded: boolean };

type Outcome =
  | { kind: "done"; summary: string; reported: boolean }
  | { kind: "needs_decision"; question: string }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string; cause: "provider" | "crash" | "launch" | "report" }
  | { kind: "stopped" };
```

`cause` says why a run failed: `provider` for a model call that failed after Pi's own retries (the provider-error verdict of the run-file fold), `crash` for a cook that died before `agent_settled`, `launch` for a launch failure, and `report` for a `failed` report. A task view also carries the model of its current or last run, or of its next run while queued: `provider/id` from the run file's assistant messages, else the candidate of that run. `chef_result` and the board show it.

A run that settled without `chef_report` derives `done` with `reported: false` and the final assistant text as the summary. A provider error, a crash, or an exit before `agent_settled` derives `failed`. A prompt file with no run file, or a zero-byte run file with no live process and an empty err file, derives `queued(interrupted-launch)`, not `failed`: the chef crashed between the claim and the spawn, and the tick relaunches the same run from its prompt. An empty claim is reclaimed only when it is older than `reclaimAfterMs` (default 30 s), so two owners in a takeover window never unlink each other's fresh claim.

### Model fallback

The candidate that run `n` uses is derived, not stored. Its index in the task's candidates is the number of earlier runs of the task whose outcome is a provider failure, and the last candidate stays when the index is past the end. Thus each provider failure uses up one candidate, and a later run stays on the candidate that worked. A launch failure, a crash, and a `failed` report use up none.

When the last run started, failed with cause `provider`, was not stopped, and the task has a candidate left (provider failures so far < candidates), the task derives `queued(fallback)`. That run gets no notice. The tick launches the next run on the next candidate at once, in the same Pi session, so the cook keeps its context. Its prompt is not the brief, which the session already holds. It names the model that failed, its error, and the next model, and tells the cook to continue (`fallbackPrompt` in `cooks.ts`). Nothing new is written to disk: the launch writes its prompt and claims its run file as every launch does, and an interrupted fallback launch relaunches the same run on the same candidate, because the earlier runs did not change.

When no candidate is left, the task derives `idle(failed)` with cause `provider`, and the chef gets a wake that names every model tried with its error. A `chef_send` retries on the last candidate. A notice carries the runs since the last notice that fell back (`tried`) and the model of its run, so the first wake after a fallback says which model failed, why, and which model took over.

Measured on Pi 1.0.3 with the fake model: an HTTP 402 answer is an assistant `message_end` with `stopReason: "error"` and `errorMessage: "402: <response body>"`, then `agent_settled`, with no `auto_retry_start`, in less than 1 s. Pi's auto-retry does not match 402 (`isRetryableAssistantError` in `pi-ai/dist/utils/retry.js`). It does match `429`, rate-limit text, and 5xx, which Pi retries with a 2 s, 4 s, 8 s backoff first (settings `retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`). A relaunch on another `--model` with the same `--session-id` gets the earlier user messages, and the failed assistant message does not reach the next model.

### Launch failures

A launch that produces no output is a failure, not a retry. Three facts derive it, in this order:

- A `launch_failed {run, reason}` event for the run that would launch next, written by the owner when the launch threw (worktree creation, the claim), when `spawn` reported an error, or when the cook process exited before its run file had a first line. The owner that spawned the cook sees its exit; `failLaunchIfNoOutput` checks that the run file is still zero bytes before it writes the event.
- Without an event: a zero-byte run file with no live process and a non-empty err file. This covers a cook that died while no owner ran. The reason is the err tail.
- A `launch_failed` event for a run that has output after all is ignored. The run's own outcome wins.

The task derives `idle(failed)` for that run, with the event reason plus the err tail, and the chef gets a wake. The run number is used up: the retry is the next run. A message newer than the failure resumes the task as `queued(message)`. The relaunch prompt is the brief plus the messages when no run has delivered the brief yet (`prompted`: the run file holds a user `message_end`), else only the messages. `chef_dispatch` answers `failed to launch: <reason>` when the first tick fails the launch.

`chef_stop` logs `stop {run}` for a cooking run and `hold {run}` for a queued task, where `run` is the run that would launch next. Either event holds the task. A pending message older than the last `stop` or `hold` does not relaunch it; the next newer message does, and the relaunch prompt carries every pending message. A message with the same millisecond as the event counts as newer: the serialized chain wrote the event first. A held task is `idle(stopped)`. Only a `stop` signals the cook of its run and ends that run as `stopped`, so the run that a message resumes after a `hold` runs to its report. Kitchens written before `hold` existed logged a hold as a `stop` that names a run that was never claimed. `loadRecord` reads such a `stop` as a `hold`.

## Cook identity and liveness

No pid is stored on disk. A cook is identified by its stdout: the process whose fd 1 is a run file `<kitchen>/tasks/<id>/runs/<n>.jsonl` cooks that task. The O_EXCL claim makes the file unique per run, the launcher passes the claim fd as stdout, so the kernel sets the identity before Pi runs, and Pi's bash tool pipes its children's stdout, so the processes a cook spawns do not carry it. As a guard for a direct child that inherits it, the cook is the process whose parent does not write a run file. Paths are compared as realpaths, because macOS puts the temp dir under a symlink (`/var` to `/private/var`) and lsof prints the resolved path. Only a path under the real `tasks/` of this kitchen counts (`taskOfRunFile` in `store.ts`), so a cook of another kitchen is never adopted. Neither argv nor the environment is usable: Pi 1.0.3 sets `process.title = "pi"` at startup (`dist/cli/setup.js`), which overwrites `/proc/<pid>/cmdline` on Linux and, on macOS, the area that `ps -E` reads, so neither `--session-id` nor an environment marker is visible there. The cook role deletes `CHEF_ROLE` and `CHEF_TASK_DIR` from its `process.env` when it loads, so a `pi` that the cook starts does not load the cook half for the same task. The owner keeps an in-memory map from task id to pid:

- At launch it records the pid that `spawn` returns.
- At activation (restart) it scans once: `readlink /proc/*/fd/1` with the parent from `/proc/<pid>/stat` on Linux, `lsof -w -d 1 -F pRn` elsewhere. This adopts cooks that outlived the last chef.
- On each tick it checks every known pid with `process.kill(pid, 0)` and confirms in one probe that fd 1 is still a run file of its task (`readlink /proc/<pid>/fd/1` on Linux, one `lsof -w -a -p <pids> -d 1 -F pRn` elsewhere). This guards against pid reuse.
- A claimed, unsettled run with no known pid gets one scan before it counts as dead. The scan adopts a cook another session launched. After that scan the run is dead for the tick, but every launch scans once more right before it claims, so a cook the scan missed never gets a sibling on its session.

A stop sends SIGTERM to the cook's process group, and Pi kills its own bash tree. SIGKILL after the grace period gives Pi no chance, so a command it was running can outlive it.

A settled run whose process is still alive after the exit grace period (`exitGraceMs`, default 10 s from the run's last message) gets SIGTERM from the tick, then SIGKILL after the kill grace period. `chef_stop` on such a task sends SIGTERM at once. The task stays `idle` with its outcome throughout; the signal frees the session for the next run.

All subprocess calls (`lsof`, `ps`, `git`) are async. Git facts are computed only for `chef_result`, `chef_close`, and dispatch, never on the tick. Every git argv puts `--end-of-options` before the refs it takes from the kitchen, and the model-controlled refs, the base branch and the branch prefix, are validated at `chef_add_project`.

## Launch order

Each step is safe if a crash stops it halfway.

1. Ensure the worktree (create or re-attach `worktrees/<id>` on the branch in `task.json` from the base branch).
2. Write `runs/<n>.prompt.md`. The brief plus the pending inbox messages until a run has delivered the brief, then only the messages. An interrupted launch reuses its prompt and appends new messages.
3. Move those messages to `inbox/handled/`.
4. Create `runs/<n>.jsonl` with O_EXCL (the claim) and open `runs/<n>.err` for append. A failed claim means another launch won. Stop.
5. Spawn `pi --mode json -p --session-id <uuid> --session-dir <task>/session -e <chef entry> [--model <candidate>] [--thinking <level>] [cookArgs...] @<prompt file>`, detached in its own process group, stdin `ignore`, stdout to the claimed file (which is also the cook's identity), stderr to `runs/<n>.err`, env `CHEF_ROLE=cook`, `CHEF_TASK_DIR=<task dir>`.

The child runs the same Pi as the chef: `process.execPath` plus `process.argv[1]` when Pi runs under Node, `process.execPath` alone for the compiled binary. It never resolves `pi` from `PATH`.

## The tick

`plan(records, live, now, cap)` is pure. It returns task views plus actions: `launch`, `signal`, `remove-worktree`, `notify`. A `launch` carries its prompt kind (`brief`, `messages`, `existing`, or `fallback`) and the candidate of its run, which sets `--model` and `--thinking`. The owner runs a tick every second and after every mutating tool call. Every action is idempotent: launch claims with O_EXCL, signal re-checks identity, worktree removal accepts a missing path, notify dedupes by `task#run`. Startup reconciliation is the first tick. A second tick right after it finds nothing to do.

Ticks and mutations (`addProject`, `dispatch`, `send`, `stop`, `close`, `markNotified`) run on one serialized chain. A mutation runs in the order lease check, read, decide, write, then the tick body. A lost lease is found before the first write, and no interval tick can change a task between the decision and the write. `send` holds the chain while it waits for a reported cook to exit.

A stop request on a live run escalates to SIGKILL after the grace period. A `closed` event with a worktree still on disk finishes the removal.

### Close and branch deletion

`chef_close` refuses, unless `discard`: a cooking task, a task queued with an undelivered message, a dirty worktree, commits on neither the base branch nor a remote-tracking ref, and a worktree whose HEAD is not the task branch (detached, another branch, a rebase in progress), because commits made there go away with the worktree. "Landed by a remote branch" means a remote-tracking ref as of the last fetch; `chef_result` says so.

Review and close use the branch in `task.json`, never the current prefix of the project. A task dispatched with an older prefix, for example `chef/<id>` from before branch prefixes, keeps that branch until it closes.

The close operation appends `closed`, removes the worktree itself, and reports what git did: worktree removed or already gone, branch deleted, kept, or already gone, or the git error. The branch is deleted only when it is an ancestor of the base branch (`merge-base --is-ancestor`) or when discarding. `git branch -d` is not used: it deletes a branch whose upstream contains it, and that remote-tracking ref can be stale. A pushed but unmerged task closes with its branch kept.

## Wakes

A notice is due when a task is idle with a final outcome other than `stopped`, its run has no `notified` event, and it has no pending relaunch. The `Waker` batches notices: the first opens a 1.5 s quiet window, each new notice extends it, and the total wait is capped at 5 s. Then it sends one message:

```ts
pi.sendMessage({ customType: "chef-wake", content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" });
```

`sendMessage` is not delivery. While the chef is mid-turn, Pi holds the message in its follow-up queue, and Escape, an abort, or quitting Pi drops it. The owner appends `notified` for each run only in the `message_end` handler for the `chef-wake` message, which reads the runs back from `details`. Until then the tick derives the notice again every second, and the `Waker` keeps the sent notices in an in-flight set so they are not sent twice. When `agent_settled` fires with wakes still in flight, Pi dropped them: the set is cleared and the next tick sends them again. A crash in between repeats a notice. It never loses one.

The restart prefix is set only when the first tick has notices, and cleared after that wake is sent.

A notice after a model fallback names it:

```text
- api-7 "Add rate limiting to /login" is done: token bucket in limit.go. It fell back to openai/gpt-6-astra after a provider error on openrouter/z-ai/glm-5.2 (402: ...). Review with chef_result api-7.
- web-2 "Fix login redirect" failed with a provider error on every candidate model: openrouter/z-ai/glm-5.2 (402: ...); openai/gpt-6-astra (429: ...). chef_send web-2 to retry on openai/gpt-6-astra, or tell the human.
```

## Lease and session roles

`Kitchen.open()` returns `{ kind: "owner"; kitchen: Kitchen } | { kind: "read-only"; reader: KitchenReader; holder }`. A read-only session has no `dispatch` method to call. The lease is stale when its pid is dead or the pid start time differs. `/chef takeover` replaces a live lease on purpose. The O_EXCL run claim is the hard guard against a double launch. The lease only decides who gets woken.

A read-only session's tick calls `promote()` every second: it takes the lease when it is free or stale and the session becomes the owner, with a Waker and a first tick that may carry the restart prefix. While a live holder keeps the lease, the session stays read-only until `/chef takeover`.

Chef mode persists as a `chef-mode` session entry (`pi.appendEntry`), so a resumed chef session turns chef mode on again in `session_start`.

## Cook role

`extension/index.ts` reads `CHEF_ROLE`. With `cook`, it installs only the cook half:

- `chef_report`, as above.
- A cook contract appended to the system prompt in `before_agent_start`: work only in this worktree, commit on the task branch, never wait for a human, end every run with exactly one `chef_report`.
- The inbox poller (300 ms). It claims only while a turn is active: `turn_start` opens the window, `agent_before_settle`, `session_shutdown`, SIGTERM, and SIGHUP close it. Inside the window it renames a message into `handled/` first, then calls `pi.sendUserMessage(text, { deliverAs: "steer" })`. Outside it (before the first turn, where a steer races the print-mode prompt; while the run ends; while the cook dies after a stop) the message stays in the inbox for the owner to relaunch. `chef_send` to a cook that is being stopped answers `after-stop`: the message restarts the task once the cook has exited.

Double loading is guarded with `globalThis[Symbol.for("chef.loaded")]`. The guard is cleared on `session_shutdown`, so `/reload` registers the tools again.

## Integration events

Chef has no hard dependency on a terminal multiplexer or another Pi package. It publishes the open tasks on `pi.events`, and optional add-on packages show them. `pi.events` is in-process: all extensions loaded in one Pi process share it, and no other process sees it.

The event is a versioned snapshot, not a delta, so a consumer converges from any snapshot it receives:

```ts
const COOKS_EVENT = "pi-chef:cooks:v1";
const COOKS_REQUEST_EVENT = "pi-chef:cooks:v1:request";

interface CooksSnapshot {
  version: 1;
  sessionId: string;                     // the chef Pi session id
  role: "owner" | "read-only" | "off";   // off: chef mode closed in this session
  tasks: CookTask[];                     // open tasks only; a task that leaves the list is closed
}
interface CookTask {
  id: string; project: string; title: string;
  state: "queued" | "cooking" | "idle";
  run?: number; since?: number;
  activity?: string;                     // cooking: one line
  outcome?: { kind: "done" | "needs_decision" | "blocked" | "failed" | "stopped"; text: string }; // idle
  worktree: string; branch: string; taskDir: string;
  transcript?: string;                   // the run file of `run`
  viewer: { command: string; args: string[] }; // node <extension>/watch.ts <task dir>
}
```

`extension/events.ts` owns the contract and the pure builder `cooksSnapshot(sessionId, board, paths)`. It imports no Pi types. Add-ons import the types with `import type` only, so no runtime code crosses a package. Each add-on checks the fields it reads with typebox, because the event comes from another package.

Emit rules, in `chef.ts`:

- After each tick, owner or read-only, the session builds the snapshot from the board. It emits only when the serialized snapshot differs from the last one it emitted.
- On `COOKS_REQUEST_EVENT` it emits its last snapshot again. A consumer that starts late, or after `/reload`, sends the request on `session_start`.
- `/chef off` and `session_shutdown` emit `role: "off"` with no tasks. A reopen for `/chef takeover` does not.

Each consumer is the one writer of what it shows (a herdr tab status, a FleetView record). Chef never writes it.

### Role query

An add-on that acts per role asks which pi-chef role its Pi process has:

```ts
const ROLE_EVENT = "pi-chef:role:v1";

interface RoleRequest {
  version: 1;
  role?: "chef" | "cook"; // the asker leaves it unset; chef fills it
  recipe?: string;  // chef fills it with the role: a recipe name or "none"; unset is no selection
}
```

The asker emits a new request and reads `role` and `recipe` when `emit` returns. Pi 1.0.3 runs the listeners of `pi.events` synchronously: `emit` calls `EventEmitter.emit` (`dist/core/event-bus.js:5-6`), and each listener is an async wrapper that calls the handler before its first `await` (`dist/core/event-bus.js:9-11`). A listener that sets `role` without an `await` has set it before `emit` returns.

| Process | `role` | `recipe` | Answered by |
|---|---|---|---|
| cook | `cook` | `recipe.projects[<task's project>]`, else `recipe.default` | `cook.ts`, from its own install. It cannot read `CHEF_ROLE`, because the cook role deletes it from `process.env` at load. |
| chef session, while chef mode is on (owner or read-only) | `chef` | `recipe.default` | `chef.ts`, while the session has the kitchen open |
| normal Pi session, chef mode off, or chef not installed | unset | unset | nobody |

`recipe` is unset when `config.json` selects nothing for the role. `recipeFor` (pure, `derive.ts`) resolves it from the normalized config. Chef reads `config.json` through `Store.loadConfig` at each request, so an edit applies at the next question. A cook reads the same file: it keeps the task directory from `CHEF_TASK_DIR` before it deletes the variable, and the kitchen is two levels up (`kitchenOfTaskDir` in `store.ts`). A cook only reads the config, so it still writes no chef file. A config with an error line answers no `recipe`, as with the other defaults.

Chef checks the request with typebox and changes nothing else. The answer is the state at the moment of the question, so an asker asks again each time it needs the role, for example at each turn. Then extension load order does not matter, and `/chef`, `/chef off`, or a config edit changes the next answer.

`recipe` is an additive change to v1. An older add-on that does not read it still gets `role` and adds its block as before.

### Recipe discovery

Chef asks which recipes are installed with a second synchronous request:

```ts
const RECIPES_EVENT = "pi-chef:recipes:v1";

interface RecipesRequest {
  version: 1;
  recipes: string[]; // chef sends it empty; each recipe add-on pushes its name
}
```

A recipe add-on checks the request with typebox and pushes its name. Chef asks at each owner tick and for each board text. Each selected recipe (other than `none`) that no add-on pushed is an error line: `config.json selects the recipe "<name>", but no installed add-on provides it. Installed sets: <names>.` (`missingRecipes` in `derive.ts`). The line follows the rules of the other tick errors, so the human sees it once while it lasts. `chef_board` and `/chef board` show the selection under the projects, for example `Recipe: pstack. Per project: api none.` (`recipeText` in `derive.ts`).

## The viewer

`extension/watch.ts` is chef's reader of its own run files, for a human in a terminal. Every cooks snapshot names it per task as `viewer`: `node <extension>/watch.ts <task dir>`. The viewer prints the highest `runs/<n>.jsonl` from its start, then follows the appended bytes every 250 ms. It shows the prompt and steer messages, the streamed assistant text, one line per tool call with its key argument, a dim tail of the tool output, provider errors in red, the `chef_report` status and summary, and the run end. A newer run file gets a separator line with its run number. The viewer exits 0 when `log.jsonl` has a `closed` event. The viewer decides nothing. It runs under plain Node, so it imports node builtins only and narrows each line with small hand guards.

## Add-on: herdr tabs

`addons/herdr/` is the package `pi-chef-herdr`. When the chef runs inside herdr (`HERDR_ENV=1` and `HERDR_WORKSPACE_ID` when the add-on loads), it opens one herdr tab per cooking task, so the human can watch the cook work. The tab is a watch pane only. The cook stays a detached `pi --mode json -p` process, and the human still steers through the chef. The add-on acts only on a snapshot with `role: "owner"`. A read-only or off snapshot makes it forget its records, so the tabs have one writer, and the next owner snapshot adopts the live tabs again. It sends `COOKS_REQUEST_EVENT` on `session_start`.

The tab runs `exec <viewer command> <viewer args...>`, each word shell-quoted, in the task worktree, with the label `cook <task id>` and `--no-focus`. When the viewer exits, herdr closes the tab. The add-on knows nothing of the kitchen layout.

`addons/herdr/herdr.ts` is the only module that calls herdr. `CookTabs` keeps one in-memory record per open task: the last run seen cooking, the pane of its tab, and the last state reported to that pane. Nothing is stored on disk. Snapshots can arrive while herdr calls run, so one sync runs at a time, on the newest snapshot:

- A run seen cooking for the first time is a transition. Only a transition, and the first owner snapshot after load or after a read-only or off snapshot, lists the live tabs (`tab list` joined with `pane list`). A task with a live `cook <id>` tab adopts it. A transition with no live tab opens one. A chef restart adopts the tabs of the last chef.
- A tab is opened at most once per run. When the human closes a tab, the next report gets `pane_not_found`, the record forgets the pane, and no tab opens again for that run. The next run opens a new one.
- A task with a known pane gets `pane report-agent --source chef --agent cook` when its report changes: cooking is `working` with the current activity, idle with done or stopped is `idle`, idle with needs decision, blocked, or failed is `blocked` with the outcome text. A queued task gets no report.
- A run that starts and settles between two ticks is never seen cooking and gets no tab.

Herdr calls are async (`execFile`) with the binary from `HERDR_BIN_PATH`, else `herdr`. Every reply is parsed with typebox. A herdr error never throws into the event emitter: it becomes an error line, shown with `ctx.ui.notify` once while it lasts.

## Add-on: FleetView jobs

`addons/subagents/` is the package `pi-chef-subagents`. It shows each open task as one external job in the FleetView of pi-subagents, in owner and read-only sessions. The add-on is the one writer of the jobs whose id starts with `chef-`.

At the first snapshot that is not `off`, it looks for pi-subagents in `<cwd>/.pi/npm/node_modules` (a project install), then in `<agent dir>/npm/node_modules`. It reads `exports["./external-runs"].default` from the package's `package.json`, joins it to the package directory, and imports that file by its absolute path. Without the package it does nothing and gives one info notification. The lookup runs once per process.

| Task | `state` | `currentAction` | `preview` |
|---|---|---|---|
| queued | `queued` | `queued` | |
| cooking | `running` | the activity | |
| idle, done | `completed` | `done: <summary>` | the summary |
| idle, failed | `failed` | `failed: <reason>` | the reason |
| idle, needs decision or blocked | `stopped` | `needs decision: <question>`, `blocked: <reason>` | the question or reason |
| idle, stopped | `stopped` | `stopped` | |

The external-run API has no state for "needs the human". FleetView draws `stopped` as a warning glyph, the same as `paused`, and `failed` as an error glyph, so a task that waits for the human is `stopped`. The job id is `chef-<task id>`, `source` is `pi-chef`, the label is `<task id> <title>`, and `transcriptPath` is the snapshot's `transcript`. `startedAt` is the start of the current or last run, `endedAt` the time the task went idle. Text is cut to the documented limits (160 characters for a label or action, 4096 for a preview or path), and an empty text is left out, because the API refuses an empty string.

The add-on keeps the display fields it last wrote per task and writes only when they change. An update sends every display field, with `undefined` for one that went away, so an old preview never stays. A task that leaves the snapshot, every task on `role: "off"`, and every task on `session_shutdown` are unregistered. A register that fails because an earlier copy of the add-on left the job (for example across `/reload`) becomes an update.

## Recipes

A recipe is a named group of working rules that the user chooses for the chef and the cooks. Each recipe is an optional add-on package with a recipe name that matches `[a-z0-9-]+`. Core has no recipe. Without an add-on, no prompt gets a recipe block. pstack (`addons/recipe-pstack/`) is the first set, superpowers (`addons/recipe-superpowers/`) the second. Another recipe is a new add-on that follows this contract:

- In `before_agent_start`, ask the role with the role query `pi-chef:role:v1` (see "Role query"). Ask at each turn, so that `/chef`, `/chef off`, and a config edit change the next turn.
- Add a block only when a role is answered and `recipe` is unset or equals the recipe name. `none` or another recipe name means: add nothing.
- For `chef`, `cook`, or both, append one block to `event.systemPrompt`. A recipe can give a block to one role only.
- Start the block with the heading `# Recipe: <recipe name>`, for example `# Recipe: pstack`. The chef skill looks for this heading.
- Answer the discovery request `pi-chef:recipes:v1` (see "Recipe discovery") by pushing the recipe name.

### Selection

The human selects the recipe in `config.json`:

```ts
config.recipe?: RecipeName | { default?: RecipeName; projects?: Record<ProjectName, RecipeName> };
// RecipeName: a recipe name or "none", matching [a-z0-9-]+
```

The string form is short for `{ default }`. `loadConfig` normalizes it to `{ default: string | undefined; projects: Map<string, string> }`. A `Map` and not an object, so a project named like an object property (`constructor`) gets no inherited value. A bad name, another type, or an unknown key is a config error line, and the kitchen uses the defaults (no selection).

`recipe` had the name `principles` before. `loadConfig` still reads a file with only `principles`: it loads the value as `recipe` and gives one config error line that tells the human to rename the field. A file with both fields is a config error line, and the kitchen uses the defaults.

| Role | Recipe |
|---|---|
| chef | `default` |
| cook of project `p` | `projects[p]`, else `default` |

When the result is unset, there is no selection, and every installed recipe adds its block. This keeps a setup with one installed recipe and no `recipe` field working as before. With two recipes and no selection, the model gets both blocks. Core does not stop this.

Selection is resolved live, at each role query, not frozen at dispatch: it is a choice about how a role works, not a fact of the task. A config edit applies at the next turn of the chef and at the next run of a cook.

## Add-on: pstack recipe

`addons/recipe-pstack/` is the package `pi-chef-recipe-pstack`, the recipe of pstack. With it, the chef and every cook work by the pstack principles. Its block heading is `# Recipe: pstack`, and its frame says that the user chose the pstack principles. Cooks run without `-ne`, so a cook loads the human's installed Pi packages, and an installed add-on also loads in each cook.

`addons/recipe-pstack/principles/<name>/SKILL.md` holds the 24 pstack principle skills, vendored by `addons/recipe-pstack/sync-pstack.mjs` (MIT, `principles/LICENSE`, upstream commit in `principles/SOURCE.md`). These files are the single source. `loadPrinciples` parses `name` and `description` from each frontmatter with typebox, and a file without them is a load error. It changes each em dash and en dash in a description to a plain dash, so the block has none. The vendored file stays as upstream wrote it. `principlesBlock(role, principles)` is pure. It returns the heading, a frame, the always-on rules of that role (`PSTACK_RULES` in `addons/recipe-pstack/principles.ts`, each rule names its principles), and an index derived from the files: one line per principle with its name, its description, and its absolute path. The block ends with "Before you apply a principle, read its file in full."

The add-on loads the principles once, when it installs. Its recipe name is `pstack`. In `before_agent_start` it sends a role query and appends the block of the answered role to `event.systemPrompt`:

| Role answer | Block |
|---|---|
| `cook`, `recipe` unset or `pstack` | cook rules and the index, after the cook contract that `cook.ts` appended |
| `chef`, `recipe` unset or `pstack` | chef rules and the index |
| a role with `recipe` `none` or another recipe | none |
| no role (normal Pi session, chef mode off, chef not installed) | none |

Pi passes each `before_agent_start` handler the system prompt with the changes of the handlers before it (`dist/core/extensions/runner.js:1137-1148`), so the cook contract and the block both reach the model. The add-on asks at each turn, so `/chef` and `/chef off` mid-session change the next turn's prompt, and the load order of chef and the add-on does not matter.

Two other deliveries were rejected:

- The files are not under `skills/`, because `pi.skills` would list all 24 in every Pi session that has the add-on installed.
- `resources_discover` can add the directory as skills for `--chef` sessions and cooks, but it runs before `/chef` can turn chef mode on mid-session, so that session gets nothing.

`principle-explain-the-number` links to `../benchmark-checklist/`, which is not vendored. The link stays as upstream wrote it.

## Add-on: superpowers recipe

`addons/recipe-superpowers/` is the package `pi-chef-recipe-superpowers`, the recipe `superpowers` from [obra/superpowers](https://github.com/obra/superpowers) by Jesse Vincent. Its block heading is `# Recipe: superpowers`, and its frame says that the user chose the superpowers recipe. It follows the contract in "Recipes" in the same way as the pstack add-on: a role query at each turn, the selection check, the discovery answer, and the block after the cook contract.

Superpowers is written for one agent and its human partner. A cook has no human, and the chef owns worktrees and the landing of branches. So the add-on vendors 10 of the 15 skills, and splits them per role. `addons/recipe-superpowers/README.md` gives the reason for each skill in or out.

| Role | Skills in the index |
|---|---|
| chef | brainstorming, dispatching-parallel-agents, requesting-code-review, subagent-driven-development, verification-before-completion, writing-plans |
| cook | executing-plans, receiving-code-review, systematic-debugging, test-driven-development, verification-before-completion |
| none | diagnosing-superpowers, finishing-a-development-branch, using-git-worktrees, using-superpowers, writing-skills |

`addons/recipe-superpowers/principles/<skill>/` holds each chosen skill directory as upstream has it, with its companion files, vendored by `sync-superpowers.mjs` (MIT, `principles/LICENSE`, upstream commit in `principles/SOURCE.md`). The script holds the chosen list. It deletes every vendored skill directory and copies the chosen ones again, so a second run changes nothing and a skill that is no longer chosen goes away. It refuses a checkout that lacks a chosen skill. `tsconfig.json` excludes `addons/*/principles`, because upstream ships an example `.ts` file that does not compile here.

`superpowers.ts` is pure apart from `loadSkills`, which parses `name` and `description` of each vendored `SKILL.md` with typebox and changes each em dash and en dash in a description to a plain dash. `SUPERPOWERS_SKILLS` names the skills of each role's index, and `SUPERPOWERS_RULES` the always-on rules of each role, each with the skills it comes from. The frame adapts the skills to the kitchen. A cook decides a reversible choice itself or reports `needs_decision` where a skill says to ask the human partner. For the chef, the human partner is the human, a `chef_dispatch` with a complete brief is a subagent dispatch, and the steps that use the skills that are not vendored are skipped. `superpowersBlock(role, skills)` returns the heading, the frame, the rules, the index of the role's skills (name, description, absolute path), and "Before you apply a skill, read its file in full."

The add-on imports no runtime code from `extension/` or from the pstack add-on. It duplicates the small loader and block builder, so that each recipe installs alone.

Some vendored skills link to skills that are not vendored (using-git-worktrees, finishing-a-development-branch, using-superpowers). The links stay as upstream wrote them, and the rules tell the model to skip those steps. The upstream description of executing-plans contains an em dash. The index shows it as upstream wrote it.

## Module map

About 3k lines of source. Any flow passes through at most three files: tool, then `kitchen.ts`, then one of `store`, `cooks`, `git`, `derive`.

| Module | Owns |
|---|---|
| `index.ts` | Double-load guard and role switch. |
| `domain.ts` | Branded ids, typebox schemas for persisted shapes (types via `Static`), derived unions, `ChefError`. |
| `derive.ts` | Pure decisions: run-file fold, task state, plan, close verdict, wake text, board text. |
| `store.ts` | The only module that knows the kitchen layout, forwards and backwards (`taskOfRunFile`). Includes the incremental LF-only run-file reader. |
| `cooks.ts` | Launch argv, spawn, the cook identity by fd 1 and the liveness map, group signals, prompt text. |
| `git.ts` | Worktree ensure and remove, landed facts, diffstat. |
| `kitchen.ts` | The deep module: the seven operations plus `tick`. It imports no Pi types. |
| `chef.ts` | The Pi shell: tools as one-call adapters, `/chef`, the widget, the `Waker`, the cooks snapshot emission, activation. |
| `cook.ts` | The cook half. |
| `events.ts` | The integration contract: the cooks snapshot types, the role query, the recipe discovery, the event names, and the pure builder. No Pi types. |
| `watch.ts` | The viewer of a task's run files, under plain Node. Node builtins only. |

The add-ons live outside `extension/` and import no runtime code from it:

| Module | Owns |
|---|---|
| `addons/herdr/index.ts` | The `pi-chef-herdr` entry: the snapshot listener, the sync queue, the notifications. |
| `addons/herdr/herdr.ts` | The only herdr caller: list, open, and report cook tabs, and the in-memory `CookTabs` record. |
| `addons/subagents/index.ts` | The `pi-chef-subagents` entry: the snapshot listener, the FleetView session identity, the notifications. |
| `addons/subagents/fleet.ts` | Finds and loads `pi-subagents/external-runs`, maps a task to its job, and keeps the jobs this add-on wrote (`FleetRecords`). |
| `addons/recipe-pstack/index.ts` | The `pi-chef-recipe-pstack` entry: the role query at each turn, the selection check, the discovery answer, and the block in the system prompt. |
| `addons/recipe-pstack/principles.ts` | Loads the vendored pstack principles and builds the block for each role. |
| `addons/recipe-pstack/sync-pstack.mjs` | Vendors the pstack principles from a cursor/plugins checkout. |
| `addons/recipe-superpowers/index.ts` | The `pi-chef-recipe-superpowers` entry: the role query at each turn, the selection check, the discovery answer, and the block in the system prompt. |
| `addons/recipe-superpowers/superpowers.ts` | Loads the vendored superpowers skills, the role split, the rules, and the block for each role. |
| `addons/recipe-superpowers/sync-superpowers.mjs` | Vendors the chosen superpowers skills from an obra/superpowers checkout. |

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
- Pi sets `process.title = "pi"` at startup. After about 800 ms `/proc/<pid>/cmdline` reads `pi` only. On Linux `/proc/<pid>/environ` keeps the launcher's variables (probe-title.mjs). On macOS 26 `ps -E` shows only `pi` for a process that set its title, with or without `-ww`, so the environment is not readable there (measured on the macos-latest runner for #2).
- A Pi cook's fd 1 is its run file for the whole run. On macOS `lsof -a -p <pid> -d 1 -Fn` lists it in about 11 ms, `lsof -d 1 -FpRn` lists every process with its parent in about 212 ms for 266 processes, and lsof prints the resolved path (`/private/var/...` for a file made under `/var/folders/...`). lsof exits 1 when a listed pid is gone, with the other records intact. The launcher also holds the run file open on another descriptor until it closes it, so only fd 1 counts.
- Pi's bash tool spawns its command with `detached: true`, in its own process group, with pipes for stdout and stderr (`dist/core/tools/bash.js`), so the command does not inherit the cook's fd 1, and kills that tree itself on SIGTERM.

### herdr

Measured on the herdr CLI at `/usr/bin/herdr`:

- Inside herdr the process environment has `HERDR_ENV=1`, `HERDR_WORKSPACE_ID` (for example `w5`), `HERDR_PANE_ID`, `HERDR_BIN_PATH`, and `HERDR_SOCKET_PATH`.
- `herdr tab create --workspace <W> --label <text> --cwd <dir> --no-focus` prints JSON. The new pane id is `.result.root_pane.pane_id`, the tab id `.result.tab.tab_id`.
- `herdr pane run <pane> "exec <cmd>"` runs the command in the pane's shell. When that process exits, herdr closes the pane and its tab.
- `herdr tab list --workspace <W>` gives `.result.tabs[]` with `tab_id` and `label`. `herdr pane list --workspace <W>` gives `.result.panes[]` with `pane_id` and `tab_id`.
- `herdr pane report-agent <pane> --source chef --agent cook --state <idle|working|blocked|unknown> --message <text>` sets the tab's agent status in the herdr sidebar, also for a pane that runs a plain process.
- A CLI error is JSON on stderr, `{"error":{"code","message"}}`, with exit 1. A missing pane is `pane_not_found`.
- Node refuses to strip types from a `.ts` file under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, Node 24.21). `pi install git:...` and a local path install chef outside `node_modules`, so the viewer runs as `.ts`.

### pi-subagents

Measured on the installed Pi 1.0.3 binary with pi-subagents 0.76.0:

- `pi.events` is in-process. All extensions loaded in one Pi process share it.
- From a separately installed extension, `import("pi-subagents/external-runs")` does not resolve. `createRequire(<agent dir>/npm/package.json).resolve(...)` and `Bun.resolveSync(..., <agent dir>/npm)` do not resolve it either.
- Reading `<agent dir>/npm/node_modules/pi-subagents/package.json`, taking `exports["./external-runs"].default`, and importing that absolute path works. `registerExternalRun` then writes to the `Symbol.for("pi-subagents.external-runs.v2")` registry on `globalThis` that the loaded pi-subagents reads.
- FleetView lists the external runs of `sessionManager.getSessionFile() ?? sessionManager.getSessionId()` (`src/shared/session-identity.js`), not of the session id alone. The add-on registers its jobs under that identity from its own `ctx`, not under the snapshot's `sessionId`.
- Pi installs a project npm package under `<cwd>/.pi/npm/node_modules` and a user one under `<agent dir>/npm/node_modules` (`getManagedNpmInstallPath`). A git source takes no subdirectory, so an add-on installs from a local path.
- `registerExternalRun` throws for a job that is already registered, and `updateExternalRun` for one that is not. An empty optional text throws. Control and escape sequences in text are removed by the API.

## Grafts and fixes from the arena

- From the Sonnet candidate: the settle-aware cook poller (claim before steer, stop at `agent_before_settle`), the owner and reader type split, inbox writes by tmp plus rename, and the restart prefix in the first wake.
- From the Fable candidate: `kill(pid, 0)` on the hot path with `ps` only at activation and launch, and the rule that git facts stay off the tick.
- From the cross-judge: `exposure: "model-only"`, zero-byte run file as interrupted launch, and async subprocess calls.

## Not in v1

PR creation or merge automation (a brief can tell the cook to run `gh`), per-project capacity, remote workers, a separate supervision model, removing projects, Windows.

## Test plan

- Unit (`node --test`, no Pi): run-file fold over recorded Pi streams, `deriveTask` per state (including launch failures and the same-millisecond stop), `plan` (cap, interrupted launch and the reclaim threshold, stop escalation, the stuck settled cook, closed with worktree), close verdict, wake batching with the in-flight set, board text, result text truncation, the close refusal names the stored branch, a project file without `branchPrefix` loads with `issue/`, the LF-only reader with split UTF-8 input, the cook identity (a pi-titled process with no `CHEF_*` variable and its run file on fd 1 is adopted and not its child that shares that stdout, a symlinked tasks dir matches, a recorded pid whose stdout is another task's run file is not live and not signalled, a run file on another descriptor is not a cook, the `lsof -F` parse of a sample recorded on macOS, and `taskOfRunFile` refuses every path that is not a run file under the root), the cook poller gate against a fake extension API, the model selection (a rule's models then the default list, one entry per model, an explicit model first, an unknown rule refused, unavailable models dropped with their reasons, and a refusal when none is left), the chef's models section, the config models (rules, a single profile as a list of one, the old `model` and `thinking` shorthand, and duplicate rule names, a bad thinking level, and old and new fields together as error lines), the config recipe (the string form, the object form, `none`, and a bad name, another type, or an unknown key as error lines), the recipe resolution (the chef gets the default, a cook its project's recipe or else the default, a project named `constructor` the default, nothing selected is unset), the missing-recipe error lines and the board line, a `task.json` from before candidates, the run's model from the run file, and the model fallback (a provider failure on candidate 1 plans run 2 on candidate 2 with the fallback prompt and no notice, later runs stay on that candidate, a crash, a failed report, or a stopped run does not fall back, the last candidate's provider failure notifies with every model tried, the notice after a fallback names it, an interrupted fallback launch relaunches the same run on the same candidate, and a launch failure uses up no candidate).
- Git (real temp repos): ensure worktree twice, landed by base and by remote branch, dirty refusal, a stale remote-tracking ref never deletes the branch, a detached HEAD is off the branch.
- Kitchen e2e (real cook Pi processes, fake model, temp `PI_CODING_AGENT_DIR` and `CHEF_HOME`): dispatch to two projects; a cook reports `needs_decision`; `send` relaunches and the cook commits and reports `done`; a message sent mid-run is steered; stop, and send right after a stop; close refuses then succeeds; a branch prefix that gives an invalid task branch is refused; a project without a branch prefix dispatches on `issue/<id>` and one with `feat/` on `feat/<id>`; a task stored on `chef/<id>` closes and deletes that branch once landed; a new `Kitchen` instance adopts a live cook and derives the outcome of a cook that exited while no owner ran; a second tick does nothing; a bad model and a broken worktree path are launch failures that a send retries; a broken task.json and config.json do not stop the tick; a cook that never exits is killed; a ghost cook blocks a second launch; a lost lease is found before any write; a read-only session promotes; a cook whose first candidate answers HTTP 402 fails run 1, run 2 starts on the next candidate in the same session and reports done, and the chef gets one notice that names the fallback.
- Chef e2e (a chef `pi --mode rpc --chef` on the fake model): tools are active only with `--chef`; a dispatch leads to one `chef-wake` that starts a turn; a wake queued behind a busy turn is marked notified only on delivery; a wake dropped with `clear_queue` is sent again after the turn settles; `chef_add_project` refuses an invalid branch prefix and names the one it registered, which `chef_dispatch` uses; the chef's prompt lists the model rules only in chef mode, and `chef_dispatch` refuses an unknown rule and skips a model that Pi does not know; when the first model answers HTTP 402, the chef gets one wake, after the next model is done, and the wake and `chef_result` name the fallback.
- Integration events: `cooksSnapshot` per state (cooking with activity and transcript, idle with each outcome, idle before a first run, queued, closed absent, the viewer arguments). Chef e2e with `test/cooks-recorder.ts` loaded by `-e`: a dispatch emits snapshots that go from no task to cooking to idle done, with no two equal snapshots in a row; a request gets the current snapshot again; `/chef off` emits role off, and nothing follows. With `test/role-recorder.ts`, which asks for the role at each turn start and records the answer right after `emit` returns: a chef session answers no role, then `chef` after `/chef`, then no role after `/chef off`; a kitchen e2e cook answers `cook`.
- Viewer (a real `node extension/watch.ts` process on a temp task dir): it shows the tool line, the text, and the report while the run file grows, with a character split across two appends; a provider error; a newer run file switches with a separator; a `closed` event makes it exit 0.
- herdr add-on (`addons/herdr/test/`, `CookTabs` and the add-on entry driven by snapshots against `fake-herdr.mjs`, which logs its argv and keeps its tabs in a JSON file): a cooking task opens exactly one tab with the label, cwd, and viewer command, and the next snapshot calls herdr not at all; the command starts the viewer from a shell; an existing tab is adopted; each state change reports once with the mapped state; a closed tab is not reopened for the same run; a read-only or off snapshot calls herdr not at all and the next owner snapshot adopts again; a herdr failure is an error line, shown once; the entry asks for a snapshot at session start and skips another version; outside herdr it does nothing. Chef e2e with the add-on loaded by `-e` and the fake binary: inside herdr a dispatch opens one tab and reports `working`, then `idle` once; without `HERDR_ENV` no herdr call happens. `test/support.ts` deletes every `HERDR_*` variable, so no test reaches the human's live herdr session.
- FleetView add-on (`addons/subagents/test/`, the add-on entry against a fake pi-subagents package in a temp agent dir whose `external-runs` module records the calls and keeps the jobs): a cooking task registers one `running` job under the session file with its activity and transcript; each outcome maps to its state and action, and an unchanged snapshot writes nothing; a task that leaves the snapshot, role off, and session shutdown unregister; a snapshot before session start is shown at session start; a job left by an earlier copy is updated; a project install is found; without the package nothing is shown and one info notice says so. Chef e2e with the add-on loaded by `-e` and the fake package in the temp agent dir: a dispatch registers one job, shows it `running`, then `completed`, and `/chef off` unregisters it.
- pstack recipe add-on (`addons/recipe-pstack/test/`): each role's block starts with `# Recipe: pstack`; the index in each role's block lists every vendored principle with its description and a path that exists; each role's block has its own rules and none of the other role's; no role's block has an em dash or an en dash, also when a description has them; `loadPrinciples` refuses a file without a description. Sync, on a fixture tree with no network: `sync-pstack.mjs` vendors the principles, drops a removed one, and a second run changes nothing. Chef e2e with the add-on loaded by `-e`: the model gets the chef principles under the pstack heading with `--chef` and after `/chef`, and no recipe block in a plain session or after `/chef off`. Without the add-on, a `--chef` model gets none. With `recipe` in `config.json`: the chef gets the block for the default `pstack` and for a selection of projects only, and no block for `none` or a recipe that is not installed; a selected recipe that is not installed shows one warning line across ticks, and `/chef board` names the selection. Kitchen e2e: with the add-on in `cookArgs`, the cook's model gets the cook contract and the cook principles under the pstack heading and no chef rules; without it, the contract and no recipe block. A cook of a project without an entry gets the default recipe, and a cook of a project set to `none` gets no block. An edit of `config.json` between run 1 and run 2 of one task changes the block of run 2.
- superpowers recipe add-on (`addons/recipe-superpowers/test/`): each role's block starts with `# Recipe: superpowers`; each role's index lists its own vendored skills with the description and a path that exists, and no skill of the other role only; every vendored skill is in a role's index, and every skill that a rule names is vendored and in that role's index; each role's block has its own rules and none of the other role's; no role's block has an em dash or an en dash, although the vendored executing-plans description has one; `loadSkills` refuses a file without a description. Sync, on a fixture tree with no network: `sync-superpowers.mjs` vendors the chosen skills with their companion files and the license, drops a skill that is no longer chosen, a second run changes nothing, and a checkout that lacks a chosen skill is refused with no change. Chef e2e with both recipe add-ons loaded by `-e`: without a selection the chef gets both chef blocks, with the default `pstack` only the pstack block, with the default `superpowers` only the superpowers block. Kitchen e2e with both recipe add-ons in `cookArgs`: a cook of a project set to `superpowers` gets the cook contract, then only the superpowers cook block, although the default is `pstack`.
