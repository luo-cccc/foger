import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

const LINKED_EVENT_NAMES = [
  "book:creating",
  "book:created",
  "book:error",
  "write:start",
  "write:complete",
  "write:error",
  "write:cancel-requested",
  "write:cancelled",
  "llm:telemetry",
] as const;

interface LinkedEvent {
  readonly event: string;
  readonly data: Record<string, unknown> | null;
  readonly timestamp: number;
}

interface BookDetailResponse {
  readonly book: { readonly id: string };
  readonly chapters: ReadonlyArray<{
    readonly number: number;
    readonly status: string;
    readonly wordCount: number;
    readonly operationId?: string;
    readonly auditIssues?: ReadonlyArray<string>;
    readonly lengthWarnings?: ReadonlyArray<string>;
  }>;
}

interface LinkedChapterReport {
  readonly chapterNumber: number;
  readonly requestId: string;
  readonly operationId: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssues: ReadonlyArray<string>;
  readonly lengthWarnings: ReadonlyArray<string>;
  readonly telemetry: ReadonlyArray<Record<string, unknown>>;
}

const liveMode = process.env.INKOS_E2E_LLM_MODE === "live";
const requestedChapters = Math.max(1, readPositiveInteger("INKOS_LINKED_CHAPTERS", 1));
const wordsPerChapter = Math.max(1000, readPositiveInteger("INKOS_LINKED_WORDS", 1000));
const maxTotalTokens = readPositiveInteger("INKOS_LINKED_MAX_TOTAL_TOKENS", 0);
const maxPromptTokensPerCall = readPositiveInteger("INKOS_LINKED_MAX_PROMPT_TOKENS_PER_CALL", 0);
const creationTimeoutMs = liveMode ? 30 * 60_000 : 180_000;
const operationTimeoutMs = liveMode ? 30 * 60_000 : 180_000;

