import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PSTACK_PRINCIPLES_DIR, PSTACK_RULES, loadPrinciples, principlesBlock } from "../principles.ts";

const ROLES = ["chef", "cook"] as const;

test("the principle index in each role's block lists every vendored principle with its description and a path that exists", () => {
  const dirs = readdirSync(PSTACK_PRINCIPLES_DIR).filter((d) => d.startsWith("principle-")).sort();
  assert.ok(dirs.length > 0, "principles are vendored");
  const principles = loadPrinciples(PSTACK_PRINCIPLES_DIR);
  for (const role of ROLES) {
    const lines = principlesBlock(role, principles).split("\n");
    for (const dir of dirs) {
      const path = join(PSTACK_PRINCIPLES_DIR, dir, "SKILL.md");
      assert.ok(existsSync(path));
      const description = /^description: "(.*)"$/m.exec(readFileSync(path, "utf8"))?.[1];
      assert.ok(description, `${dir} has a quoted description`);
      const line = lines.find((l) => l.includes(path));
      assert.ok(line, `${role} index names ${path}`);
      assert.ok(line.includes(dir) && line.includes(description), `${role} index line for ${dir}: ${line}`);
    }
  }
});

test("each role's block starts with a heading that names the pstack recipe", () => {
  const principles = loadPrinciples(PSTACK_PRINCIPLES_DIR);
  for (const role of ROLES) assert.equal(principlesBlock(role, principles).split("\n")[0], "# Recipe: pstack", role);
});

test("each role's block carries its own rules, none of the other role's, and every principle a rule cites is in the index", () => {
  const principles = loadPrinciples(PSTACK_PRINCIPLES_DIR);
  const names = new Set(principles.map((p) => p.name));
  for (const role of ROLES) {
    const other = role === "chef" ? "cook" : "chef";
    const block = principlesBlock(role, principles);
    for (const rule of PSTACK_RULES[role]) {
      assert.ok(block.includes(rule.text), `${role} block has: ${rule.text}`);
      for (const cited of rule.principles) assert.ok(names.has(cited), `${cited} is vendored`);
    }
    for (const rule of PSTACK_RULES[other]) assert.ok(!block.includes(rule.text), `${role} block lacks the ${other} rule: ${rule.text}`);
  }
});

test("loadPrinciples refuses a SKILL.md without a description and names the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "chef-principles-"));
  try {
    mkdirSync(join(dir, "principle-good"));
    writeFileSync(join(dir, "principle-good", "SKILL.md"), '---\nname: principle-good\ndescription: "Apply always."\n---\n\n# Good\n');
    assert.deepEqual(loadPrinciples(dir), [{ name: "principle-good", description: "Apply always.", path: join(dir, "principle-good", "SKILL.md") }]);
    mkdirSync(join(dir, "principle-bad"));
    writeFileSync(join(dir, "principle-bad", "SKILL.md"), "---\nname: principle-bad\n---\n\n# Bad\n");
    assert.throws(() => loadPrinciples(dir), /principle-bad\/SKILL\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
