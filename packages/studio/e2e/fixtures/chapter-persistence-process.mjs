import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateManager } from "@actalk/inkos-core";

const [, , action, projectRoot, bookId, operationId = "e2e-process-crash-operation"] = process.argv;

if (!action || !projectRoot || !bookId) {
  throw new Error("Usage: chapter-persistence-process.mjs <prepare|prepare-committed|recover> <projectRoot> <bookId> [operationId]");
}

const state = new StateManager(projectRoot);

if (action === "prepare" || action === "prepare-committed") {
  await prepareInterruptedWrite(action === "prepare-committed");
} else if (action === "recover") {
  await recoverInterruptedWrite();
} else {
  throw new Error(`Unknown action: ${action}`);
}

async function prepareInterruptedWrite(committed) {
  const bookDir = state.bookDir(bookId);
  const storyDir = join(bookDir, "story");
  const chaptersDir = join(bookDir, "chapters");
  await mkdir(chaptersDir, { recursive: true });
  await mkdir(storyDir, { recursive: true });
  await writeFile(join(storyDir, "current_state.md"), "state-before-process-crash", "utf-8");
  await writeFile(join(storyDir, "pending_hooks.md"), "hooks-before-process-crash", "utf-8");
  await state.saveChapterIndex(bookId, []);
  await state.snapshotState(bookId, 0);

  await state.acquireBookLock(bookId);
  await state.beginChapterPersistence(bookId, 1, operationId);
  await writeFile(
    join(chaptersDir, "0001_process-crash.md"),
    committed ? "committed chapter" : "partial chapter",
    "utf-8",
  );
  await writeFile(join(storyDir, "current_state.md"), "state-after-partial-write", "utf-8");
  await writeFile(join(storyDir, "pending_hooks.md"), "hooks-after-partial-write", "utf-8");
  await state.saveChapterIndex(bookId, [{
    number: 1,
    title: committed ? "Committed before process crash" : "Interrupted by process crash",
    status: "drafting",
    wordCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    auditIssues: [],
    lengthWarnings: [],
  }]);
  if (committed) {
    await writeFile(join(bookDir, ".chapter-persistence.json"), `${JSON.stringify({
      chapterNumber: 1,
      previousChapter: 0,
      status: "committed",
      operationId,
    })}\n`, "utf-8");
  }

  process.stdout.write(`INKOS_PROCESS_READY ${JSON.stringify({
    pid: process.pid,
    bookId,
    operationId,
    status: committed ? "committed" : "preparing",
  })}\n`);
  setInterval(() => undefined, 60_000);
}

async function recoverInterruptedWrite() {
  const release = await state.acquireBookLock(bookId);
  try {
    const recovery = await state.recoverIncompleteChapterPersistence(bookId);
    process.stdout.write(`INKOS_RECOVERY_RESULT ${JSON.stringify(recovery)}\n`);
  } finally {
    await release();
  }
}
