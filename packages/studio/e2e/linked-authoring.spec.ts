import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { writeLinkedReportCheckpoint } from "../scripts/linked-report.mjs";

const LINKED_EVENT_NAMES = [
  "book:creating",
  "book:created",
  "book:error",
  "write:start",
  "write:complete",
  "write:error",
  "write:cancel-requested",
  "write:cancelled",
  "revise:start",
  "revise:complete",
  "revise:error",
  "revise:cancel-requested",
  "revise:cancelled",
  "rewrite:start",
  "rewrite:complete",
  "rewrite:error",
  "rewrite:cancel-requested",
  "rewrite:cancelled",
  "repair-state:start",
  "repair-state:complete",
  "repair-state:error",
  "repair-state:cancel-requested",
  "repair-state:cancelled",
  "resync:start",
  "resync:complete",
  "resync:error",
  "resync:cancel-requested",
  "resync:cancelled",
  "llm:telemetry",
] as const;

interface LinkedEvent {
  readonly event: string;
  readonly data: Record<string, unknown> | null;
  readonly timestamp: number;
}

interface LinkedChapterSnapshot {
  readonly number: number;
  readonly status: string;
  readonly wordCount: number;
  readonly operationId?: string;
  readonly auditIssues?: ReadonlyArray<string>;
  readonly lengthWarnings?: ReadonlyArray<string>;
}

interface BookDetailResponse {
  readonly book: { readonly id: string };
  readonly chapters: ReadonlyArray<LinkedChapterSnapshot>;
}

type LinkedRecoveryKind = "revise" | "rewrite" | "repair-state" | "resync";

interface LinkedRecoveryActionReport {
  readonly kind: LinkedRecoveryKind;
  readonly statusBefore: string;
  readonly statusAfter: string;
  readonly httpStatus: number;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly terminalEvent?: string;
  readonly resultStatus?: string;
  readonly error?: string;
  readonly totalTokens: number;
  readonly telemetry: ReadonlyArray<Record<string, unknown>>;
}

interface LinkedChapterReport {
  readonly chapterNumber: number;
  readonly requestId: string;
  readonly operationId: string;
  readonly writeAttempts: ReadonlyArray<LinkedWriteAttemptReport>;
  persistedOperationId: string;
  status: string;
  wordCount: number;
  auditIssues: ReadonlyArray<string>;
  lengthWarnings: ReadonlyArray<string>;
  readonly telemetry: ReadonlyArray<Record<string, unknown>>;
  readonly recoveryActions: LinkedRecoveryActionReport[];
  doctorVerified: boolean;
}

interface LinkedWriteAttemptReport {
  readonly attempt: number;
  readonly requestId: string;
  readonly operationId?: string;
  readonly terminalEvent: string;
  readonly error?: string;
  readonly totalTokens: number;
  readonly telemetry: ReadonlyArray<Record<string, unknown>>;
}

interface LinkedCreationAttemptReport {
  readonly attempt: number;
  readonly bookId: string;
  readonly status: "ready" | "failed";
  readonly error?: string;
  readonly totalTokens: number;
  readonly telemetry: ReadonlyArray<Record<string, unknown>>;
}

type LinkedQualityPolicy = "strict" | "report-only";

interface LinkedGateReport {
  readonly passed: boolean;
  readonly reasons: ReadonlyArray<string>;
}

interface LinkedQualityChapterReport {
  readonly chapterNumber: number;
  readonly status: string;
  readonly passed: boolean;
  readonly reasons: ReadonlyArray<string>;
}

interface LinkedQualityGateReport {
  readonly passed: boolean;
  readonly policy: LinkedQualityPolicy;
  readonly enforced: boolean;
  readonly chapters: ReadonlyArray<LinkedQualityChapterReport>;
  readonly reasons: ReadonlyArray<string>;
}

interface LinkedRunReport {
  status: "running" | "passed" | "failed" | "interrupted";
  mode: "stub" | "live";
  runFingerprint: string;
  startedAt: string;
  updatedAt?: string;
  finishedAt?: string;
  lastStage?: string;
  projectRoot?: string;
  scenario: {
    chapters: number;
    wordsPerChapter: number;
    maxTotalTokens: number;
    maxPromptTokensPerCall: number;
    qualityPolicy: LinkedQualityPolicy;
    createAttempts: number;
    writeAttempts: number;
  };
  bookId?: string;
  creationAttempts: LinkedCreationAttemptReport[];
  chapters: LinkedChapterReport[];
  totalTokens: number;
  failureStage?: string;
  failureMessage?: string;
  failureSignature?: string;
  failureTelemetry?: ReadonlyArray<Record<string, unknown>>;
  linkedGate?: LinkedGateReport;
  qualityGate?: LinkedQualityGateReport;
}

class LinkedQualityGateError extends Error {}

const liveMode = process.env.INKOS_E2E_LLM_MODE === "live";
const requestedChapters = Math.max(1, readPositiveInteger("INKOS_LINKED_CHAPTERS", 1));
const wordsPerChapter = Math.max(1000, readPositiveInteger("INKOS_LINKED_WORDS", 1000));
const maxTotalTokens = readPositiveInteger("INKOS_LINKED_MAX_TOTAL_TOKENS", 0);
const maxPromptTokensPerCall = readPositiveInteger("INKOS_LINKED_MAX_PROMPT_TOKENS_PER_CALL", 0);
const qualityPolicy = readQualityPolicy();
const maxCreateAttempts = Math.max(1, readPositiveInteger("INKOS_LINKED_CREATE_ATTEMPTS", liveMode ? 2 : 1));
const maxWriteAttempts = Math.max(1, readPositiveInteger("INKOS_LINKED_WRITE_ATTEMPTS", liveMode ? 3 : 1));
const creationTimeoutMs = liveMode ? 30 * 60_000 : 180_000;
const operationTimeoutMs = liveMode ? 30 * 60_000 : 180_000;

