# pi-chef-superpowers-principles

An optional principle set for [pi-chef](../../README.md), with the name `superpowers`. With it, the chef and every cook work by the skills of [superpowers](https://github.com/obra/superpowers) by Jesse Vincent. The add-on vendors 10 of the 15 superpowers skills into `principles/`, each skill directory as upstream has it, under the MIT license of superpowers (`principles/LICENSE`, Copyright (c) 2025 Jesse Vincent). `principles/SOURCE.md` names the upstream commit.

The add-on adds a block with the heading `# Principles: superpowers` to the system prompt of two roles:

- A cook gets the implementation skills, for example "write the failing test first and watch it fail" and "find the root cause before you change code". The block follows the cook contract. Where a skill tells the agent to ask its human partner, the block tells the cook to decide a reversible choice itself or to report `needs_decision`, because no human watches a cook.
- The chef gets the planning and orchestration skills, for example "find out what the human wants before you dispatch" and "a cook's done report is not proof". For the chef, a `chef_dispatch` with a complete brief is the subagent dispatch of the skills. The chef gets the block only while chef mode is on.

Each block has the always-on rules of its role, and an index of the skills of that role: the name, when the skill applies, and the absolute path of its file. The model reads a file in full before it applies that skill. A normal Pi session gets no block, and the vendored files are not listed as skills.

## Chosen skills

The chef and the cook contract decide what fits. A cook never waits for a human, the chef owns the worktrees and the landing of branches, and a meta skill about the skill system is not a working principle.

| Skill | Role | Why |
|---|---|---|
| brainstorming | chef | The human talks only to the chef, so only the chef can ask what the human wants. A cook would wait for an answer that never comes. |
| dispatching-parallel-agents | chef | The chef dispatches one cook per independent problem. |
| executing-plans | cook | A cook that gets a plan in its brief works through it alone. The block tells it to skip the worktree setup and the branch finish. |
| receiving-code-review | cook | A correction from the chef comes to the cook as a message. The cook checks it against the code before it applies it. |
| requesting-code-review | chef | The chef reviews each done task against its brief, or dispatches a review task with the reviewer template. |
| subagent-driven-development | chef | The chef runs a plan as one task per cook, with a full brief and a review of each result. The kitchen replaces the workspace scripts, the worktree setup, and the finish step of the skill. |
| systematic-debugging | cook | A cook finds the root cause before it fixes. After three failed fixes it reports `blocked` instead of a talk with the human. |
| test-driven-development | cook | A cook writes the failing test first. |
| verification-before-completion | chef, cook | A cook verifies before it reports `done`. The chef does not trust a done report without the evidence. |
| writing-plans | chef | The chef writes the plan, then dispatches its tasks. The plan goes into the reply or a brief, not into a project checkout. |
| diagnosing-superpowers | none | A meta skill that debugs superpowers sessions. It is not a working principle. |
| finishing-a-development-branch | none | It merges, pushes, or discards the branch and asks the human which. In pi-chef the brief sets the delivery, and `chef_close` removes the worktree. |
| using-git-worktrees | none | The chef creates the worktree of each task. A cook works only in its own worktree. |
| using-superpowers | none | A meta skill that tells the agent how to find and load superpowers skills in its harness. The block replaces it. |
| writing-skills | none | A meta skill for the authors of skills. It is not a working principle. |

executing-plans, subagent-driven-development, writing-plans, and `test-driven-development/writing-good-tests.md` link to skills that are not vendored (using-git-worktrees, finishing-a-development-branch, using-superpowers). The links stay as upstream wrote them. The rules in the block tell the model to skip those steps.

The add-on duplicates the small loader and block builder of the pstack add-on instead of an import from it, so that each add-on installs alone.

## Install

Install pi-chef first. Then install this directory as a local package:

```sh
pi install <path to pi-chef>/addons/superpowers-principles
```

Pi git sources take no subdirectory, so use the local path. When you installed pi-chef from git, the checkout is under your Pi agent directory, for example `~/.pi/agent/git/github.com/bpauli/pi-chef/addons/superpowers-principles`.

Cooks load your installed Pi packages, so each cook also loads this add-on. When you also installed another set, select one in the kitchen `config.json`, for example `"principles": "superpowers"`, or per project with `"principles": { "default": "pstack", "projects": { "obsync": "superpowers" } }`. Without a selection, every installed set adds its block.

## How it works

At the start of each turn, the add-on asks pi-chef for the role of its Pi process with the role query on `pi.events` (`pi-chef:role:v1`, see `docs/design.md`, "Integration events"). For `chef` or `cook` it appends that role's block to the system prompt, unless the answer selects another set or `none`. For no role it adds nothing. It answers the set discovery event (`pi-chef:principle-sets:v1`) with `superpowers`.

## Update the vendored skills

Clone [obra/superpowers](https://github.com/obra/superpowers). Then, from the pi-chef checkout, run:

```sh
node addons/superpowers-principles/sync-superpowers.mjs <path to the superpowers checkout>
```

The script replaces the vendored skills with the chosen skills, copies the license, and writes `principles/SOURCE.md`. A second run changes nothing. It refuses a checkout that lacks a chosen skill. To change the choice, edit the list in the script, the role lists in `superpowers.ts`, and the table above together; a test fails when the script and the role lists differ. Do not edit the files in `principles/` by hand.

## License

MIT. The vendored superpowers skills in `principles/` keep their own MIT license, see `principles/LICENSE`.
