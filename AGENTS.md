# AGENTS.md

chef is a Pi package. One chef session dispatches and monitors cooks (child Pi processes) across projects and tasks. Read `CONTEXT.md` for the terms and `docs/design.md` for the contract before you change code.

## Commands

```sh
npm install          # dev dependencies, including a pinned pi 1.0.3 for tests
npm run typecheck    # tsc --noEmit, strict
npm test             # node --test: unit, git, and offline e2e tests with the fake model
CHEF_TEST_PI=$(readlink -f $(which pi)) node --test test/chef.test.ts   # chef e2e on an installed Pi binary
npm run check        # both
pi -e ./extension/index.ts --chef   # try it in a real Pi session
```

The e2e tests start real Pi processes on `test/fake-model/`, a scripted local model. They need no network and no credentials.

## Rules

- Keep one writer per kitchen file (`docs/design.md`, "Files and writers"). A new file gets one owner.
- Never store task state. Derive it in `extension/derive.ts`.
- Parse every external line (kitchen files, run files, tool parameters) with typebox at the boundary. Inside, trust the types.
- `extension/kitchen.ts` imports no Pi types. Pi wiring lives in `extension/chef.ts` and `extension/cook.ts`.
- All chef tool names start with `chef_`. pstack's Pi extension owns `agent`, `send_message`, `list_agents`, and `stop_agent`.
- Name tests after the behavior they prove. A test must fail when that behavior breaks.
- Comments only for a non-obvious why.
- No em dash or en dash anywhere. Use a plain dash.

## Commits

Small, single-purpose commits. The message says what changed and why, and names the checks you ran.