test("@linked correlates browser, Studio API, Core telemetry, persistence, and Doctor", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(creationTimeoutMs + operationTimeoutMs * requestedChapters * maxWriteAttempts + 120_000);

  const reportPath = resolve(
    process.env.INKOS_LINKED_REPORT_PATH?.trim() || testInfo.outputPath("linked-acceptance.json"),
  );
  const projectRoot = process.env.INKOS_E2E_PROJECT_ROOT?.trim();
  const report: LinkedRunReport = {
    status: "running",
    mode: liveMode ? "live" : "stub",
    runFingerprint: process.env.INKOS_LINKED_RUN_FINGERPRINT?.trim() || "untracked",
    startedAt: new Date().toISOString(),
    ...(projectRoot ? { projectRoot } : {}),
    scenario: {
      chapters: requestedChapters,
      wordsPerChapter,
      maxTotalTokens,
      maxPromptTokensPerCall,
      qualityPolicy,
      createAttempts: maxCreateAttempts,
      writeAttempts: maxWriteAttempts,
    },
    creationAttempts: [],
    chapters: [],
    totalTokens: 0,
  };
  let stage = "browser-start";

  try {
    await writeReportCheckpoint(reportPath, report, stage);
    await page.goto("/");
    await startLinkedEventCollector(page);

    let bookId = "";
    for (let attempt = 1; attempt <= maxCreateAttempts; attempt += 1) {
      stage = `book-create-${attempt}`;
      const eventOffset = (await readLinkedEvents(page)).length;
      const title = `Linked Acceptance ${liveMode ? "Live" : "Stub"} ${Date.now()} A${attempt}`;
      const creation = await createBookFromBrowser(page, {
        title,
        genre: "urban",
        language: "zh",
        platform: "other",
        chapterWordCount: wordsPerChapter,
        targetChapters: Math.max(12, requestedChapters),
        blurb: "近未来港城中，一名账房追查导师失踪与伪造债务账本，证据必须通过行动、对话和可验证物件逐步推进。",
      });
      if (creation.status !== 200) {
        throw new Error(`Book creation returned HTTP ${creation.status}: ${readBrowserApiError(creation)}`);
      }
      expect(creation.body.status).toBe("creating");
      expect(creation.body.bookId).toEqual(expect.any(String));
      const attemptedBookId = String(creation.body.bookId);
      report.bookId = attemptedBookId;

      let creationError: string | undefined;
      try {
        await waitForCreateReady(request, attemptedBookId);
      } catch (cause) {
        creationError = cause instanceof Error ? cause.message : String(cause);
      }

      const allCreationEvents = await readLinkedEvents(page);
      const attemptEvents = allCreationEvents.slice(eventOffset);
      const attemptTelemetry = attemptEvents
        .filter((event) => event.event === "llm:telemetry")
        .map((event) => sanitizeTelemetry(event.data ?? {}));
      report.creationAttempts.push({
        attempt,
        bookId: attemptedBookId,
        status: creationError ? "failed" : "ready",
        ...(creationError ? { error: creationError } : {}),
        totalTokens: sumTelemetryTokens(attemptEvents),
        telemetry: attemptTelemetry,
      });
      report.totalTokens = sumTelemetryTokens(allCreationEvents);
      await writeReportCheckpoint(reportPath, report, stage);
      if (maxTotalTokens > 0 && report.totalTokens > maxTotalTokens) {
        throw new Error(
          `Book creation used ${report.totalTokens} tokens, exceeding the linked run budget of ${maxTotalTokens}.`,
        );
      }
      assertPromptBudget(attemptEvents, maxPromptTokensPerCall, `Book creation attempt ${attempt}`);

      if (creationError) {
        if (attempt >= maxCreateAttempts || !isRetryableFoundationError(creationError)) {
          throw new Error(creationError);
        }
        continue;
      }

      expect(attemptEvents.some((event) =>
        event.event === "book:creating" && event.data?.bookId === attemptedBookId
      )).toBe(true);
      expect(attemptEvents.some((event) =>
        event.event === "book:created" && event.data?.bookId === attemptedBookId
      )).toBe(true);
      bookId = attemptedBookId;
      break;
    }
    if (!bookId) throw new Error(`Book creation did not succeed after ${maxCreateAttempts} attempt(s).`);

    await navigateHash(page, `#/book/${encodeURIComponent(bookId)}/settings`);
    await expect(page.getByTestId("write-next-button")).toBeVisible();

    for (let chapterNumber = 1; chapterNumber <= requestedChapters; chapterNumber += 1) {
      let requestId = "";
      let terminal: LinkedEvent | undefined;
      const writeAttempts: LinkedWriteAttemptReport[] = [];
      for (let attempt = 1; attempt <= maxWriteAttempts; attempt += 1) {
        stage = `chapter-${chapterNumber}-start-attempt-${attempt}`;
        const eventOffset = (await readLinkedEvents(page)).length;
        const responsePromise = page.waitForResponse((response) =>
          response.request().method() === "POST"
          && response.url().includes(`/api/v1/books/${encodeURIComponent(bookId)}/write-next`),
        );
        await page.getByTestId("write-next-button").click();
        const response = await responsePromise;
        expect(response.status()).toBe(202);
        const startBody = await response.json() as { requestId?: unknown };
        expect(startBody.requestId).toEqual(expect.any(String));
        requestId = String(startBody.requestId);

        stage = `chapter-${chapterNumber}-pipeline-attempt-${attempt}`;
        terminal = await waitForAsyncOperationTerminal(
          page,
          bookId,
          "write",
          requestId,
          operationTimeoutMs,
          maxTotalTokens,
        );
        const attemptEvents = (await readLinkedEvents(page)).slice(eventOffset);
        const attemptTelemetry = recoveryTelemetry(attemptEvents);
        const attemptOperationId = typeof terminal.data?.operationId === "string"
          ? terminal.data.operationId
          : uniqueTelemetryOperationId(attemptTelemetry);
        const terminalError = terminal.event === "write:complete"
          ? undefined
          : terminal.event === "write:cancelled"
            ? `Write operation ${requestId} was cancelled after reaching the linked token budget.`
            : String(terminal.data?.error ?? `Write operation ended with ${terminal.event}.`);
        writeAttempts.push({
          attempt,
          requestId,
          ...(attemptOperationId ? { operationId: attemptOperationId } : {}),
          terminalEvent: terminal.event,
          ...(terminalError ? { error: terminalError } : {}),
          totalTokens: sumTelemetryTokens(attemptEvents),
          telemetry: attemptTelemetry,
        });
        report.totalTokens = sumTelemetryTokens(await readLinkedEvents(page));

        if (!terminalError) break;
        if (attempt >= maxWriteAttempts || !isRetryableWriteError(terminalError)) {
          throw new Error(terminalError);
        }
        await page.waitForTimeout(attempt * 10_000);
        await expect(page.getByTestId("write-next-button")).toBeEnabled({ timeout: 60_000 });
      }
      if (!terminal || terminal.event !== "write:complete") {
        throw new Error(`Chapter ${chapterNumber} did not complete after ${maxWriteAttempts} write attempt(s).`);
      }

      const operationId = typeof terminal.data?.operationId === "string" ? terminal.data.operationId : "";
      expect(operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(terminal.data?.requestId).toBe(requestId);

      const events = await readLinkedEvents(page);
      const startEvent = events.find((event) =>
        event.event === "write:start" && event.data?.requestId === requestId,
      );
      expect(startEvent?.data?.bookId).toBe(bookId);

      const telemetry = events
        .filter((event) => event.event === "llm:telemetry" && event.data?.operationId === operationId)
        .map((event) => event.data ?? {});
      const chapterReport: LinkedChapterReport = {
        chapterNumber,
        requestId,
        operationId,
        writeAttempts,
        persistedOperationId: operationId,
        status: "awaiting-persistence-verification",
        wordCount: 0,
        auditIssues: [],
        lengthWarnings: [],
        telemetry: telemetry.map(sanitizeTelemetry),
        recoveryActions: [],
        doctorVerified: false,
      };
      report.chapters.push(chapterReport);
      report.totalTokens = sumTelemetryTokens(await readLinkedEvents(page));
      await writeReportCheckpoint(reportPath, report, stage);

      expect(telemetry.length).toBeGreaterThan(0);
      expect(
        telemetry.every((entry) => entry.bookId === bookId),
        `Operation ${operationId} telemetry book IDs: ${JSON.stringify(telemetry.map((entry) => entry.bookId ?? null))}`,
      ).toBe(true);
      assertPromptBudget(events, maxPromptTokensPerCall, `Chapter ${chapterNumber}`);

      const book = await waitForChapter(request, bookId, chapterNumber);
      let chapter = book.chapters.find((entry) => entry.number === chapterNumber);
      updateChapterReport(chapterReport, chapter);

      expect(chapter?.operationId).toBe(operationId);
      expect(new Set(chapter?.auditIssues ?? []).size).toBe(chapter?.auditIssues?.length ?? 0);
      expect(new Set(chapter?.lengthWarnings ?? []).size).toBe(chapter?.lengthWarnings?.length ?? 0);

      if (qualityPolicy === "report-only" && chapter) {
        stage = `chapter-${chapterNumber}-recovery`;
        chapter = await recoverReportOnlyChapter({
          page,
          request,
          bookId,
          chapter,
          operationTimeoutMs,
          tokenBudget: maxTotalTokens,
          onAction: async (action, recoveredChapter) => {
            chapterReport.recoveryActions.push(action);
            updateChapterReport(chapterReport, recoveredChapter);
            report.totalTokens = sumTelemetryTokens(await readLinkedEvents(page));
            await writeReportCheckpoint(reportPath, report, stage);
          },
        });
        updateChapterReport(chapterReport, chapter);
        report.totalTokens = sumTelemetryTokens(await readLinkedEvents(page));
        assertPromptBudget(
          await readLinkedEvents(page),
          maxPromptTokensPerCall,
          `Chapter ${chapterNumber} recovery`,
        );
      }

      expect(chapter?.status).not.toBe("state-degraded");
      expect(new Set(chapter?.auditIssues ?? []).size).toBe(chapter?.auditIssues?.length ?? 0);
      expect(new Set(chapter?.lengthWarnings ?? []).size).toBe(chapter?.lengthWarnings?.length ?? 0);

      stage = `chapter-${chapterNumber}-doctor`;
      await expect(page.getByTestId(`chapter-row-${chapterNumber}`)).toBeVisible();
      const persistedOperationId = chapter?.operationId ?? operationId;
      chapterReport.persistedOperationId = persistedOperationId;
      await navigateHash(page, `#/doctor?operationId=${encodeURIComponent(persistedOperationId)}`);
      await expect(page.getByTestId("operation-trace-filter")).toContainText(persistedOperationId);
      await expect(page.getByTestId("operation-telemetry-call-count")).not.toContainText("还没有最近调用");
      await expect(page.getByTestId("operation-telemetry-call-count")).not.toContainText("No recent calls yet");
      chapterReport.doctorVerified = true;
      await writeReportCheckpoint(reportPath, report, stage);

      stage = `chapter-${chapterNumber}-quality`;
      const chapterQuality = buildChapterQualityReport(chapterReport, wordsPerChapter);
      if (qualityPolicy === "strict" && !chapterQuality.passed) {
        throw new LinkedQualityGateError(
          `Chapter ${chapterNumber} failed the strict linked quality gate: ${chapterQuality.reasons.join("; ")}`,
        );
      }

      if (chapterReport.status !== "ready-for-review" && chapterNumber < requestedChapters) {
        throw new Error(
          `Chapter ${chapterNumber} remained ${chapterReport.status} after report-only recovery; `
          + "the production continuation guard would block the next chapter.",
        );
      }

      if (chapterNumber < requestedChapters) {
        await navigateHash(page, `#/book/${encodeURIComponent(bookId)}/settings`);
        await expect(page.getByTestId("write-next-button")).toBeEnabled();
      }
    }

    stage = "complete";
    report.linkedGate = buildLinkedGate(report, requestedChapters);
    report.qualityGate = buildQualityGate(report.chapters, wordsPerChapter, qualityPolicy);
    if (!report.linkedGate.passed) {
      throw new Error(`Linked acceptance gate failed: ${report.linkedGate.reasons.join("; ")}`);
    }
    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    await persistReport(reportPath, report, testInfo, stage);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    report.status = "failed";
    report.failureStage = stage;
    report.failureMessage = message;
    const failureEvents = await readLinkedEvents(page).catch(() => [] as LinkedEvent[]);
    report.totalTokens = sumTelemetryTokens(failureEvents) || report.totalTokens;
    report.failureTelemetry = failureEvents
      .filter((event) => event.event === "llm:telemetry")
      .map((event) => sanitizeTelemetry(event.data ?? {}));
    report.linkedGate = buildLinkedGate(
      report,
      requestedChapters,
      cause instanceof LinkedQualityGateError ? undefined : `[${stage}] ${message}`,
    );
    report.qualityGate = buildQualityGate(report.chapters, wordsPerChapter, qualityPolicy);
    report.failureSignature = buildFailureSignature(stage, message, report);
    report.finishedAt = new Date().toISOString();
    await persistReport(reportPath, report, testInfo, stage).catch(() => undefined);
    throw cause;
  } finally {
    await stopLinkedEventCollector(page).catch(() => undefined);
  }
});

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function readQualityPolicy(): LinkedQualityPolicy {
  const value = process.env.INKOS_LINKED_QUALITY_POLICY?.trim() || "strict";
  if (value !== "strict" && value !== "report-only") {
    throw new Error(`INKOS_LINKED_QUALITY_POLICY must be strict or report-only, received "${value}".`);
  }
  return value;
}

