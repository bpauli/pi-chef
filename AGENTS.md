# AGENTS.md

pi-chef is a Pi package. One chef session dispatches and monitors cooks (child Pi processes) across projects and tasks. Read `CONTEXT.md` for the terms and `docs/design.md` for the contract before you change code.

## Commands

```sh
npm install          # dev dependencies, including a pinned pi 1.0.3 for tests
npm run typecheck    # tsc --noEmit, strict
npm test             # node --test: unit, git, and offline e2e tests with the fake model
CHEF_TEST_PI=$(readlink -f $(which pi)) node --test test/chef.test.ts   # chef e2e on an installed Pi binary
npm run check        # both
pi -e ./extension/index.ts --chef   # try it in a real Pi session
node addons/recipe-pstack/sync-pstack.mjs <cursor/plugins checkout>   # update the vendored pstack principles
node addons/recipe-superpowers/sync-superpowers.mjs <obra/superpowers checkout>   # update the vendored superpowers skills
node scripts/release-preflight.mjs v<version>   # check versions and CHANGELOG.md before you tag a release
npm run pack:check   # pack each npm package, check its files, and load it in Pi from the tarball
```

The e2e tests start real Pi processes on `test/fake-model/`, a scripted local model. They need no network and no credentials.

## Rules

- Keep one writer per kitchen file (`docs/design.md`, "Files and writers"). A new file gets one owner.
- Never store task state. Derive it in `extension/derive.ts`.
- Parse every external line (kitchen files, run files, tool parameters) with typebox at the boundary. Inside, trust the types.
- `extension/kitchen.ts` imports no Pi types. Pi wiring lives in `extension/chef.ts` and `extension/cook.ts`.
- Add-on code in `addons/` (not its tests) imports only types from `extension/` (`import type`). Each one that reads the cooks snapshot parses it with typebox.
- All chef tool names start with `chef_`. pstack's Pi extension owns `agent`, `send_message`, `list_agents`, and `stop_agent`.
- Name tests after the behavior they prove. A test must fail when that behavior breaks.
- Comments only for a non-obvious why.
- No em dash or en dash anywhere. Use a plain dash.

## Principles

This repo follows the [pstack](https://github.com/cursor/plugins/tree/main/pstack) principles. Each one below has a concrete rule here. Before you apply one, read its file in `addons/recipe-pstack/principles/principle-<name>/SKILL.md`, for example `addons/recipe-pstack/principles/principle-model-the-domain/SKILL.md`. These files are vendored for the optional pstack recipe add-on, one recipe for chef users. This repo's own development follows them too. Do not edit them. To update them, rerun `addons/recipe-pstack/sync-pstack.mjs` (see `addons/recipe-pstack/README.md`).

| Principle | Rule in this repo |
|---|---|
| Model the domain | Task state and outcome are derived unions in `extension/derive.ts`. Add a variant, not a boolean. |
| Type system discipline | One discriminated field per state (`claim`, `verdict`, results of `claimRun` and `acquireLease`). Brand ids. No cast that silences the compiler. |
| Boundary discipline | Kitchen files, run-file lines, and tool parameters are parsed with typebox at the edge. Inside, trust the types. Git refs pass `--end-of-options`. |
| Separate before serializing shared state | One writer per kitchen file. The cook writes no chef file. Every kitchen mutation runs on the one serialized chain, lease check first. |
| Make operations idempotent | The tick converges from any crash point. Startup reconciliation is the first tick, not a separate path. A launch claims its run file with O_EXCL. |
| Foundational thinking | Name the data shape before the logic. Change `docs/design.md` in the same commit as a rule change. |
| Laziness protocol | Smallest change, flat call chains: tool, then `kitchen.ts`, then one module. No new layer without a deleted branch. |
| Test behavior, not implementation | Reproduce a defect with a failing test first. Name the test after the behavior it proves. |
| Build the lever | The fake model (`test/fake-model/`) drives real Pi processes offline. Prove a Pi behavior with a probe, not a guess. |
| Prove it works | Check the real artifact: `npm run check`, plus the chef e2e on an installed Pi binary for launch or lifecycle changes. |

## Commits

Small, single-purpose commits. The message says what changed and why, and names the checks you ran.
