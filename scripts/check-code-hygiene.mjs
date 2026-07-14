import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const scanRoots = [
  join(workspaceRoot, "packages"),
  join(workspaceRoot, "scripts"),
];
const rootFiles = [
  join(workspaceRoot, "package.json"),
  join(workspaceRoot, "tsconfig.json"),
];
const sourceExtensions = new Set([".cjs", ".js", ".json", ".jsx", ".mjs", ".ts", ".tsx"]);
const skippedDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const findings = [];

for (const root of scanRoots) {
  await collectFiles(root);
}
for (const file of rootFiles) {
  await inspectFile(file);
}

if (findings.length > 0) {
  process.stderr.write(`Code hygiene check failed with ${findings.length} finding(s):\n`);
  for (const finding of findings) {
    process.stderr.write(`- ${finding}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write("Code hygiene check passed.\n");
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        await collectFiles(join(directory, entry.name));
      }
      continue;
    }
    if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      await inspectFile(join(directory, entry.name));
    }
  }
}

async function inspectFile(file) {
  const content = await readFile(file, "utf-8");
  const displayPath = relative(workspaceRoot, file).replaceAll("\\", "/");
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  let consecutiveBlankLines = 0;

  if (content.length > 0 && !content.endsWith("\n")) {
    findings.push(`${displayPath}: missing final newline`);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (/[ \t]+$/u.test(line)) {
      findings.push(`${displayPath}:${lineNumber}: trailing whitespace`);
    }
    if (/^\s*$/u.test(line)) {
      consecutiveBlankLines += 1;
      if (consecutiveBlankLines === 2) {
        findings.push(`${displayPath}:${lineNumber}: multiple consecutive blank lines`);
      }
    } else {
      consecutiveBlankLines = 0;
    }
    if (/^(?:<{7}|={7}|>{7})(?:\s|$)/u.test(line)) {
      findings.push(`${displayPath}:${lineNumber}: unresolved merge marker`);
    }
    if (/\b(?:describe|it|test)\.only\s*\(/u.test(line) || /\b(?:fdescribe|fit)\s*\(/u.test(line)) {
      findings.push(`${displayPath}:${lineNumber}: focused test`);
    }
  }
}