function isRetryableFoundationError(message: string): boolean {
  return /基础设定没有生成完整|story foundation came back incomplete|architect foundation incomplete|missing sections/i.test(message);
}

function isRetryableWriteError(message: string): boolean {
  return /无法连接到 API 服务|could not connect|connection error|fetch failed|econnreset|econnrefused|etimedout|socket hang up|network socket disconnected|service unavailable|bad gateway|gateway timeout|upstream connect|connect timeout|rate limit|too many requests|\b429\b|\b502\b|\b503\b|\b504\b/i
    .test(message);
}

function buildLinkedGate(
  report: { readonly bookId?: string; readonly chapters: ReadonlyArray<LinkedChapterReport> },
  expectedChapters: number,
  externalFailure?: string,
): LinkedGateReport {
  const reasons: string[] = [];
  if (!report.bookId) reasons.push("Book creation did not produce a persisted book ID.");
  if (report.chapters.length !== expectedChapters) {
    reasons.push(`Expected ${expectedChapters} persisted chapter(s), observed ${report.chapters.length}.`);
  }
  for (const chapter of report.chapters) {
    if (!chapter.requestId) reasons.push(`Chapter ${chapter.chapterNumber} is missing its HTTP request ID.`);
    if (!chapter.operationId) reasons.push(`Chapter ${chapter.chapterNumber} is missing its Core operation ID.`);
    if (chapter.telemetry.length === 0) reasons.push(`Chapter ${chapter.chapterNumber} has no correlated LLM telemetry.`);
    if (!chapter.doctorVerified) reasons.push(`Chapter ${chapter.chapterNumber} was not correlated in Doctor.`);
    if (chapter.status === "state-degraded" || chapter.status === "missing") {
      reasons.push(`Chapter ${chapter.chapterNumber} persistence status is ${chapter.status}.`);
    }
    if (new Set(chapter.auditIssues).size !== chapter.auditIssues.length) {
      reasons.push(`Chapter ${chapter.chapterNumber} contains duplicate audit issues.`);
    }
    if (new Set(chapter.lengthWarnings).size !== chapter.lengthWarnings.length) {
      reasons.push(`Chapter ${chapter.chapterNumber} contains duplicate length warnings.`);
    }
  }
  if (externalFailure) reasons.push(externalFailure);
  return { passed: reasons.length === 0, reasons };
}

