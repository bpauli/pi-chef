import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const PRINCIPLES_DIR = fileURLToPath(new URL("./principles", import.meta.url));

const FrontmatterSchema = Type.Object({ name: Type.String({ minLength: 1 }), description: Type.String({ minLength: 1 }) });

export interface Principle {
  name: string;
  description: string;
  path: string;
}

export type Role = "chef" | "cook";

export interface Rule {
  text: string;
  principles: readonly string[];
}

export const RULES: Record<Role, readonly Rule[]> = {
  cook: [
    { text: "Name the data shape before you write logic.", principles: ["principle-model-the-domain"] },
    { text: "For a bug, reproduce it first and fix the root cause. Do not add a guard that only hides the symptom.", principles: ["principle-fix-root-causes"] },
    { text: "Make the smallest change that does the task. Delete before you add.", principles: ["principle-laziness-protocol", "principle-subtract-before-you-add"] },
    { text: "Validate data at the boundaries. Inside, trust the types.", principles: ["principle-boundary-discipline", "principle-type-system-discipline"] },
    { text: "A test must fail when the behavior it covers breaks.", principles: ["principle-test-behavior-not-implementation"] },
    { text: "Before you report done, verify the change on the real artifact. The done summary names the command you ran to check it and what that command printed. Never claim a check you did not run.", principles: ["principle-prove-it-works"] },
    { text: "Make small commits, and verify each one before the next.", principles: ["principle-sequence-verifiable-units"] },
    { text: "Write a comment only for a reason that the code cannot show.", principles: ["principle-minimize-reader-load"] },
    { text: "Make reversible choices yourself. Report needs_decision only for a product, scope, or destructive choice.", principles: ["principle-never-block-on-the-human"] },
  ],
  chef: [
    { text: "Split work into tasks that each end in a check.", principles: ["principle-sequence-verifiable-units"] },
    { text: "Give each cook its own area, so that two cooks never edit the same files.", principles: ["principle-separate-before-serializing-shared-state"] },
    { text: "Make reversible calls yourself. Ask the human only for a product, scope, money, or destructive call.", principles: ["principle-never-block-on-the-human"] },
    { text: "Every brief says what done means and names the check that proves it.", principles: ["principle-prove-it-works"] },
    { text: "A cook's report is not proof. Before you tell the human that a task is done, review the evidence with chef_result and the diff.", principles: ["principle-prove-it-works"] },
    { text: "Keep your context small. Read summaries and diffstats, not whole transcripts.", principles: ["principle-guard-the-context-window"] },
    { text: "When fixes for one task fail again and again, state the assumption they share and test it.", principles: ["principle-attack-the-premise"] },
    { text: "In a scope call, choose what delights the user over what is easy to build.", principles: ["principle-experience-first"] },
  ],
};

const FRAME: Record<Role, string> = {
  cook: "You work by the pstack principles. The rules below are always on. The index after them lists each principle, when it applies, and the file that explains it.",
  chef: "You run the kitchen by the pstack principles. The rules below are always on. The index after them lists each principle, when it applies, and the file that explains it.",
};

export function loadPrinciples(dir: string = PRINCIPLES_DIR): Principle[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("principle-"))
    .map((e) => e.name)
    .sort();
  return names.map((name) => {
    const path = join(dir, name, "SKILL.md");
    const { frontmatter } = parseFrontmatter(readFileSync(path, "utf8"));
    if (!Value.Check(FrontmatterSchema, frontmatter)) throw new Error(`${path} needs a name and a description in its frontmatter`);
    return { name: frontmatter.name, description: frontmatter.description, path };
  });
}

export function principlesBlock(role: Role, principles: readonly Principle[]): string {
  return [
    "# Principles",
    "",
    FRAME[role],
    "",
    "Rules:",
    ...RULES[role].map((r) => `- ${r.text} (${r.principles.join(", ")})`),
    "",
    "Index:",
    ...principles.map((p) => `- ${p.name}: ${p.description} File: ${p.path}`),
    "",
    "Before you apply a principle, read its file in full.",
  ].join("\n");
}
