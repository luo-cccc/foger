import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { finalizeInterruptedLinkedReport, writeLinkedReportCheckpoint } from "./linked-report.mjs";

test("finalizes a running report from durable chapter, truth, snapshot, and telemetry artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-linked-report-"));
  const bookId = "linked-book";
  const reportPath = join(root, "reports", "latest-live.json");
  const bookRoot = join(root, "books", bookId);

  try {
    await mkdir(join(bookRoot, "chapters"), { recursive: true });
    await mkdir(join(bookRoot, "story", "state"), { recursive: true });
    await mkdir(join(bookRoot, "story", "snapshots", "0"), { recursive: true });
    await mkdir(join(bookRoot, "story", "snapshots", "1"), { recursive: true });
    await mkdir(join(bookRoot, "story", "snapshots", "2"), { recursive: true });
    await mkdir(join(root, ".inkos", "runtime", "llm-calls"), { recursive: true });
    await writeJson(join(bookRoot, "chapters", "index.json"), [
      { number: 1, status: "ready-for-review", wordCount: 980, operationId: "operation-1", auditIssues: [], lengthWarnings: [] },
      { number: 2, status: "ready-for-review", wordCount: 1020, operationId: "operation-2", auditIssues: ["warning"], lengthWarnings: [] },
    ]);
    await writeJson(join(bookRoot, "story", "state", "manifest.json"), { lastAppliedChapter: 2 });
    await writeJson(join(bookRoot, "story", "state", "current_state.json"), { chapter: 2, facts: [{ subject: "A" }] });
    await writeJson(join(bookRoot, "story", "state", "hooks.json"), { hooks: [{ hookId: "H001" }] });
    await writeJson(join(bookRoot, "story", "state", "chapter_summaries.json"), { rows: [{ chapter: 1 }, { chapter: 2 }] });
    await writeFile(
      join(root, ".inkos", "runtime", "llm-calls", `${bookId}.jsonl`),
      `${JSON.stringify({ totalTokens: 13 })}\n${JSON.stringify({ totalTokens: 29 })}\nnot-json\n`,
      "utf-8",
    );
    await writeLinkedReportCheckpoint(reportPath, {
      status: "running",
      projectRoot: root,
      bookId,
      lastStage: "chapter-3-pipeline-attempt-1",
      totalTokens: 5,
      chapters: [{ chapterNumber: 1, requestId: "request-1", doctorVerified: true, status: "drafting" }],
    });

    const result = await finalizeInterruptedLinkedReport(reportPath);
    assert.equal(result.finalized, true);
    assert.ok(result.archivePath);

    const report = JSON.parse(await readFile(reportPath, "utf-8"));
    assert.equal(report.status, "interrupted");
    assert.equal(report.failureStage, "interrupted:chapter-3-pipeline-attempt-1");
    assert.equal(report.totalTokens, 42);
    assert.deepEqual(report.durableState.snapshots.chapterNumbers, [0, 1, 2]);
    assert.equal(report.durableState.truth.manifestLastAppliedChapter, 2);
    assert.equal(report.durableState.truth.currentStateChapter, 2);
    assert.equal(report.durableState.truth.hookCount, 1);
    assert.equal(report.durableState.truth.summaryCount, 2);
    assert.deepEqual(report.durableState.telemetry, {
      available: true,
      calls: 2,
      totalTokens: 42,
      invalidRecords: 1,
    });
    assert.equal(report.chapters.length, 2);
    assert.equal(report.chapters[0].requestId, "request-1");
    assert.equal(report.chapters[0].status, "ready-for-review");
    assert.equal(report.chapters[1].operationId, "operation-2");
    assert.equal(report.reconciliation.durableChapterCount, 2);

    const archived = JSON.parse(await readFile(result.archivePath, "utf-8"));
    assert.equal(archived.status, "interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves reports with an existing terminal status unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-linked-report-"));
  const reportPath = join(root, "passed.json");
  try {
    await writeLinkedReportCheckpoint(reportPath, { status: "passed", totalTokens: 12 });
    const result = await finalizeInterruptedLinkedReport(reportPath);
    assert.equal(result.finalized, false);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf-8")), { status: "passed", totalTokens: 12 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf-8");
}