function buildChapterQualityReport(
  chapter: LinkedChapterReport,
  targetWords: number,
): LinkedQualityChapterReport {
  const reasons: string[] = [];
  const minimumWords = Math.floor(targetWords * 0.728);
  const maximumWords = Math.ceil(targetWords * 1.272);
  if (chapter.status !== "ready-for-review") {
    reasons.push(`status is ${chapter.status}, expected ready-for-review`);
  }
  if (chapter.auditIssues.some((issue) => issue.startsWith("[critical]"))) {
    reasons.push("critical audit issues remain");
  }
  if (chapter.wordCount < minimumWords || chapter.wordCount > maximumWords) {
    reasons.push(`word count ${chapter.wordCount} is outside ${minimumWords}-${maximumWords}`);
  }
  return {
    chapterNumber: chapter.chapterNumber,
    status: chapter.status,
    passed: reasons.length === 0,
    reasons,
  };
}

function buildQualityGate(
  chapters: ReadonlyArray<LinkedChapterReport>,
  targetWords: number,
  policy: LinkedQualityPolicy,
): LinkedQualityGateReport {
  const chapterReports = chapters.map((chapter) => buildChapterQualityReport(chapter, targetWords));
  const reasons = chapterReports.flatMap((chapter) =>
    chapter.reasons.map((reason) => `Chapter ${chapter.chapterNumber}: ${reason}`)
  );
  if (chapterReports.length === 0) reasons.push("No persisted chapters were available for quality evaluation.");
  return {
    passed: chapterReports.length > 0 && chapterReports.every((chapter) => chapter.passed),
    policy,
    enforced: policy === "strict",
    chapters: chapterReports,
    reasons,
  };
}

