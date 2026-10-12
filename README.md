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
| `chef_add_project` | Registers a git repository. Tasks fork from its base branch. |
| `chef_dispatch` | Creates a task and launches a cook, or queues it behind the cook limit. |
| `chef_board` | Projects, open tasks with state and activity, cook count. |
| `chef_send` | One verb for steer, answer, and resume. A cooking cook reads the message after its current tool call. An idle task restarts on the same Pi session with it. |
| `chef_stop` | Stops a cook, or holds a queued task. The worktree and branch stay. |
| `chef_result` | Outcome, summary, branch, commits ahead of base, landed or not, worktree clean or dirty, diffstat, transcript path. |
| `chef_close` | Removes the worktree and closes the task. Refuses dirty or unlanded work unless `discard: true`. Deletes the branch only when the base branch contains it. |

The `/chef` command takes `on` (default), `off`, `takeover`, and `board`. One chef session owns the kitchen at a time. A second session opens read-only and can show the board and results. `/chef takeover` moves the kitchen to the current session.

Each task has a worktree under the kitchen on branch `chef/<task id>`. Review the work there with `read` and `bash`, merge or push it as you like, then `chef_close` the task.

When you run the chef inside herdr, the chef opens a tab named `cook <task id>` for each cook when it starts cooking. The tab shows what the cook does as it does it: its text, each tool call, a short tail of the tool output, errors, and its report. The herdr sidebar shows the state of each cook: working, blocked (it needs you), or idle. The tab is for watching only. Talk to the chef to steer a cook. When you close a tab, it stays closed until the next run of that task. `chef_close` closes the tab. Outside herdr, chef opens no tabs.

## Configuration

The kitchen lives in `<pi agent dir>/chef` (usually `~/.pi/agent/chef`). Set `CHEF_HOME` to move it. An optional `config.json` in the kitchen:

```json
{
  "maxCooks": 3,
  "model": "anthropic/claude-sonnet-5-5",
  "thinking": "medium",
  "cookArgs": ["--no-skills"]
}
```

Every field is optional. `maxCooks` caps the cooks that run at once (default 3). `model` and `thinking` apply to every cook; `chef_dispatch` can set a model per task. `cookArgs` are extra `pi` arguments for every cook.

The kitchen is plain files. `tasks/<id>/task.json` is the task, `runs/<n>.jsonl` is the cook's full Pi stream for run `n`, `log.jsonl` holds the chef's decisions, and `inbox/` holds messages to the cook. No task state is stored; chef derives it from these files and the live processes on every tick. See `docs/design.md` for the contract and `CONTEXT.md` for the words.

## Principles

The chef and every cook work by the principles of [pstack](https://github.com/cursor/plugins/tree/main/pstack), the agent plugin by Lauren Tan. chef vendors the 24 `principle-*` skills from pstack into `principles/`, under pstack's MIT license (`principles/LICENSE`). `principles/SOURCE.md` names the upstream commit.

chef adds a principles block to the system prompt of two roles:

- A cook gets the cook rules, for example "reproduce a bug first and fix the root cause" and "verify on the real artifact before you report done".
- The chef gets the chef rules, for example "every brief names the check that proves done" and "a cook's report is not proof". The chef gets the block only while chef mode is on.

Each block also has an index of all 24 principles: the name, when the principle applies, and the absolute path of its file. The model reads a file in full before it applies that principle. A normal Pi session gets no block, and the vendored files are not listed as skills.

To update the vendored files, clone [cursor/plugins](https://github.com/cursor/plugins) and run:

```sh
node tools/sync-pstack.mjs <path to the cursor/plugins checkout>
```

The script replaces the vendored principles, copies the license, and writes `principles/SOURCE.md`. A second run changes nothing. Do not edit the files in `principles/` by hand.

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

MIT, see `LICENSE`. The vendored pstack principles in `principles/` keep their own MIT license, see `principles/LICENSE`.
