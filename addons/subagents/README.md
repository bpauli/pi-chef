# pi-chef-subagents

An optional add-on for [pi-chef](../../README.md). It shows the chef's cooks in the FleetView of [pi-subagents](https://pi.dev/packages/pi-subagents), next to the subagents of the same Pi session. Each open task is one external job, labeled `<task id> <title>`:

| Task | FleetView state | Current action | Preview |
|---|---|---|---|
| queued | queued | `queued` | |
| cooking | running | the cook's activity, for example `bash: npm test` | |
| idle, done | completed | `done: <summary>` | the summary |
| idle, failed | failed | `failed: <reason>` | the reason |
| idle, needs decision or blocked | stopped | `needs decision: <question>` or `blocked: <reason>` | the question or reason |
| idle, stopped | stopped | `stopped` | |

The job also names the transcript path of the current or last run. FleetView jobs from another extension are display-only: steer, answer, and stop cooks through the chef. A closed task leaves FleetView, and so do all cooks when chef mode turns off.

## Install

Install pi-chef and pi-subagents first. Then install this directory as a local package:

```sh
pi install <path to pi-chef>/addons/subagents
```

Pi git sources take no subdirectory, so use the local path. When you installed pi-chef from git, the checkout is under your Pi agent directory, for example `~/.pi/agent/git/github.com/bpauli/pi-chef/addons/subagents`.

## How it works

The add-on reads the cooks snapshot that pi-chef emits on `pi.events` (`pi-chef:cooks:v1`, see `docs/design.md`, "Integration events"), in owner and read-only chef sessions. It finds pi-subagents in `<project>/.pi/npm/node_modules` or `<Pi agent dir>/npm/node_modules`, and calls `registerExternalRun`, `updateExternalRun`, and `unregisterExternalRun` from `pi-subagents/external-runs`. Without pi-subagents it does nothing and says so once.
