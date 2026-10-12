import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const SUPERPOWERS_DIR = fileURLToPath(new URL("./principles", import.meta.url));

const FrontmatterSchema = Type.Object({ name: Type.String({ minLength: 1 }), description: Type.String({ minLength: 1 }) });

export interface Skill {
  name: string;
  description: string;
  path: string;
}

export type Role = "chef" | "cook";

export interface Rule {
  text: string;
  skills: readonly string[];
}

/** The skills in each role's index. Every vendored skill is in at least one. */
export const SUPERPOWERS_SKILLS: Record<Role, readonly string[]> = {
  cook: ["executing-plans", "receiving-code-review", "systematic-debugging", "test-driven-development", "verification-before-completion"],
  chef: ["brainstorming", "dispatching-parallel-agents", "requesting-code-review", "subagent-driven-development", "verification-before-completion", "writing-plans"],
};

export const SUPERPOWERS_RULES: Record<Role, readonly Rule[]> = {
  cook: [
    { text: "Write the failing test first and watch it fail for the expected reason. Then write the minimal code that makes it pass, and run the full test suite of the project.", skills: ["test-driven-development"] },
    { text: "For a bug, a test failure, or unexpected behavior, find the root cause before you change code. After three failed fixes, stop and report blocked with what you tried.", skills: ["systematic-debugging"] },
    { text: "Before you report done, run the verification command again and read all of its output. The done summary names the command and what it printed. Never write that a check should pass.", skills: ["verification-before-completion"] },
    { text: "Check each correction from the chef against the code before you apply it. When it is wrong for this code, do not apply it, and give the technical reason in your report.", skills: ["receiving-code-review"] },
    { text: "When the brief holds a plan, do its tasks in order without stops, and decide small conflicts yourself. This worktree is your workspace: skip the steps that set up a worktree or finish the branch, and end the run with chef_report.", skills: ["executing-plans"] },
  ],
  chef: [
    { text: "When the intent of a request is not clear, find out what the human wants and why before you dispatch, with one question at a time. A quick, clear task needs no questions.", skills: ["brainstorming"] },
    { text: "For a change of project size, write a plan of small tasks. Each task names its files, its interfaces, and the test that proves it. Each task that can land alone becomes one chef_dispatch.", skills: ["writing-plans"] },
    { text: "Put a design or a plan in your reply or in a brief. Do not write files in a project checkout, because the cooks edit the repositories.", skills: ["brainstorming", "writing-plans"] },
    { text: "Give each independent problem its own cook. Never dispatch two cooks that change the same files.", skills: ["dispatching-parallel-agents"] },
    { text: "A brief holds all the context that its cook needs, because the cook never sees this conversation. Between the tasks of a plan, do not ask the human whether to continue. Decide, and tell the human what you decided.", skills: ["subagent-driven-development"] },
    { text: "A cook's done report is not proof. Before you report a task to the human or dispatch work that needs it, review it against its brief with chef_result and the diff. For a large change, dispatch a review task that uses the code-reviewer template.", skills: ["requesting-code-review", "verification-before-completion"] },
  ],
};

const INDEX_NOTE = "The index after them lists each skill, when it applies, and the file that explains it.";
const FRAME: Record<Role, string> = {
  cook: `The user chose the superpowers recipe. You work by its skills. No human watches this run: where a skill tells you to ask or wait for your human partner, make a reversible choice yourself, or report needs_decision for a product, scope, or destructive choice. The rules below are always on. ${INDEX_NOTE}`,
  chef: `The user chose the superpowers recipe. You run the kitchen by its skills. Your human partner is the human who talks to you. Your cooks are the subagents of the skills: a chef_dispatch with a complete brief is a subagent dispatch. The kitchen owns the worktrees, the branches, and their landing, so skip the skill steps that use using-git-worktrees or finishing-a-development-branch. The rules below are always on. ${INDEX_NOTE}`,
};

const plainDashes = (text: string): string => text.replace(/[\u2014\u2013]/g, "-");

export function loadSkills(dir: string = SUPERPOWERS_DIR): Skill[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return names.map((name) => {
    const path = join(dir, name, "SKILL.md");
    const { frontmatter } = parseFrontmatter(readFileSync(path, "utf8"));
    if (!Value.Check(FrontmatterSchema, frontmatter)) throw new Error(`${path} needs a name and a description in its frontmatter`);
    return { name: frontmatter.name, description: plainDashes(frontmatter.description), path };
  });
}

const sentence = (text: string): string => (/[.!?]\)?$/.test(text) ? text : `${text}.`);

export function superpowersBlock(role: Role, skills: readonly Skill[]): string {
  return [
    "# Recipe: superpowers",
    "",
    FRAME[role],
    "",
    "Rules:",
    ...SUPERPOWERS_RULES[role].map((r) => `- ${r.text} (${r.skills.join(", ")})`),
    "",
    "Index:",
    ...skills.filter((s) => SUPERPOWERS_SKILLS[role].includes(s.name)).map((s) => `- ${s.name}: ${sentence(s.description)} File: ${s.path}`),
    "",
    "Before you apply a skill, read its file in full.",
  ].join("\n");
}
