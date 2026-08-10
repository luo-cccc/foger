#!/usr/bin/env node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "inkos-unattended-soak-"));
const worker = resolve("scripts/fixtures/unattended-soak-worker.mjs");
const bookId = "unattended-soak";
const targetChapters = 20;
const report = {
  targetChapters,
  processKillInjected: false,
  timeoutInjected: false,
  restartRecovered: false,
  recoveryRuns: 0,
  finalChapterCount: 0,
  readyChapterCount: 0,
  snapshots: 0,
};

try {
  await runWorker(["setup", root, bookId, String(targetChapters)], "UNATTENDED_SETUP ");

  const killed = spawn(process.execPath, [worker, "run", root, bookId, String(targetChapters), "200", "0"], childOptions());
  const lockPath = join(root, "books", bookId, ".write.lock");
  await waitForPath(lockPath, 30_000);
  await forceKill(killed);
  assert(await exists(lockPath), "Expected killed worker to leave a stale book lock");
  report.processKillInjected = true;

  await runWorker(["timeout", root, bookId, String(targetChapters), "0", "0"], "UNATTENDED_RUN ");
  const timedOutState = JSON.parse(await readFile(join(root, ".inkos", "unattended-state.json"), "utf-8"));
  const timedOutBook = timedOutState.books?.[bookId];
  assert(timedOutBook?.lastFailureKind === "timeout", `Expected timeout state, got ${JSON.stringify(timedOutBook)}`);
  assert(timedOutBook?.status === "retry-wait", `Expected retry-wait after timeout, got ${timedOutBook?.status}`);
  report.timeoutInjected = true;

  let completed;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    completed = JSON.parse(await runWorker(
      ["run", root, bookId, String(targetChapters), "0", "0"],
      "UNATTENDED_RUN ",
    ));
    report.recoveryRuns = attempt;
    if (
      completed.after === targetChapters
      && completed.statuses.every((status) => status === "ready-for-review")
    ) {
      break;
    }
  }
  assert(completed, "Expected at least one unattended recovery run");
  report.finalChapterCount = completed.after;
  report.readyChapterCount = completed.statuses.filter((status) => status === "ready-for-review").length;
  report.snapshots = completed.snapshots;
  report.restartRecovered = completed.unattended?.status === "active"
    && completed.unattended?.consecutiveFailures === 0;

  assert(report.finalChapterCount === targetChapters, `Expected ${targetChapters} chapters, got ${report.finalChapterCount}`);
  assert(report.readyChapterCount === targetChapters, `Expected every chapter ready-for-review, got ${report.readyChapterCount}`);
  assert(report.snapshots >= targetChapters, `Expected at least ${targetChapters} snapshots, got ${report.snapshots}`);
  assert(completed.unattended?.totals?.chapters === targetChapters, "Unattended totals did not persist all chapters");
  assert(report.restartRecovered, "Scheduler did not recover durable unattended state after restart");
  await assertMissing(lockPath);

  process.stdout.write(`UNATTENDED_SOAK_PASS ${JSON.stringify(report)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function runWorker(args, prefix) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [worker, ...args], childOptions());
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Worker failed code=${code} signal=${signal}\n${stderr}\n${stdout}`));
        return;
      }
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
      if (!line) reject(new Error(`Missing ${prefix} in worker output:\n${stdout}\n${stderr}`));
      else resolvePromise(line.slice(prefix.length));
    });
  });
}

async function waitForPath(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
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
  return {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, INKOS_AGENT_LLM_STUB: "1" },
  };
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