test("@linked correlates browser, Studio API, Core telemetry, persistence, and Doctor", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(creationTimeoutMs + operationTimeoutMs * requestedChapters + 120_000);

  const reportPath = resolve(
    process.env.INKOS_LINKED_REPORT_PATH?.trim() || testInfo.outputPath("linked-acceptance.json"),
  );
  const report: {
    status: "running" | "passed" | "failed";
    mode: "stub" | "live";
    runFingerprint: string;
    startedAt: string;
    finishedAt?: string;
    scenario: {
      chapters: number;
      wordsPerChapter: number;
      maxTotalTokens: number;
      maxPromptTokensPerCall: number;
    };
    bookId?: string;
    chapters: LinkedChapterReport[];
    totalTokens: number;
    failureStage?: string;
    failureMessage?: string;
    failureSignature?: string;
    failureTelemetry?: ReadonlyArray<Record<string, unknown>>;
  } = {
    status: "running",
    mode: liveMode ? "live" : "stub",
    runFingerprint: process.env.INKOS_LINKED_RUN_FINGERPRINT?.trim() || "untracked",
    startedAt: new Date().toISOString(),
    scenario: { chapters: requestedChapters, wordsPerChapter, maxTotalTokens, maxPromptTokensPerCall },
    chapters: [],
    totalTokens: 0,
  };
  let stage = "browser-start";

  try {
    await page.goto("/");
    await startLinkedEventCollector(page);

    stage = "book-create";
    const title = `Linked Acceptance ${liveMode ? "Live" : "Stub"} ${Date.now()}`;
    const creation = await createBookFromBrowser(page, {
      title,
      genre: "urban",
      language: "zh",
      platform: "other",
      chapterWordCount: wordsPerChapter,
      targetChapters: Math.max(12, requestedChapters),
      blurb: "近未来港城中，一名账房追查导师失踪与伪造债务账本，证据必须通过行动、对话和可验证物件逐步推进。",
    });
    expect(creation.status).toBe(200);
    expect(creation.body.status).toBe("creating");
    expect(creation.body.bookId).toEqual(expect.any(String));
    const bookId = creation.body.bookId;
    report.bookId = bookId;
    await waitForCreateReady(request, bookId);

    const creationEvents = await readLinkedEvents(page);
    expect(creationEvents.some((event) => event.event === "book:creating" && event.data?.bookId === bookId)).toBe(true);
    expect(creationEvents.some((event) => event.event === "book:created" && event.data?.bookId === bookId)).toBe(true);
    const creationTokens = sumTelemetryTokens(creationEvents);
    if (maxTotalTokens > 0 && creationTokens > maxTotalTokens) {
      throw new Error(`Book creation used ${creationTokens} tokens, exceeding the linked run budget of ${maxTotalTokens}.`);
    }
    assertPromptBudget(creationEvents, maxPromptTokensPerCall, "Book creation");

    await navigateHash(page, `#/book/${encodeURIComponent(bookId)}/settings`);
    await expect(page.getByTestId("write-next-button")).toBeVisible();

    for (let chapterNumber = 1; chapterNumber <= requestedChapters; chapterNumber += 1) {
      stage = `chapter-${chapterNumber}-start`;
      const responsePromise = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && response.url().includes(`/api/v1/books/${encodeURIComponent(bookId)}/write-next`),
      );
      await page.getByTestId("write-next-button").click();
      const response = await responsePromise;
      expect(response.status()).toBe(202);
      const startBody = await response.json() as { requestId?: unknown };
      expect(startBody.requestId).toEqual(expect.any(String));
      const requestId = String(startBody.requestId);

      stage = `chapter-${chapterNumber}-pipeline`;
      const terminal = await waitForOperationTerminal(page, bookId, requestId, operationTimeoutMs, maxTotalTokens);
      if (terminal.event !== "write:complete") {
        throw new Error(
          terminal.event === "write:cancelled"
            ? `Write operation ${requestId} was cancelled after reaching the linked token budget.`
            : String(terminal.data?.error ?? `Write operation ended with ${terminal.event}.`),
        );
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
      expect(telemetry.length).toBeGreaterThan(0);
      expect(telemetry.every((entry) => entry.bookId === bookId)).toBe(true);

      const book = await waitForChapter(request, bookId, chapterNumber);
      const chapter = book.chapters.find((entry) => entry.number === chapterNumber);
      const chapterReport: LinkedChapterReport = {
        chapterNumber,
        requestId,
        operationId,
        status: chapter?.status ?? "missing",
        wordCount: chapter?.wordCount ?? 0,
        auditIssues: chapter?.auditIssues ?? [],
        lengthWarnings: chapter?.lengthWarnings ?? [],
        telemetry: telemetry.map(sanitizeTelemetry),
      };
      report.chapters.push(chapterReport);
      report.totalTokens = sumTelemetryTokens(await readLinkedEvents(page));
      assertPromptBudget(events, maxPromptTokensPerCall, `Chapter ${chapterNumber}`);

      expect(chapter?.operationId).toBe(operationId);
      expect(chapter?.status).toBe("ready-for-review");
      expect(new Set(chapter?.auditIssues ?? []).size).toBe(chapter?.auditIssues?.length ?? 0);
      expect((chapter?.auditIssues ?? []).some((issue) => issue.startsWith("[critical]"))).toBe(false);
      expect(new Set(chapter?.lengthWarnings ?? []).size).toBe(chapter?.lengthWarnings?.length ?? 0);
      expect(chapter?.wordCount).toBeGreaterThanOrEqual(Math.floor(wordsPerChapter * 0.728));
      expect(chapter?.wordCount).toBeLessThanOrEqual(Math.ceil(wordsPerChapter * 1.272));

      stage = `chapter-${chapterNumber}-doctor`;
      await expect(page.getByTestId(`chapter-row-${chapterNumber}`)).toBeVisible();
      await page.getByTestId(`chapter-operation-${chapterNumber}`).click();
      await expect(page).toHaveURL(`/#/doctor?operationId=${encodeURIComponent(operationId)}`);
      await expect(page.getByTestId("operation-trace-filter")).toContainText(operationId);
      await expect(page.getByTestId("operation-telemetry-call-count")).not.toContainText("还没有最近调用");
      await expect(page.getByTestId("operation-telemetry-call-count")).not.toContainText("No recent calls yet");

      if (chapterNumber < requestedChapters) {
        await navigateHash(page, `#/book/${encodeURIComponent(bookId)}/settings`);
        await expect(page.getByTestId("write-next-button")).toBeEnabled();
      }
    }

    stage = "complete";
    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    await persistReport(reportPath, report, testInfo);
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
    report.failureSignature = buildFailureSignature(stage, message, report);
    report.finishedAt = new Date().toISOString();
    await persistReport(reportPath, report, testInfo).catch(() => undefined);
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
): Promise<{ status: number; body: { status?: string; bookId: string } }> {
  return await page.evaluate(async (body) => {
    const response = await fetch("/api/v1/books/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json() as { status?: string; bookId: string },
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

async function waitForOperationTerminal(
  page: Page,
  bookId: string,
  requestId: string,
  timeoutMs: number,
  tokenBudget: number,
): Promise<LinkedEvent> {
  const deadline = Date.now() + timeoutMs;
  let cancellationRequested = false;
  while (Date.now() < deadline) {
    const events = await readLinkedEvents(page);
    const terminal = [...events].reverse().find((event) =>
      ["write:complete", "write:error", "write:cancelled"].includes(event.event)
      && event.data?.requestId === requestId,
    );
    if (terminal) return terminal;

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
  throw new Error(`Timed out waiting for write operation ${requestId}.`);
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

function buildFailureSignature(stage: string, message: string, report: { chapters: LinkedChapterReport[] }): string {
  const normalized = message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|minutes?|tokens?|字)?\b/gi, "<number>")
    .slice(0, 1000);
  const basis = {
    stage: stage.replace(/chapter-\d+/g, "chapter-N"),
    message: normalized,
    chapterStatuses: report.chapters.map((chapter) => chapter.status),
    auditIssues: report.chapters.flatMap((chapter) => chapter.auditIssues)
      .map((issue) => issue.replace(/\b(?:c|H)\d+\b/gi, "<id>")),
    telemetryFailures: report.chapters.flatMap((chapter) => chapter.telemetry)
      .filter((entry) => entry.status !== "success")
      .map((entry) => ({ agent: entry.agent, phase: entry.phase, status: entry.status })),
  };
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 20);
}

async function persistReport(path: string, report: unknown, testInfo: TestInfo): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await testInfo.attach("linked-acceptance-report", { path, contentType: "application/json" });
}