async function recoverReportOnlyChapter(params: {
  readonly page: Page;
  readonly request: APIRequestContext;
  readonly bookId: string;
  readonly chapter: LinkedChapterSnapshot;
  readonly operationTimeoutMs: number;
  readonly tokenBudget: number;
  readonly onAction: (
    action: LinkedRecoveryActionReport,
    chapter: LinkedChapterSnapshot,
  ) => Promise<void>;
}): Promise<LinkedChapterSnapshot> {
  let chapter = params.chapter;

  const recoverState = async (): Promise<void> => {
    if (chapter.status !== "state-degraded") return;
    chapter = await runAsyncRecoveryAction({ ...params, chapter, kind: "repair-state" });
    if (chapter.status === "state-degraded") {
      chapter = await runAsyncRecoveryAction({ ...params, chapter, kind: "resync" });
    }
  };

  await recoverState();
  if (chapter.status === "audit-failed") {
    chapter = await runRevisionRecoveryAction(params, chapter);
    if (chapter.status === "audit-failed") {
      chapter = await runAsyncRecoveryAction({ ...params, chapter, kind: "rewrite" });
      await recoverState();
    }
  }

  return chapter;
}

async function runRevisionRecoveryAction(
  params: {
    readonly page: Page;
    readonly request: APIRequestContext;
    readonly bookId: string;
    readonly operationTimeoutMs: number;
    readonly tokenBudget: number;
    readonly onAction: (
      action: LinkedRecoveryActionReport,
      chapter: LinkedChapterSnapshot,
    ) => Promise<void>;
  },
  chapter: LinkedChapterSnapshot,
): Promise<LinkedChapterSnapshot> {
  const eventOffset = (await readLinkedEvents(params.page)).length;
  const endpoint = `/api/v1/books/${encodeURIComponent(params.bookId)}/revise/${chapter.number}`;
  let response: BrowserPostResult;
  try {
    response = await postJsonFromBrowser(params.page, endpoint, {
      mode: "auto",
      brief: "Resolve all persisted critical audit issues without changing established facts.",
    });
  } catch (cause) {
    const action = await buildFailedRecoveryAction(params.page, eventOffset, "revise", chapter, cause);
    await params.onAction(action, chapter);
    throw cause;
  }

  const requestId = typeof response.body.requestId === "string" ? response.body.requestId : "";
  if (response.status !== 202 || !requestId) {
    const error = readBrowserApiError(response);
    const action = await buildFailedRecoveryAction(params.page, eventOffset, "revise", chapter, error, response.status);
    await params.onAction(action, chapter);
    throw new Error(error);
  }

  const terminal = await waitForAsyncOperationTerminal(
    params.page,
    params.bookId,
    "revise",
    requestId,
    params.operationTimeoutMs,
    params.tokenBudget,
  );
  const recovered = terminal.event === "revise:complete"
    ? await loadChapter(params.request, params.bookId, chapter.number)
    : chapter;
  const actionEvents = (await readLinkedEvents(params.page)).slice(eventOffset);
  const telemetry = recoveryTelemetry(actionEvents);
  const error = terminal.event === "revise:error"
    ? String(terminal.data?.error ?? "Revision recovery failed.")
    : undefined;
  await params.onAction({
    kind: "revise",
    statusBefore: chapter.status,
    statusAfter: recovered.status,
    httpStatus: response.status,
    requestId,
    ...(typeof terminal.data?.operationId === "string" ? { operationId: terminal.data.operationId } : {}),
    terminalEvent: terminal.event,
    resultStatus: typeof terminal.data?.resultStatus === "string"
      ? terminal.data.resultStatus
      : typeof terminal.data?.status === "string"
        ? terminal.data.status
        : undefined,
    ...(error ? { error } : {}),
    totalTokens: sumTelemetryTokens(actionEvents),
    telemetry,
  }, recovered);
  if (error) throw new Error(error);
  return recovered;
}

