import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  StateManager,
  atomicWriteJson,
  mutateProjectConfig,
} from "../../packages/core/dist/index.js";

const [, , action, projectRoot, targetId, iterationsRaw = "1"] = process.argv;
const iterations = Number.parseInt(iterationsRaw, 10);

if (!action || !projectRoot || !targetId || !Number.isInteger(iterations) || iterations < 1) {
  throw new Error("Invalid process contention worker arguments");
}

const state = new StateManager(projectRoot);

if (action === "book-counter") {
  await incrementBookCounter();
} else if (action === "config-counter") {
  await incrementProjectConfig();
} else if (action === "workflow-preparing" || action === "workflow-committed") {
  await prepareInterruptedWorkflow(action === "workflow-committed");
} else if (action === "workflow-recover") {
  await recoverWorkflow();
} else {
  throw new Error(`Unknown worker action: ${action}`);
}

async function incrementBookCounter() {
  const counterPath = join(state.bookDir(targetId), "counter.json");
  for (let index = 0; index < iterations; index++) {
    const release = await acquireBookLockWithRetry(targetId);
    try {
      const current = JSON.parse(await readFile(counterPath, "utf-8"));
      await delay((process.pid + index) % 4);
      current.counter += 1;
      current.entries[`${process.pid}-${index}`] = current.counter;
      await atomicWriteJson(counterPath, current);
    } finally {
      await release();
    }
  }
}

async function incrementProjectConfig() {
  for (let index = 0; index < iterations; index++) {
    await mutateProjectConfig(projectRoot, async (config) => {
      const counter = typeof config.counter === "number" ? config.counter : 0;
      await delay((process.pid + index) % 4);
      config.counter = counter + 1;
      config.entries = {
        ...(config.entries && typeof config.entries === "object" ? config.entries : {}),
        [`${process.pid}-${index}`]: counter + 1,
      };
    });
  }
}

async function prepareInterruptedWorkflow(committed) {
  const bookDir = state.bookDir(targetId);
  const runtimeDir = join(bookDir, "story", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "stable.txt"), "stable", "utf-8");
  await state.acquireBookLock(targetId);
  await state.beginCoreWorkflowMutation(targetId, "plan-chapter");
  await writeFile(join(runtimeDir, "stable.txt"), committed ? "committed" : "partial", "utf-8");
  await writeFile(join(runtimeDir, "new-partial.txt"), committed ? "committed-new" : "partial-new", "utf-8");
  if (committed) {
    const markerPath = join(bookDir, ".core-workflow-mutation.json");
    const marker = JSON.parse(await readFile(markerPath, "utf-8"));
    await atomicWriteJson(markerPath, { ...marker, status: "committed" });
  }
  process.stdout.write(`INKOS_STRESS_READY ${JSON.stringify({ pid: process.pid, committed })}\n`);
  setInterval(() => undefined, 60_000);
}

async function recoverWorkflow() {
  const release = await acquireBookLockWithRetry(targetId);
  try {
    const recovery = await state.recoverIncompleteCoreWorkflowMutation(targetId);
    process.stdout.write(`INKOS_STRESS_RECOVERY ${JSON.stringify(recovery)}\n`);
  } finally {
    await release();
  }
}

async function acquireBookLockWithRetry(bookId) {
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      return await state.acquireBookLock(bookId);
    } catch (error) {
      if (!/locked/i.test(error instanceof Error ? error.message : String(error)) || Date.now() >= deadline) throw error;
      await delay(5);
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
