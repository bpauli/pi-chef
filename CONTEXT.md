# chef ubiquitous language

Use these words in code, docs, tool text, and commit messages. One word means one thing.

| Term | Meaning | Owner in code |
|---|---|---|
| chef | The main Pi session in chef mode. The human talks only to the chef. The chef splits work into tasks, dispatches them, answers or escalates cook questions, reviews results, and closes tasks. | `extension/chef.ts` |
| chef mode | The state of a Pi session that has the chef tools active and owns or watches the kitchen. Turned on with `pi --chef` or `/chef`. A normal Pi session is not in chef mode and sees no chef tools. | `extension/chef.ts` |
| kitchen | The directory on disk that holds all chef state: projects, tasks, runs, inboxes, worktrees, config, and the lease. Default `<pi agent dir>/chef`, override with `CHEF_HOME`. | `extension/store.ts` |
| lease | The file `pass.lock` that names the one chef session that owns the kitchen. A dead holder makes the lease stale, and the next chef takes it. | `extension/kitchen.ts` |
| owner | The chef session that holds the lease. Only the owner launches cooks, writes task logs, and receives wakes. | `extension/kitchen.ts` |
| read-only session | A chef-mode session that does not hold the lease. It can show the board and results. It cannot change the kitchen. | `extension/kitchen.ts` |
| project | A git repository that the human registered with the chef. Tasks fork from its base branch. | `extension/store.ts` |
| task | One unit of work for one project, with a title and a brief. A task has its own worktree, its own branch `chef/<task id>`, and its own Pi session. Task ids look like `api-7`. | `extension/domain.ts` |
| brief | The instructions for a task, written by the chef. It says the intent, what done means, and how to deliver. | `extension/domain.ts` |
| cook | A child Pi process that works on one task. A cook runs detached, so it can outlive the chef session. | `extension/cooks.ts` |
| run | One cook process lifetime for a task. A task has one or more runs. Run `n` writes `runs/<n>.jsonl`. A later run continues the same Pi session. | `extension/store.ts` |
| report | The cook's structured status, given with the `chef_report` tool at the end of a run: `done`, `needs_decision`, `blocked`, or `failed`, with a summary. | `extension/cook.ts` |
| outcome | How a finished run ended, derived from the run file: done, needs decision, blocked, failed, or stopped. | `extension/derive.ts` |
| task state | `queued`, `cooking`, `idle` (with an outcome), or `closed`. Always derived from files and live processes. Never stored. | `extension/derive.ts` |
| inbox | The directory of messages from the chef to one task. A cooking cook takes them mid-run. An idle task gets them as the prompt of its next run. | `extension/store.ts` |
| wake | One `chef-wake` message that tells the chef about one or more new outcomes and starts a chef turn. | `extension/chef.ts` |
| board | The view of all open tasks: state, current activity, and age. Shown as a widget, by `/chef`, and by `chef_board`. | `extension/derive.ts` |
| tick | One pass of the reconcile loop: read files and processes, derive task states, plan actions, run them. Startup reconciliation is the first tick. | `extension/kitchen.ts` |
| principle | One pstack working rule, vendored as `principles/<name>/SKILL.md`. The chef and each cook get a principles block in the system prompt: the always-on rules of the role and an index of every principle with the path of its file. A normal Pi session gets none. | `extension/principles.ts` |
| landed | A task's commits are reachable from the project base branch or from a remote-tracking ref as of the last fetch. `chef_close` removes a worktree only when its work is landed or the caller discards it, and deletes the task branch only when the base branch contains it. | `extension/git.ts` |
