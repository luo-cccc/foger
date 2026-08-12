#!/usr/bin/env node
/**
 * Contamination guard: production source must never embed proper nouns from
 * test fixtures or paid-test production books.
 *
 * Why this exists: every contamination found in this codebase traced back to
 * the same path — a paid production run ("测试生产") generated a book; its
 * plot/characters got copied into a regression-test fixture; then the fixture
 * (the most "real-looking" sample an agent sees) leaked into production code
 * and prompts:
 *
 *   - runner.ts embedded 老周/林默/发卡/调度表/字条/B闸/铁窗 (a review loop
 *     from one book) to demote audit severities.
 *   - episode-quality-gate.ts embedded 望归渊/望归玉/火种营/虞允文 in the
 *     hook-noise set and the functional-speaker allowlist.
 *   - planner-prompts.ts used 胖虎/林秋/守拙诀/雷架 as the Hook-ledger
 *     example; architect.ts used 林辞/灵安峰/宗门长老/皮草公司 as Objective
 *     examples; Studio BookCreate showed 夜港账本 as the title placeholder.
 *
 * The previous semantic audit (audit-semantic-patterns.mjs) only scanned the
 * agent/interaction action surfaces and looked for "free-text instruction
 * recognized by regex" — it could not see book proper nouns in prompts or
 * pipeline logic. This guard closes that gap with an explicit denylist.
 *
 * Rule: non-test source under packages/ and scripts/ must not contain any of
 * the KNOWN_CONTAMINATION terms. Terms are high-confidence proper nouns
 * (character names, in-book factions/places, book titles) — generic props
 * like 字条/血迹/磁带 are deliberately NOT listed to avoid false positives.
 *
 * The list is a living document: when a new paid run introduces characters,
 * add them here (and keep them out of prompts/pipeline code).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.cwd();

const KNOWN_CONTAMINATION = [
  // Character names from paid-run books and their test fixtures
  "老周", "林默", "林辞", "林澈", "沈砚", "顾维远", "姜楠", "林秋",
  "周沉", "顾辞", "沈鸢", "吕文焕", "胖虎", "老莫", "林砚",
  // In-book factions / places / artifacts
  "灵安峰", "火种营", "襄阳", "望归渊", "望归玉", "守拙诀", "雷架", "夜港",
  // Book titles used in paid production runs
  "子夜当铺", "崖山抽卡人", "烽燧令", "子夜修表匠", "夜港账本", "望归",
];

const SCAN_DIRS = [
  "packages/core/src",
  "packages/core/genres",
  "packages/cli/src",
  "packages/studio/src",
  "scripts",
];

const EXCLUDE_DIRS = new Set(["node_modules", "dist", "__tests__", ".git"]);

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walk(path));
    } else if (/\.(ts|tsx|mjs|js|md)$/u.test(path) && !/\.test\.(ts|tsx|js|mjs)$/u.test(path)) {
      out.push(path);
    }
  }
  return out;
}

const files = [];
for (const dir of SCAN_DIRS) {
  for (const file of await walk(join(ROOT, dir))) {
    // The denylist lives in this very script — never flag it against itself.
    if (file.endsWith("audit-contamination.mjs")) continue;
    files.push(file);
  }
}

const findings = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const term of KNOWN_CONTAMINATION) {
    if (!content.includes(term)) continue;
    const line = content.split(/\r?\n/).findIndex((l) => l.includes(term)) + 1;
    findings.push({ file: relative(ROOT, file), line, term });
  }
}

if (findings.length > 0) {
  console.error("Contamination guard FAILED — test/book proper nouns leaked into production source:");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  contains "${finding.term}"`);
  }
  console.error("");
  console.error("Remove the term from production code/prompts. If the term is a legitimate");
  console.error("new character (a fresh production run), first add it to KNOWN_CONTAMINATION");
  console.error("in scripts/audit-contamination.mjs, then keep it out of prompts and pipeline logic.");
  process.exit(1);
}

console.log("Contamination guard passed: no test/book proper nouns in production source.");