async function runAsyncRecoveryAction(params: {
  readonly page: Page;
  readonly request: APIRequestContext;
  readonly bookId: string;
  readonly chapter: LinkedChapterSnapshot;
  readonly kind: Exclude<LinkedRecoveryKind, "revise">;
  readonly operationTimeoutMs: number;
  readonly tokenBudget: number;
  readonly onAction: (
    action: LinkedRecoveryActionReport,
    chapter: LinkedChapterSnapshot,
  ) => Promise<void>;
}): Promise<LinkedChapterSnapshot> {
  const eventOffset = (await readLinkedEvents(params.page)).length;
  const endpoint = `/api/v1/books/${encodeURIComponent(params.bookId)}/${params.kind}/${params.chapter.number}`;
  const requestBody = params.kind === "rewrite"
    ? { brief: "Rewrite this chapter to resolve all persisted critical audit issues without changing established facts." }
    : {};
  let response: BrowserPostResult;
  try {
    response = await postJsonFromBrowser(params.page, endpoint, requestBody);
  } catch (cause) {
    const action = await buildFailedRecoveryAction(params.page, eventOffset, params.kind, params.chapter, cause);
    await params.onAction(action, params.chapter);
    throw cause;
  }

  const requestId = typeof response.body.requestId === "string" ? response.body.requestId : "";
  if (response.status !== 202 || !requestId) {
    const error = readBrowserApiError(response);
    const action = await buildFailedRecoveryAction(
      params.page,
      eventOffset,
      params.kind,
      params.chapter,
      error,
      response.status,
    );
    await params.onAction(action, params.chapter);
    throw new Error(error);
  }

  const terminal = await waitForAsyncOperationTerminal(
    params.page,
    params.bookId,
    params.kind,
    requestId,
    params.operationTimeoutMs,
    params.tokenBudget,
  );
  const recovered = terminal.event === `${params.kind}:complete`
    ? await loadChapter(params.request, params.bookId, params.chapter.number)
    : params.chapter;
  const actionEvents = (await readLinkedEvents(params.page)).slice(eventOffset);
  const telemetry = recoveryTelemetry(actionEvents);
  const operationId = typeof terminal.data?.operationId === "string"
    ? terminal.data.operationId
    : uniqueTelemetryOperationId(telemetry);
  const error = terminal.event === `${params.kind}:complete`
    ? undefined
    : String(terminal.data?.error ?? `${params.kind} recovery ended with ${terminal.event}.`);
  await params.onAction({
    kind: params.kind,
    statusBefore: params.chapter.status,
    statusAfter: recovered.status,
    httpStatus: response.status,
    requestId,
    ...(operationId ? { operationId } : {}),
    terminalEvent: terminal.event,
    resultStatus: typeof terminal.data?.resultStatus === "string"
      ? terminal.data.resultStatus
      : typeof terminal.data?.status === "string"
        ? terminal.data.status
        : undefined,
    ...(error ? { error } : {}),
    totalTokens: sumTelemetryTokens(actionEvents),
    telemetry,
  }, recovered);
  if (error) throw new Error(error);
  return recovered;
}

interface BrowserPostResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function postJsonFromBrowser(
  page: Page,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<BrowserPostResult> {
  return await page.evaluate(async ({ target, payload }) => {
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = { error: text || `HTTP ${response.status}` };
    }
    return { status: response.status, body: parsed };
  }, { target: endpoint, payload: body });
}

function readBrowserApiError(response: BrowserPostResult): string {
  if (typeof response.body.error === "string") return response.body.error;
  if (response.body.error && typeof response.body.error === "object") {
    const structured = response.body.error as Record<string, unknown>;
    if (typeof structured.message === "string") {
      return typeof structured.code === "string"
        ? `${structured.code}: ${structured.message}`
        : structured.message;
    }
  }
  return `Request failed with HTTP ${response.status}.`;
}

async function buildFailedRecoveryAction(
  page: Page,
  eventOffset: number,
  kind: LinkedRecoveryKind,
  chapter: LinkedChapterSnapshot,
  cause: unknown,
  httpStatus = 0,
): Promise<LinkedRecoveryActionReport> {
  const actionEvents = (await readLinkedEvents(page)).slice(eventOffset);
  return {
    kind,
    statusBefore: chapter.status,
    statusAfter: chapter.status,
    httpStatus,
    error: cause instanceof Error ? cause.message : String(cause),
    totalTokens: sumTelemetryTokens(actionEvents),
    telemetry: recoveryTelemetry(actionEvents),
  };
}

