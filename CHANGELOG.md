# Changelog

Each release has one section `## <version>`. The release workflow uses the section text as the notes of the GitHub release. Write the section before you push the tag.

## Unreleased

### Added

- pi-chef and its four add-ons are npm packages: `pi install npm:pi-chef`, and `pi install npm:pi-chef-herdr` for an add-on. The Release workflow publishes them through npm Trusted Publishing. The `pi-package` keyword lists them in the pi.dev package gallery.

### Changed

- The viewer is now `extension/watch.mjs` (it was `watch.ts`), so it runs from `node_modules` after an npm install. Run it as `node <path to pi-chef>/extension/watch.mjs <task dir>`.

## 0.1.1

### Fixed

- Cooks are identified by their stdout run file instead of an environment marker, so chef finds its cooks on macOS, where Pi's process title hides the environment from `ps -E` (#2). macOS needs `lsof`, which ships with the system.
- The kitchen checks liveness before it reads the run files. Before, a cook that exited between the two reads could get a false "cook exited before settling" notice, and `chef_send` could answer `queued` for a cook that was relaunched on the next tick.

## 0.1.0

The first release.

### Chef and cooks

- `pi --chef` or `/chef` turns a Pi session into the chef. A normal Pi session has no chef tools and no chef state.
- Seven chef tools: `chef_add_project`, `chef_dispatch`, `chef_board`, `chef_send`, `chef_stop`, `chef_result`, and `chef_close`.
- A cook is a detached `pi --mode json -p` process in its own git worktree and branch. It ends each run with one `chef_report`: done, needs decision, blocked, or failed.
- A one-second tick launches queued cooks, derives each task state from the kitchen files and the live processes, and wakes the chef with one kitchen update. No task state is stored, so a restart is the first tick.
- One chef session owns the kitchen. A second session is read-only until `/chef takeover`, or until the owner ends.
- `chef_close` refuses dirty or unlanded work unless `discard: true`, and deletes a branch only when the base branch contains it.
- Task branches are `<branchPrefix><task id>`. The prefix is set per project and is `issue/` by default.
- A board widget below the editor shows each open task, its state, its model, what the cook does now, and its age.
- `extension/watch.ts` follows one cook live in a terminal.

### Cook models

- `models.rules` in `config.json` name kinds of tasks with the models to use. The chef picks the rule that fits each task. `models.default` is for the other tasks.
- The chef skips a model that Pi does not know or that has no credentials. The remaining list is fixed per task.
- After a provider error, the cook continues on the next model of its list in the same session. The chef is woken only when every model failed.

### Add-ons and recipes

- The cooks snapshot (`pi-chef:cooks:v1`), the role query (`pi-chef:role:v1`), and recipe discovery (`pi-chef:recipes:v1`) on Pi's in-process event bus.
- `addons/herdr` opens a herdr tab per cooking task and shows each cook's state in the herdr sidebar.
- `addons/subagents` shows each open task as a job in the FleetView of pi-subagents.
- `addons/recipe-pstack` and `addons/recipe-superpowers` are recipes. Select one in `config.json` with `recipe`, as a default and per project.
