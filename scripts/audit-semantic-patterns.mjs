#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = [
  "packages/core/src",
  "packages/studio/src",
  "packages/cli/src",
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const ACTION_SURFACE_PATHS = [
  "packages/core/src/agent/",
  "packages/core/src/interaction/",
  "packages/studio/src/api/server.ts",
  "packages/studio/src/pages/BookCreate.tsx",
  "packages/cli/src/commands/",
  "packages/cli/src/tui/",
];

// Free-text production intent is parsed once into a typed action envelope.
// Other modules may parse file formats, model output, greetings, paths, etc.,
// but must not infer a mutating command from user prose.
const APPROVED_ACTION_PARSERS = new Set([
  "packages/core/src/interaction/action-envelope.ts",
  "packages/cli/src/tui/local-commands.ts",
]);
const NON_USER_PROMPT_PARSERS = new Set([
  "packages/core/src/agent/llm-stub.ts",
]);

const SEMANTIC_INPUT = /\b(?:instruction|prompt|userMessage|freeText)\b/iu;
const PATTERN_OPERATION = /(?:\.match\s*\(|\.test\s*\(|\.includes\s*\(|\.startsWith\s*\(|\.endsWith\s*\(|new\s+RegExp\s*\()/u;
const MUTATING_ACTION_LANGUAGE = /(?:write|draft|continue|create|edit|replace|rename|rewrite|revise|import|export|approve|publish|episode|book|写|续写|继续|创建|建书|编辑|修改|改成|替换|重命名|重写|修订|导入|导出|批准|通过|发布|剧集|下一集)/iu;
const INSTRUCTION_PARSER_DECLARATION = /\bfunction\s+(?:parse|infer|detect|classify|isExplicit)[A-Za-z0-9_]*(?:Instruction|Command|Intent)\b/u;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
      out.push(...await walk(path));
    } else if (SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) {
      out.push(path);
    }
  }
  return out;
}

function isActionSurface(rel) {
  return ACTION_SURFACE_PATHS.some((prefix) => rel.startsWith(prefix));
}

function isMutatingFreeTextDecision(line) {
  if (INSTRUCTION_PARSER_DECLARATION.test(line)) return true;
  return PATTERN_OPERATION.test(line)
    && SEMANTIC_INPUT.test(line)
    && MUTATING_ACTION_LANGUAGE.test(line);
}

const files = [];
for (const dir of SCAN_DIRS) {
  files.push(...await walk(join(ROOT, dir)));
}

const findings = [];
for (const file of files) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  if (!isActionSurface(rel) || APPROVED_ACTION_PARSERS.has(rel) || NON_USER_PROMPT_PARSERS.has(rel)) continue;
  const content = await readFile(file, "utf-8");
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!isMutatingFreeTextDecision(lines[index])) continue;
    findings.push({
      file: rel,
      line: index + 1,
      text: lines[index].trim(),
    });
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ findings }, null, 2));
} else {
  console.log(`Mutating free-text routing findings: ${findings.length}`);
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line}  ${finding.text}`);
  }
}

if (findings.length > 0) process.exitCode = 1;