function recoveryTelemetry(events: ReadonlyArray<LinkedEvent>): ReadonlyArray<Record<string, unknown>> {
  return events
    .filter((event) => event.event === "llm:telemetry")
    .map((event) => sanitizeTelemetry(event.data ?? {}));
}

function uniqueTelemetryOperationId(telemetry: ReadonlyArray<Record<string, unknown>>): string | undefined {
  const ids = new Set(
    telemetry
      .map((entry) => entry.operationId)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  return ids.size === 1 ? [...ids][0] : undefined;
}

function updateChapterReport(report: LinkedChapterReport, chapter: LinkedChapterSnapshot): void {
  report.persistedOperationId = chapter.operationId ?? report.persistedOperationId;
  report.status = chapter.status;
  report.wordCount = chapter.wordCount;
  report.auditIssues = chapter.auditIssues ?? [];
  report.lengthWarnings = chapter.lengthWarnings ?? [];
}

async function startLinkedEventCollector(page: Page): Promise<void> {
  await page.evaluate((eventNames) => {
    const linkedWindow = window as typeof window & {
      __inkosLinkedEvents?: LinkedEvent[];
      __inkosLinkedEventSource?: EventSource;
    };
    linkedWindow.__inkosLinkedEventSource?.close();
    linkedWindow.__inkosLinkedEvents = [];
    const source = new EventSource("/api/v1/events");
    linkedWindow.__inkosLinkedEventSource = source;
    for (const eventName of eventNames) {
      source.addEventListener(eventName, (event) => {
        const message = event as MessageEvent<string>;
        let data: Record<string, unknown> | null = null;
        try {
          data = message.data ? JSON.parse(message.data) as Record<string, unknown> : null;
        } catch {
          data = null;
        }
        linkedWindow.__inkosLinkedEvents?.push({ event: eventName, data, timestamp: Date.now() });
      });
    }
    return new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = window.setTimeout(() => rejectOpen(new Error("Linked SSE collector did not connect.")), 15_000);
      source.addEventListener("open", () => {
        window.clearTimeout(timeout);
        resolveOpen();
      }, { once: true });
      source.addEventListener("error", () => {
        if (source.readyState === EventSource.CLOSED) {
          window.clearTimeout(timeout);
          rejectOpen(new Error("Linked SSE collector closed before connecting."));
        }
      });
    });
  }, [...LINKED_EVENT_NAMES]);
}

async function stopLinkedEventCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    const linkedWindow = window as typeof window & { __inkosLinkedEventSource?: EventSource };
    linkedWindow.__inkosLinkedEventSource?.close();
    delete linkedWindow.__inkosLinkedEventSource;
  });
}

async function readLinkedEvents(page: Page): Promise<LinkedEvent[]> {
  return await page.evaluate(() => {
    const linkedWindow = window as typeof window & { __inkosLinkedEvents?: LinkedEvent[] };
    return [...(linkedWindow.__inkosLinkedEvents ?? [])];
  });
}

async function createBookFromBrowser(
  page: Page,
  payload: Record<string, unknown>,
): Promise<BrowserPostResult> {
  return await page.evaluate(async (body) => {
    const response = await fetch("/api/v1/books/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
    };
  }, payload);
}

async function navigateHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((nextHash) => {
    window.location.hash = nextHash;
  }, hash);
  await expect(page).toHaveURL(`/${hash}`);
}

async function waitForCreateReady(request: APIRequestContext, bookId: string): Promise<void> {
  const deadline = Date.now() + creationTimeoutMs;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    const response = await request.get(`/api/v1/books/${encodeURIComponent(bookId)}/create-status`);
    if (response.status() !== 404) {
      const body = await response.json() as { status?: string; error?: string };
      lastStatus = body.status ?? `HTTP ${response.status()}`;
      if (body.status === "ready") return;
      if (body.status === "error") throw new Error(body.error ?? `Book ${bookId} creation failed.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Timed out waiting for book ${bookId} creation; last status: ${lastStatus}.`);
}

async function waitForChapter(
  request: APIRequestContext,
  bookId: string,
  chapterNumber: number,
): Promise<BookDetailResponse> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await request.get(`/api/v1/books/${encodeURIComponent(bookId)}`);
    const body = await response.json() as BookDetailResponse;
    if (body.chapters.some((chapter) => chapter.number === chapterNumber && chapter.operationId)) return body;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Chapter ${chapterNumber} did not become visible for ${bookId}.`);
}

async function loadChapter(
  request: APIRequestContext,
  bookId: string,
  chapterNumber: number,
): Promise<LinkedChapterSnapshot> {
  const response = await request.get(`/api/v1/books/${encodeURIComponent(bookId)}`);
  if (!response.ok()) {
    throw new Error(`Could not refresh chapter ${chapterNumber}; Studio returned HTTP ${response.status()}.`);
  }
  const body = await response.json() as BookDetailResponse;
  const chapter = body.chapters.find((entry) => entry.number === chapterNumber);
  if (!chapter) throw new Error(`Chapter ${chapterNumber} disappeared while applying linked recovery.`);
  return chapter;
}

async function waitForEvent(
  page: Page,
  eventOffset: number,
  timeoutMs: number,
  predicate: (event: LinkedEvent) => boolean,
): Promise<LinkedEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = (await readLinkedEvents(page)).slice(eventOffset).find(predicate);
    if (event) return event;
    await page.waitForTimeout(250);
  }
  throw new Error("Timed out waiting for a linked recovery event.");
}

async function waitForAsyncOperationTerminal(
  page: Page,
  bookId: string,
  kind: "write" | LinkedRecoveryKind,
  requestId: string,
  timeoutMs: number,
  tokenBudget: number,
): Promise<LinkedEvent> {
  const deadline = Date.now() + timeoutMs;
  let cancellationRequested = false;
  while (Date.now() < deadline) {
    const events = await readLinkedEvents(page);
    const terminal = [...events].reverse().find((event) =>
      [`${kind}:complete`, `${kind}:error`, `${kind}:cancelled`].includes(event.event)
      && event.data?.requestId === requestId,
    );
    if (terminal) return terminal;

    const durableTerminal = await readAsyncOperationTerminal(page, bookId, requestId, kind);
    if (durableTerminal) return durableTerminal;

    if (!cancellationRequested && tokenBudget > 0 && sumTelemetryTokens(events) > tokenBudget) {
      cancellationRequested = true;
      await page.evaluate(async ({ targetBookId, targetRequestId }) => {
        await fetch(
          `/api/v1/books/${encodeURIComponent(targetBookId)}/operations/${encodeURIComponent(targetRequestId)}/cancel`,
          { method: "POST" },
        );
      }, { targetBookId: bookId, targetRequestId: requestId });
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for ${kind} operation ${requestId}.`);
}

