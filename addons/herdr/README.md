# pi-chef-herdr

An optional add-on for [pi-chef](../../README.md). When the chef runs inside herdr, it opens one herdr tab named `cook <task id>` for each cook when it starts cooking. The tab runs the chef viewer, which shows what the cook does: its text, each tool call, a short tail of the tool output, errors, and its report. The herdr sidebar shows the state of each cook: working, blocked (it needs you), or idle.

The tab is for watching only. Talk to the chef to steer a cook. When you close a tab, it stays closed until the next run of that task. The viewer exits when the task is closed, and herdr then closes the tab.

## Install

Install pi-chef first. Then install this directory as a local package:

```sh
pi install <path to pi-chef>/addons/herdr
```

Pi git sources take no subdirectory, so use the local path. When you installed pi-chef from git, the checkout is under your Pi agent directory, for example `~/.pi/agent/git/github.com/bpauli/pi-chef/addons/herdr`.

## How it works

The add-on reads the cooks snapshot that pi-chef emits on `pi.events` (`pi-chef:cooks:v1`, see `docs/design.md`, "Integration events"). It does nothing outside herdr (`HERDR_ENV=1` and `HERDR_WORKSPACE_ID` must be set) and nothing in a read-only chef session. It keeps its tab records in memory only, and adopts the existing `cook <id>` tabs after a restart. A herdr error shows as a notification once, and never stops the chef.
