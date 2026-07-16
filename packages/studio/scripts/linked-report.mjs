import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

const INTERRUPTED_MESSAGE = "The linked acceptance process exited before it recorded a terminal result.";

/**
 * Writes a linked-acceptance checkpoint without exposing a partially written
 * JSON document if the test process is interrupted during the write.
 */
export async function writeLinkedReportCheckpoint(reportPath, report) {
  await atomicWriteJson(reportPath, report);
}

/**
 * Converts an orphaned running report into an interrupted terminal report.
 * Durable book artifacts are the authority for the reconstructed summary;
 * browser events already present in the report remain available unchanged.
 */
export async function finalizeInterruptedLinkedReport(reportPath) {
  const report = await readJsonObject(reportPath);
  if (!report || report.status !== "running") {
    return { finalized: false, report };
  }

  const finalizedAt = new Date().toISOString();
  const durableState = await readDurableLinkedState(report);
  const next = {
    ...report,
    status: "interrupted",
    finishedAt: finalizedAt,
    updatedAt: finalizedAt,
    failureStage: typeof report.failureStage === "string"
      ? report.failureStage
      : `interrupted:${typeof report.lastStage === "string" ? report.lastStage : "unknown"}`,
    failureMessage: typeof report.failureMessage === "string"
      ? report.failureMessage
      : INTERRUPTED_MESSAGE,
    durableState,
    reconciliation: {
      kind: "external-interruption",
      finalizedAt,
      lastStage: typeof report.lastStage === "string" ? report.lastStage : null,
      reportedChapterCount: Array.isArray(report.chapters) ? report.chapters.length : 0,
      durableChapterCount: durableState.chapters.entries.length,
      telemetrySource: durableState.telemetry.available ? "runtime-jsonl" : "checkpoint",
    },
  };

  if (durableState.chapters.entries.length > 0) {
    next.chapters = mergeDurableChapters(report.chapters, durableState.chapters.entries);
  }
  if (durableState.telemetry.available) {
    next.totalTokens = durableState.telemetry.totalTokens;
  }

  const archivePath = interruptedArchivePath(reportPath, finalizedAt);
  await writeLinkedReportCheckpoint(archivePath, next);
  await writeLinkedReportCheckpoint(reportPath, next);
  return { finalized: true, report: next, archivePath };
}

async function readDurableLinkedState(report) {
  const projectRoot = typeof report.projectRoot === "string" ? report.projectRoot : "";
  const bookId = typeof report.bookId === "string" ? report.bookId : "";
  if (!projectRoot || !isSafeBookId(bookId)) {
    return unavailableDurableState(
      !projectRoot
        ? "The running report did not record its isolated project root."
        : "The running report did not contain a safe book id.",
    );
  }

  const bookRoot = join(projectRoot, "books", bookId);
  try {
    const [index, manifest, currentState, hooks, chapterSummaries, snapshotNumbers, telemetry] = await Promise.all([
      readJsonValue(join(bookRoot, "chapters", "index.json")),
      readJsonObject(join(bookRoot, "story", "state", "manifest.json")),
      readJsonObject(join(bookRoot, "story", "state", "current_state.json")),
      readJsonObject(join(bookRoot, "story", "state", "hooks.json")),
      readJsonObject(join(bookRoot, "story", "state", "chapter_summaries.json")),
      readSnapshotNumbers(join(bookRoot, "story", "snapshots")),
      readTelemetry(join(projectRoot, ".inkos", "runtime", "llm-calls", `${bookId}.jsonl`)),
    ]);
    const entries = readChapterEntries(index);
    return {
      available: true,
      projectRoot,
      bookId,
      chapters: {
        entries,
        indexCount: entries.length,
      },
      truth: {
        manifestLastAppliedChapter: numericValue(manifest?.lastAppliedChapter),
        currentStateChapter: numericValue(currentState?.chapter),
        currentStateFactCount: Array.isArray(currentState?.facts) ? currentState.facts.length : null,
        hookCount: Array.isArray(hooks?.hooks) ? hooks.hooks.length : null,
        summaryCount: Array.isArray(chapterSummaries?.rows) ? chapterSummaries.rows.length : null,
      },
      snapshots: {
        chapterNumbers: snapshotNumbers,
      },
      telemetry,
    };
  } catch (error) {
    return unavailableDurableState(error instanceof Error ? error.message : String(error));
  }
}

