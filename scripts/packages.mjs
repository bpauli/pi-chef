// The npm packages of this repo, with the files each tarball must ship.
export const PACKAGES = [
  { dir: ".", must: ["LICENSE", "README.md", "package.json", "extension/index.ts", "extension/watch.mjs", "skills/chef/SKILL.md"] },
  { dir: "addons/herdr", must: ["LICENSE", "README.md", "package.json", "index.ts", "herdr.ts"] },
  { dir: "addons/subagents", must: ["LICENSE", "README.md", "package.json", "index.ts", "fleet.ts"] },
  { dir: "addons/recipe-pstack", must: ["LICENSE", "README.md", "package.json", "index.ts", "principles.ts", "principles/LICENSE"] },
  { dir: "addons/recipe-superpowers", must: ["LICENSE", "README.md", "package.json", "index.ts", "superpowers.ts", "principles/LICENSE"] },
];
