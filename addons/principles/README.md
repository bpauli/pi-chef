# pi-chef-principles

An optional add-on for [pi-chef](../../README.md). With it, the chef and every cook work by the principles of [pstack](https://github.com/cursor/plugins/tree/main/pstack), the agent plugin by Lauren Tan. The add-on vendors the 24 `principle-*` skills from pstack into `principles/`, under pstack's MIT license (`principles/LICENSE`). `principles/SOURCE.md` names the upstream commit.

The add-on adds a principles block to the system prompt of two roles:

- A cook gets the cook rules, for example "reproduce a bug first and fix the root cause" and "verify on the real artifact before you report done". The block follows the cook contract.
- The chef gets the chef rules, for example "every brief names the check that proves done" and "a cook's report is not proof". The chef gets the block only while chef mode is on.

Each block also has an index of all 24 principles: the name, when the principle applies, and the absolute path of its file. The model reads a file in full before it applies that principle. A normal Pi session gets no block, and the vendored files are not listed as skills.

## Install

Install pi-chef first. Then install this directory as a local package:

```sh
pi install <path to pi-chef>/addons/principles
```

Pi git sources take no subdirectory, so use the local path. When you installed pi-chef from git, the checkout is under your Pi agent directory, for example `~/.pi/agent/git/github.com/bpauli/pi-chef/addons/principles`.

Cooks load your installed Pi packages, so each cook also loads this add-on. To give the principles only to cooks of one kitchen, do not install the add-on. Put `"cookArgs": ["-e", "<path to pi-chef>/addons/principles/index.ts"]` in the kitchen `config.json` instead.

## How it works

At the start of each turn, the add-on asks pi-chef for the role of its Pi process with the role query on `pi.events` (`pi-chef:role:v1`, see `docs/design.md`, "Integration events"). For `chef` or `cook` it appends that role's block to the system prompt. For no role it adds nothing. Because it asks at each turn, `/chef` and `/chef off` change the next turn.

## Update the vendored principles

Clone [cursor/plugins](https://github.com/cursor/plugins). Then, from the pi-chef checkout, run:

```sh
node addons/principles/sync-pstack.mjs <path to the cursor/plugins checkout>
```

The script replaces the vendored principles, copies the license, and writes `principles/SOURCE.md`. A second run changes nothing. Do not edit the files in `principles/` by hand.

## License

MIT. The vendored pstack principles in `principles/` keep their own MIT license, see `principles/LICENSE`.
