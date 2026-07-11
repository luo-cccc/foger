#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "inkos-process-stress-"));
const workerPath = resolve("scripts/fixtures/process-contention-worker.mjs");
const chapterFixture = resolve("packages/studio/e2e/fixtures/chapter-persistence-process.mjs");
const workers = readPositiveInt("INKOS_STRESS_WORKERS", 8);
const iterations = readPositiveInt("INKOS_STRESS_ITERATIONS", 25);
const workflowRounds = readPositiveInt("INKOS_STRESS_WORKFLOW_ROUNDS", 10);
const chapterRounds = readPositiveInt("INKOS_STRESS_CHAPTER_ROUNDS", 5);

const report = {
  workers,
  iterations,
  bookMutations: workers * iterations,
  configMutations: workers * iterations,
  workflowPreparingRecoveries: 0,
  workflowCommittedRecoveries: 0,
  chapterPreparingRecoveries: 0,
  chapterCommittedRecoveries: 0,
};

try {
  await runBookLockContention();
  await runProjectConfigContention();
  for (let round = 0; round < workflowRounds; round++) {
    await runWorkflowCrashRound(false, round);
    report.workflowPreparingRecoveries += 1;
    await runWorkflowCrashRound(true, round);
    report.workflowCommittedRecoveries += 1;
  }
  for (let round = 0; round < chapterRounds; round++) {
    await runChapterCrashRound(false, round);
    report.chapterPreparingRecoveries += 1;
    await runChapterCrashRound(true, round);
    report.chapterCommittedRecoveries += 1;
  }
  process.stdout.write(`PROCESS_STRESS_PASS ${JSON.stringify(report)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runBookLockContention() {
  const bookId = "lock-contention";
  const bookDir = join(root, "books", bookId);
  await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, "counter.json"), JSON.stringify({ counter: 0, entries: {} }), "utf-8");
  await Promise.all(Array.from({ length: workers }, () => runChild([
    workerPath, "book-counter", root, bookId, String(iterations),
  ])));
  const saved = JSON.parse(await readFile(join(bookDir, "counter.json"), "utf-8"));
  assert(saved.counter === workers * iterations, `Book counter mismatch: ${saved.counter}`);
  assert(Object.keys(saved.entries).length === workers * iterations, "Book counter entries were lost");
  await assertMissing(join(bookDir, ".write.lock"));
}

async function runProjectConfigContention() {
  await writeFile(join(root, "inkos.json"), JSON.stringify({ counter: 0, entries: {} }), "utf-8");
  await Promise.all(Array.from({ length: workers }, () => runChild([
    workerPath, "config-counter", root, "project", String(iterations),
  ])));
  const saved = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
  assert(saved.counter === workers * iterations, `Project config counter mismatch: ${saved.counter}`);
  assert(Object.keys(saved.entries).length === workers * iterations, "Project config entries were lost");
  await assertMissing(join(root, ".inkos-project-config.lock"));
}

async function runWorkflowCrashRound(committed, round) {
  const bookId = `workflow-${committed ? "committed" : "preparing"}-${round}`;
  const bookDir = join(root, "books", bookId);
  const child = spawn(process.execPath, [workerPath, committed ? "workflow-committed" : "workflow-preparing", root, bookId], childOptions());
  await waitForLine(child, "INKOS_STRESS_READY ");
  await forceKill(child);
  const recoveryLine = await runChild([workerPath, "workflow-recover", root, bookId], "INKOS_STRESS_RECOVERY ");
  const recovery = JSON.parse(recoveryLine);
  assert(recovery.kind === (committed ? "committed-cleanup" : "rolled-back"), `Unexpected workflow recovery: ${recoveryLine}`);
  const runtimeDir = join(bookDir, "story", "runtime");
  const stable = await readFile(join(runtimeDir, "stable.txt"), "utf-8");
  assert(stable === (committed ? "committed" : "stable"), `Workflow stable file mismatch: ${stable}`);
  if (committed) {
    assert(await exists(join(runtimeDir, "new-partial.txt")), "Committed workflow output was rolled back");
  } else {
    await assertMissing(join(runtimeDir, "new-partial.txt"));
  }
  await assertMissing(join(bookDir, ".core-workflow-mutation.json"));
  await assertMissing(join(bookDir, ".core-workflow-backup"));
  await assertMissing(join(bookDir, ".write.lock"));
}

async function runChapterCrashRound(committed, round) {
  const bookId = `chapter-${committed ? "committed" : "preparing"}-${round}`;
  const operationId = `stress-${committed ? "committed" : "preparing"}-${round}`;
  const child = spawn(process.execPath, [
    chapterFixture,
    committed ? "prepare-committed" : "prepare",
    root,
    bookId,
    operationId,
  ], childOptions());
  await waitForLine(child, "INKOS_PROCESS_READY ");
  await forceKill(child);
  const recoveryLine = await runChild([
    chapterFixture, "recover", root, bookId, operationId,
  ], "INKOS_RECOVERY_RESULT ");
  const recovery = JSON.parse(recoveryLine);
  assert(recovery.kind === (committed ? "committed-cleanup" : "rolled-back"), `Unexpected chapter recovery: ${recoveryLine}`);
  const bookDir = join(root, "books", bookId);
  const chapterPath = join(bookDir, "chapters", "0001_process-crash.md");
  if (committed) assert(await exists(chapterPath), "Committed chapter was rolled back");
  else await assertMissing(chapterPath);
  await assertMissing(join(bookDir, ".chapter-persistence.json"));
  await assertMissing(join(bookDir, ".write.lock"));
}

function runChild(args, resultPrefix) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, childOptions());
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Child failed code=${code} signal=${signal}\n${stderr}\n${stdout}`));
        return;
      }
      if (!resultPrefix) {
        resolvePromise("");
        return;
      }
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(resultPrefix));
      if (!line) reject(new Error(`Missing ${resultPrefix} in child output: ${stdout}`));
      else resolvePromise(line.slice(resultPrefix.length));
    });
  });
}

function waitForLine(child, prefix) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${prefix}\n${stderr}`)), 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
      if (line) {
        clearTimeout(timeout);
        resolvePromise(line.slice(prefix.length));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (!stdout.includes(prefix)) {
        clearTimeout(timeout);
        reject(new Error(`Child exited before ready code=${code} signal=${signal}\n${stderr}`));
      }
    });
  });
}

async function forceKill(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await runChildProcess("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGKILL");
  }
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

function runChildProcess(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
  });
}

function childOptions() {
  return { stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
}

function readPositiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function exists(path) {
  return await stat(path).then(() => true).catch(() => false);
}

async function assertMissing(path) {
  assert(!await exists(path), `Expected path to be absent: ${path}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