function unavailableDurableState(reason) {
  return {
    available: false,
    reason,
    chapters: { entries: [], indexCount: 0 },
    truth: {
      manifestLastAppliedChapter: null,
      currentStateChapter: null,
      currentStateFactCount: null,
      hookCount: null,
      summaryCount: null,
    },
    snapshots: { chapterNumbers: [] },
    telemetry: {
      available: false,
      calls: 0,
      totalTokens: 0,
      invalidRecords: 0,
    },
  };
}

function readChapterEntries(index) {
  const source = Array.isArray(index)
    ? index
    : Array.isArray(index?.chapters)
      ? index.chapters
      : [];
  return source
    .filter((entry) => entry && typeof entry === "object" && Number.isInteger(entry.number))
    .map((entry) => ({
      chapterNumber: entry.number,
      ...(typeof entry.status === "string" ? { status: entry.status } : {}),
      ...(typeof entry.wordCount === "number" ? { wordCount: entry.wordCount } : {}),
      ...(typeof entry.operationId === "string" ? { operationId: entry.operationId } : {}),
      auditIssues: stringArray(entry.auditIssues),
      lengthWarnings: stringArray(entry.lengthWarnings),
    }))
    .sort((left, right) => left.chapterNumber - right.chapterNumber);
}

function mergeDurableChapters(reported, durableEntries) {
  const reportedByChapter = new Map(
    Array.isArray(reported)
      ? reported
        .filter((entry) => entry && typeof entry === "object" && Number.isInteger(entry.chapterNumber))
        .map((entry) => [entry.chapterNumber, entry])
      : [],
  );
  return durableEntries.map((entry) => {
    const previous = reportedByChapter.get(entry.chapterNumber) ?? {};
    return {
      ...previous,
      chapterNumber: entry.chapterNumber,
      persistedOperationId: entry.operationId ?? previous.persistedOperationId ?? previous.operationId ?? "",
      ...(entry.operationId ? { operationId: previous.operationId ?? entry.operationId } : {}),
      status: entry.status ?? previous.status ?? "missing",
      wordCount: entry.wordCount ?? previous.wordCount ?? 0,
      auditIssues: entry.auditIssues,
      lengthWarnings: entry.lengthWarnings,
    };
  });
}

async function readSnapshotNumbers(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right);
}

async function readTelemetry(path) {
  const raw = await readFile(path, "utf-8").catch(() => null);
  if (raw === null) {
    return { available: false, calls: 0, totalTokens: 0, invalidRecords: 0 };
  }

  let calls = 0;
  let totalTokens = 0;
  let invalidRecords = 0;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object") {
        invalidRecords += 1;
        continue;
      }
      calls += 1;
      if (typeof record.totalTokens === "number" && Number.isFinite(record.totalTokens)) {
        totalTokens += record.totalTokens;
      }
    } catch {
      invalidRecords += 1;
    }
  }
  return { available: true, calls, totalTokens, invalidRecords };
}

async function readJsonObject(path) {
  try {
    const parsed = await readJsonValue(path);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readJsonValue(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function atomicWriteJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await renameWithRetry(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function renameWithRetry(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" ? error.code : "";
      if (!["EACCES", "EBUSY", "EPERM"].includes(code) || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

function interruptedArchivePath(reportPath, timestamp) {
  const extension = extname(reportPath) || ".json";
  const stem = basename(reportPath, extension);
  const marker = timestamp.replace(/[:.]/g, "-");
  return join(dirname(reportPath), `${stem}.interrupted-${marker}${extension}`);
}

function isSafeBookId(value) {
  return value.length > 0 && !value.includes("..") && !/[\\/]/u.test(value);
}

function numericValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
