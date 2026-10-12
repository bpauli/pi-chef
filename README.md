# pi-chef

One chef you talk to, many cooks doing the work. pi-chef is a [Pi](https://pi.dev) package. In a chef session, Pi splits your request into tasks, hands each task to a cook (a child Pi process in its own git worktree and branch), and wakes up when a cook is done, needs a decision, is blocked, or failed. You talk only to the chef.

```text
$ pi --chef
> Add rate limiting to the api login route, and fix the web login redirect bug.
```

The chef registers the repositories, dispatches two tasks, and stops. Minutes later one kitchen update starts a chef turn:

```text
Kitchen update (2):
- api-7 "Add rate limiting to /login" is done: token bucket in limit.go, make test passes. Review with chef_result api-7.
- web-2 "Fix login redirect" needs a decision: keep the cookie session or move to bearer tokens? Answer with chef_send web-2.
```

The chef reviews the diff, asks you the one real question, answers the cook, and closes landed work. A widget below the editor shows every open task, its state, what the cook does now, and its age.

## Install

```sh
pi install git:github.com/bpauli/pi-chef
```

Requirements: Pi 1.0.3 or later, Node 22.19 or later, git. Linux and macOS. Cooks run as detached processes and survive a chef restart. On Linux chef finds its cooks through `/proc`; the macOS path (`ps -E`) is written but not covered by the tests.

## Usage

Start chef mode with `pi --chef`, or type `/chef` in a running session. A normal Pi session has no chef tools and no chef state.

Put `--chef` before `-p` when you pass a prompt on the command line: `pi --chef -p "..."`. In Pi 1.0.3 a boolean extension flag that is followed directly by the prompt takes the prompt as its value, and no run starts.

The chef model loads the `chef` skill and uses these tools:

| Tool | Does |
|---|---|
| `chef_add_project` | Registers a git repository. Tasks fork from its base branch. Task branches are `<branchPrefix><task id>`, with the prefix `issue/` by default. |
| `chef_dispatch` | Creates a task and launches a cook, or queues it behind the cook limit. |
| `chef_board` | Projects, open tasks with state and activity, cook count. |
| `chef_send` | One verb for steer, answer, and resume. A cooking cook reads the message after its current tool call. An idle task restarts on the same Pi session with it. |
| `chef_stop` | Stops a cook, or holds a queued task. The worktree and branch stay. |
| `chef_result` | Outcome, summary, branch, commits ahead of base, landed or not, worktree clean or dirty, diffstat, transcript path. |
| `chef_close` | Removes the worktree and closes the task. Refuses dirty or unlanded work unless `discard: true`. Deletes the branch only when the base branch contains it. |

The `/chef` command takes `on` (default), `off`, `takeover`, and `board`. One chef session owns the kitchen at a time. A second session opens read-only and can show the board and results. `/chef takeover` moves the kitchen to the current session.

Each task has a worktree under the kitchen on its own branch. The branch is the project's branch prefix plus the task id, for example `issue/api-7`. Pass `branchPrefix` to `chef_add_project` to use the names that your team or CI expects, for example `feat/`. A task keeps the branch that it got at dispatch. Review the work there with `read` and `bash`, merge or push it as you like, then `chef_close` the task.

To watch one cook live in a terminal, run the viewer on its task directory:

```sh
node <path to pi-chef>/extension/watch.ts <kitchen>/tasks/<task id>
```

## Integrations

chef itself depends on no terminal multiplexer and no other Pi package. It publishes the open tasks as a cooks snapshot on Pi's in-process event bus (`pi-chef:cooks:v1`), and answers a role query (`pi-chef:role:v1`) with `chef` or `cook` (see `docs/design.md`, "Integration events"). Optional add-on packages in `addons/` use them. Install only the ones you want:

| Add-on | Does |
|---|---|
| `addons/herdr` | Inside herdr, opens a `cook <task id>` tab per cooking task that shows the cook live, and shows each cook's state in the herdr sidebar. See `addons/herdr/README.md`. |
| `addons/subagents` | Shows each open task as a job in the FleetView of [pi-subagents](https://pi.dev/packages/pi-subagents): running, completed, failed, or stopped when it needs you or was stopped. See `addons/subagents/README.md`. |
| `addons/pstack-principles` | A principle set: the chef and every cook work by the principles of [pstack](https://github.com/cursor/plugins/tree/main/pstack), the agent plugin by Lauren Tan. Each gets the always-on rules of its role and an index of the 24 vendored principle files in its system prompt. See `addons/pstack-principles/README.md`. |

Pi git sources take no subdirectory, so install an add-on from a local path, for example from the checkout that `pi install git:github.com/bpauli/pi-chef` made:

```sh
pi install ~/.pi/agent/git/github.com/bpauli/pi-chef/addons/herdr
pi install ~/.pi/agent/git/github.com/bpauli/pi-chef/addons/pstack-principles
```

A principle set is your choice of how the chef and the cooks work. chef has no principle set of its own and no default. pstack is the first set. Install one set. Another set can follow the same contract (see `docs/design.md`, "Principle sets").

## Configuration

The kitchen lives in `<pi agent dir>/chef` (usually `~/.pi/agent/chef`). Set `CHEF_HOME` to move it. An optional `config.json` in the kitchen:

```json
{
  "maxCooks": 3,
  "models": {
    "rules": [
      {
        "name": "deep",
        "when": "architecture, a hard bug, or a change across many files",
        "use": [{ "model": "anthropic/claude-opus-5-5", "thinking": "high" }, { "model": "openai/gpt-6-astra", "thinking": "high" }],
        "why": "these tasks need the strongest judgment"
      },
      {
        "name": "small",
        "when": "a typo, a docs edit, or a one-line fix",
        "use": { "model": "anthropic/claude-haiku-5" }
      }
    ],
    "default": [{ "model": "anthropic/claude-sonnet-5-5", "thinking": "medium" }, { "model": "openai/gpt-6-astra" }]
  },
  "cookArgs": ["--no-skills"]
}
```

Every field is optional. `maxCooks` caps the cooks that run at once (default 3). `cookArgs` are extra `pi` arguments for every cook.

`models` tells the chef which cook models to use. Each entry is a `provider/id` model and an optional `thinking` level. `use` and `default` take one entry or a list in order of preference.

- `rules` are for kinds of tasks. The chef reads each rule's `name`, `when`, and `why` in its system prompt, and picks the rule that fits the task best when it dispatches. Rule names are lowercase letters, digits, and dashes, and are unique.
- `default` is for tasks that no rule fits. A rule's models are followed by the default list.

At dispatch, the chef skips a model that Pi does not know or that has no credentials, and says so. The remaining list is fixed for the task. `chef_dispatch` can also set a model per task, which goes first.

When a model call fails with a provider error after Pi's own retries (for example `402: This request requires more credits`), the cook continues at once on the next model of its list, in the same session. The chef is not woken for that run. Its next kitchen update for the task says which model failed and why. When every model failed, the chef is woken with each model and its error.

The older form `{ "model": "openai/gpt-6-astra", "thinking": "medium" }` still works. It is the same as a default list of one.

The kitchen is plain files. `tasks/<id>/task.json` is the task, `runs/<n>.jsonl` is the cook's full Pi stream for run `n`, `log.jsonl` holds the chef's decisions, and `inbox/` holds messages to the cook. No task state is stored; chef derives it from these files and the live processes on every tick. See `docs/design.md` for the contract and `CONTEXT.md` for the words.

## How pi-chef differs from firstmate

[firstmate](https://github.com/kunchenguid/firstmate) is an agent distro: a repository of bash tools, skills, and a long `AGENTS.md` that turns any coding agent CLI into a supervisor, with workers in tmux windows and a bash watcher that wakes the supervisor through the harness's hook. chef is a Pi package. The differences follow from that:

- Pi only, both sides. The chef is a Pi session with seven tools. Cooks are `pi --mode json -p` processes. No tmux, no pane scraping, no per-harness wiring.
- One process model. Cooks are detached child processes. The chef finds them by a marker in their environment and reads their Pi JSONL stream. There is no watcher process; the chef session runs a one-second tick.
- Derived state. firstmate keeps status logs, meta files, busy records, and a wake queue. chef stores no task state. Every state is derived from the task's files and the live processes, so a restart is the first tick, not a recovery routine.
- One writer per file. The cook never writes a chef file. Its report is a tool call in its own transcript.
- Small. About 3k lines of TypeScript plus tests, against firstmate's 122k lines of bash and a 6.9k-word supervisor contract.
- Less. No backlog, no project modes, no merge automation, no scouts, no remote workers. A brief can tell a cook to run `gh`. Everything else is the chef's judgment, written in one short skill.

## Development

```sh
npm install          # dev dependencies, including a pinned pi 1.0.3 for the tests
npm run typecheck    # tsc --noEmit, strict
npm test             # node --test: unit, git, and e2e tests on the fake model
npm run check        # both
pi -e ./extension/index.ts --chef   # try it in a real Pi session
```

The tests need no network and no credentials. The e2e tests start real Pi processes on `test/fake-model/`, a scripted local model: a brief holds `STEP` lines, and the fake model plays them. `node test/fixtures/record.mjs` re-records the Pi stream fixtures for the unit tests.

## License

MIT, see `LICENSE`. The vendored pstack principles in `addons/pstack-principles/principles/` keep their own MIT license, see `addons/pstack-principles/principles/LICENSE`.
