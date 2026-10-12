import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SUPERPOWERS_DIR, SUPERPOWERS_RULES, SUPERPOWERS_SKILLS, loadSkills, superpowersBlock } from "../superpowers.ts";

const ROLES = ["chef", "cook"] as const;
const vendored = (): string[] =>
  readdirSync(SUPERPOWERS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

test("each role's block starts with a heading that names the superpowers recipe", () => {
  const skills = loadSkills();
  for (const role of ROLES) assert.equal(superpowersBlock(role, skills).split("\n")[0], "# Recipe: superpowers", role);
});

test("no role's block has an em dash or an en dash, although a vendored description has one", () => {
  assert.match(readFileSync(join(SUPERPOWERS_DIR, "executing-plans", "SKILL.md"), "utf8"), /^description: .*\u2014/m, "the vendored description has an em dash");
  const skills = loadSkills();
  for (const role of ROLES) assert.doesNotMatch(superpowersBlock(role, skills), /[\u2014\u2013]/, role);
});

test("each role's index lists its own vendored skills with description and an existing path, and no skill of the other role only", () => {
  const skills = loadSkills();
  assert.deepEqual(skills.map((s) => s.name), vendored());
  for (const role of ROLES) {
    const lines = superpowersBlock(role, skills).split("\n");
    for (const skill of skills) {
      const line = lines.find((l) => l.includes(skill.path));
      if (SUPERPOWERS_SKILLS[role].includes(skill.name)) {
        assert.ok(existsSync(skill.path), skill.path);
        assert.ok(line?.startsWith(`- ${skill.name}: ${skill.description}`) && line.endsWith(` File: ${skill.path}`), `${role} index line for ${skill.name}: ${line}`);
      } else {
        assert.equal(line, undefined, `${role} index leaves out ${skill.name}`);
      }
    }
  }
  const parallel = join(SUPERPOWERS_DIR, "dispatching-parallel-agents", "SKILL.md");
  assert.ok(
    superpowersBlock("chef", skills).includes(`- dispatching-parallel-agents: Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies. File: ${parallel}\n`),
    "a description without a final period gets one",
  );
  const cook = superpowersBlock("cook", skills);
  assert.ok(cook.includes(join(SUPERPOWERS_DIR, "test-driven-development", "SKILL.md")), "a cook gets test-driven-development");
  assert.ok(!cook.includes(join(SUPERPOWERS_DIR, "brainstorming", "SKILL.md")), "a cook never gets brainstorming, which asks the human");
});

test("every vendored skill is in a role's index, and every skill a rule names is vendored and in that role's index", () => {
  const names = vendored();
  assert.deepEqual([...new Set([...SUPERPOWERS_SKILLS.chef, ...SUPERPOWERS_SKILLS.cook])].sort(), names);
  for (const role of ROLES) {
    const block = superpowersBlock(role, loadSkills());
    for (const rule of SUPERPOWERS_RULES[role]) {
      assert.ok(block.includes(rule.text), `${role} block has: ${rule.text}`);
      for (const skill of rule.skills) assert.ok(SUPERPOWERS_SKILLS[role].includes(skill) && names.includes(skill), `${role} rule names ${skill}`);
    }
    const other = role === "chef" ? "cook" : "chef";
    for (const rule of SUPERPOWERS_RULES[other]) assert.ok(!block.includes(rule.text), `${role} block lacks the ${other} rule: ${rule.text}`);
  }
});

test("loadSkills refuses a SKILL.md without a description and names the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "chef-superpowers-"));
  try {
    mkdirSync(join(dir, "good"));
    writeFileSync(join(dir, "good", "SKILL.md"), "---\nname: good\ndescription: Use always\n---\n\n# Good\n");
    writeFileSync(join(dir, "LICENSE"), "MIT\n");
    assert.deepEqual(loadSkills(dir), [{ name: "good", description: "Use always", path: join(dir, "good", "SKILL.md") }]);
    mkdirSync(join(dir, "bad"));
    writeFileSync(join(dir, "bad", "SKILL.md"), "---\nname: bad\n---\n\n# Bad\n");
    assert.throws(() => loadSkills(dir), /bad\/SKILL\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