async function readAsyncOperationTerminal(
  page: Page,
  bookId: string,
  requestId: string,
  kind: "write" | LinkedRecoveryKind,
): Promise<LinkedEvent | null> {
  const result = await page.evaluate(async ({ targetBookId, targetRequestId }) => {
    try {
      const response = await fetch(
        `/api/v1/books/${encodeURIComponent(targetBookId)}/operations/${encodeURIComponent(targetRequestId)}`,
      );
      if (!response.ok) return null;
      return await response.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }, { targetBookId: bookId, targetRequestId: requestId });
  if (!result) return null;
  const terminalEvent = typeof result.terminalEvent === "string" ? result.terminalEvent : "";
  if (![`${kind}:complete`, `${kind}:error`, `${kind}:cancelled`].includes(terminalEvent)) return null;
  return { event: terminalEvent, data: result, timestamp: Date.now() };
}

function sanitizeTelemetry(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    operationId: entry.operationId,
    bookId: entry.bookId,
    agent: entry.agent,
    phase: entry.phase,
    status: entry.status,
    service: entry.service,
    model: entry.model,
    durationMs: entry.durationMs,
    totalTokens: entry.totalTokens,
    promptEstimatedTokens: entry.promptEstimatedTokens,
    usageEstimated: entry.usageEstimated,
    attemptCount: entry.attemptCount,
    retryCount: entry.retryCount,
    errorMessage: entry.errorMessage,
  };
}

function assertPromptBudget(
  events: ReadonlyArray<LinkedEvent>,
  maximum: number,
  label: string,
): void {
  if (maximum <= 0) return;
  const violation = events
    .filter((event) => event.event === "llm:telemetry")
    .map((event) => event.data ?? {})
    .find((entry) =>
      typeof entry.promptEstimatedTokens === "number"
      && entry.promptEstimatedTokens > maximum,
    );
  if (!violation) return;
  throw new Error(
    `${label} ${String(violation.agent ?? "unknown")}/${String(violation.phase ?? "unknown")} prompt used `
    + `${String(violation.promptEstimatedTokens)} estimated input tokens, exceeding the per-call budget of ${maximum}.`,
  );
}

function sumTelemetryTokens(events: ReadonlyArray<LinkedEvent>): number {
  return events
    .filter((event) => event.event === "llm:telemetry")
    .reduce((sum, event) => sum + (typeof event.data?.totalTokens === "number" ? event.data.totalTokens : 0), 0);
}

function buildFailureSignature(
  stage: string,
  message: string,
  report: { chapters: LinkedChapterReport[]; creationAttempts: LinkedCreationAttemptReport[] },
): string {
  const normalized = message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|minutes?|tokens?|字)?\b/gi, "<number>")
    .slice(0, 1000);
  const basis = {
    stage: stage.replace(/chapter-\d+/g, "chapter-N"),
    message: normalized,
    chapterStatuses: report.chapters.map((chapter) => chapter.status),
    creationStatuses: report.creationAttempts.map((attempt) => attempt.status),
    auditIssues: report.chapters.flatMap((chapter) => chapter.auditIssues)
      .map((issue) => issue.replace(/\b(?:c|H)\d+\b/gi, "<id>")),
    telemetryFailures: report.chapters.flatMap((chapter) => chapter.telemetry)
      .filter((entry) => entry.status !== "success")
      .map((entry) => ({ agent: entry.agent, phase: entry.phase, status: entry.status })),
  };
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 20);
}

async function persistReport(
  path: string,
  report: LinkedRunReport,
  testInfo: TestInfo,
  stage: string,
): Promise<void> {
  await writeReportCheckpoint(path, report, stage);
  await testInfo.attach("linked-acceptance-report", { path, contentType: "application/json" });
}

async function writeReportCheckpoint(path: string, report: LinkedRunReport, stage: string): Promise<void> {
  report.lastStage = stage;
  report.updatedAt = new Date().toISOString();
  await writeLinkedReportCheckpoint(path, report);
}
