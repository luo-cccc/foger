import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface BookDetailResponse {
  readonly book: {
    readonly id: string;
  };
  readonly chapters: ReadonlyArray<{
    readonly number: number;
    readonly status: string;
    readonly operationId?: string;
  }>;
}

interface TruthListResponse {
  readonly files: ReadonlyArray<{
    readonly name: string;
    readonly readonlyReason?: string;
  }>;
}

interface CreateBookResponse {
  readonly status: string;
  readonly bookId: string;
}

interface CreateStatusResponse {
  readonly status: "creating" | "ready" | "error" | "missing";
  readonly error?: string;
}

async function readE2eProjectRoot(): Promise<string> {
  const runtimePath = process.env.INKOS_E2E_RUNTIME_FILE;
  if (!runtimePath) {
    throw new Error("INKOS_E2E_RUNTIME_FILE is required for filesystem-backed E2E fixtures.");
  }
  const runtime = JSON.parse(await readFile(runtimePath, "utf-8")) as { projectRoot?: unknown };
  if (typeof runtime.projectRoot !== "string" || !runtime.projectRoot) {
    throw new Error("The E2E runtime metadata does not contain a project root.");
  }
  return runtime.projectRoot;
}

async function pollUntil<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  options: {
    readonly timeoutMs: number;
    readonly intervalMs?: number;
    readonly description: string;
  },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 1000;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await read();
    if (ready(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${options.description}. Last value: ${JSON.stringify(lastValue)}`);
}

async function readJson<T>(response: APIResponse): Promise<T> {
  expect(response.ok()).toBe(true);
  return await response.json() as T;
}

const chapterPersistenceProcess = fileURLToPath(
  new URL("./fixtures/chapter-persistence-process.mjs", import.meta.url),
);

async function waitForChildLine(child: ChildProcess, prefix: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for child output ${prefix}. stderr: ${stderr}`));
    }, 30_000);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
      if (line) {
        clearTimeout(timeout);
        resolve(line.slice(prefix.length));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Child exited before ${prefix}: code=${code} signal=${signal}. stderr: ${stderr}`));
    });
  });
}

async function forceKillChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) throw new Error("Cannot kill a child process without a PID.");

  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGKILL");
  }
  await closed;
}

async function runRecoveryProcess(projectRoot: string, bookId: string, operationId: string): Promise<{
  readonly kind: string;
  readonly chapterNumber?: number;
  readonly rolledBackTo?: number;
  readonly operationId?: string;
}> {
  const child = spawn(process.execPath, [chapterPersistenceProcess, "recover", projectRoot, bookId, operationId], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const { exitCode, stdout, stderr } = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
  expect(exitCode, stderr).toBe(0);
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith("INKOS_RECOVERY_RESULT "));
  if (!resultLine) throw new Error(`Recovery process did not return a result. stderr: ${stderr}`);
  return JSON.parse(resultLine.slice("INKOS_RECOVERY_RESULT ".length));
}

async function createBook(request: APIRequestContext): Promise<string> {
  const title = `E2E Stub Create ${Date.now()}`;
  const response = await request.post("/api/v1/books/create", {
    data: {
      title,
      genre: "urban",
      language: "zh",
      platform: "other",
      chapterWordCount: 1200,
      targetChapters: 12,
      blurb: "A clerk traces a forged harbor debt ledger after his mentor disappears.",
    },
  });
  const data = await readJson<CreateBookResponse>(response);
  expect(data.status).toBe("creating");
  return data.bookId;
}

async function waitForCreateReady(request: APIRequestContext, bookId: string): Promise<void> {
  await pollUntil(
    async () => {
      const response = await request.get(`/api/v1/books/${encodeURIComponent(bookId)}/create-status`);
      if (response.status() === 404) {
        return { status: "missing" } as CreateStatusResponse;
      }
      return await readJson<CreateStatusResponse>(response);
    },
    (value) => {
      if (value.status === "error") {
        throw new Error(`Book creation failed for ${bookId}: ${value.error ?? "Unknown error"}`);
      }
      return value.status === "ready";
    },
    {
      timeoutMs: 180_000,
      description: `book ${bookId} foundation creation to finish`,
    },
  );
}

async function waitForBook(request: APIRequestContext, bookId: string): Promise<BookDetailResponse> {
  return await pollUntil(
    async () => {
      const response = await request.get(`/api/v1/books/${encodeURIComponent(bookId)}`);
      return await readJson<BookDetailResponse>(response);
    },
    (value) => value.book.id === bookId,
    {
      timeoutMs: 30_000,
      description: `book ${bookId} to be available`,
    },
  );
}

async function waitForFirstChapter(request: APIRequestContext, bookId: string): Promise<BookDetailResponse> {
  return await pollUntil(
    async () => {
      const response = await request.get(`/api/v1/books/${encodeURIComponent(bookId)}`);
      return await readJson<BookDetailResponse>(response);
    },
    (value) => value.chapters.some((chapter) =>
      chapter.number === 1 && typeof chapter.operationId === "string" && chapter.operationId.length > 0,
    ),
    {
      timeoutMs: 180_000,
      description: `book ${bookId} to commit chapter 1 with an operation ID`,
    },
  );
}

async function waitForRuntimeDiagnosticFile(request: APIRequestContext, bookId: string): Promise<string> {
  const truth = await pollUntil(
    async () => {
      const response = await request.get(`/api/v1/books/${encodeURIComponent(bookId)}/truth`);
      return await readJson<TruthListResponse>(response);
    },
    (value) => value.files.some((file) =>
      file.readonlyReason === "runtime-diagnostic" && file.name.includes("chapter-0001"),
    ),
    {
      timeoutMs: 60_000,
      description: `book ${bookId} to expose chapter runtime diagnostics`,
    },
  );

  const file = truth.files.find((entry) =>
    entry.readonlyReason === "runtime-diagnostic" && entry.name.includes("chapter-0001"),
  );
  if (!file) {
    throw new Error(`No chapter runtime diagnostic file found for ${bookId}.`);
  }
  return file.name;
}

test("creates a book, writes a chapter, and opens runtime truth diagnostics from the Studio workbench", async ({
  page,
  request,
}) => {
  const bookId = await createBook(request);
  await waitForCreateReady(request, bookId);
  await waitForBook(request, bookId);

  await page.goto(`/#/book/${encodeURIComponent(bookId)}/settings`);
  await expect(page.getByTestId("write-next-button")).toBeVisible();

  await page.getByTestId("write-next-button").click();
  const writtenBook = await waitForFirstChapter(request, bookId);
  const operationId = writtenBook.chapters[0]?.operationId;
  expect(operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  if (!operationId) {
    throw new Error("Written chapter did not expose an operation ID.");
  }

  await page.reload();
  await expect(page.getByTestId("chapter-row-1")).toBeVisible();

  await page.getByTestId("chapter-operation-1").click();
  await expect(page).toHaveURL(`/#/doctor?operationId=${encodeURIComponent(operationId)}`);
  await expect(page.getByTestId("operation-trace-filter")).toContainText(operationId);

  await page.goto(`/#/book/${encodeURIComponent(bookId)}/settings`);
  await expect(page.getByTestId("chapter-row-1")).toBeVisible();

  const runtimeFile = await waitForRuntimeDiagnosticFile(request, bookId);

  await page.getByTestId("truth-files-button").click();
  await expect(page.getByTestId("truth-file-list")).toBeVisible();

  const runtimeFileButton = page.locator(
    `[data-testid="truth-file-button"][data-file-name="${runtimeFile}"]`,
  );
  await expect(runtimeFileButton).toBeVisible();
  await runtimeFileButton.click();

  await expect(page.getByTestId("runtime-diagnostic-warning")).toBeVisible();
});

test("cancels a long book operation, preserves durable state, and restarts cleanly", async ({
  page,
  request,
}) => {
  const bookId = await createBook(request);
  await waitForCreateReady(request, bookId);
  await waitForBook(request, bookId);

  await page.goto(`/#/book/${encodeURIComponent(bookId)}/settings`);
  await expect(page.getByTestId("write-next-button")).toBeVisible();

  await page.getByRole("button", { name: "重修设定" }).click();
  const promptDialog = page.getByRole("dialog", { name: "重修基础设定" });
  await expect(promptDialog.getByTestId("book-action-prompt-input")).toBeVisible();
  await promptDialog.getByRole("button", { name: "取消" }).click();
  await expect(promptDialog).toBeHidden();

  await page.getByTestId("write-next-button").click();
  const cancelButton = page.getByTestId("cancel-book-operation");
  await expect(cancelButton).toBeVisible();
  await expect(page.getByTestId("write-next-button")).toBeDisabled();
  await cancelButton.click();

  await expect(page.getByTestId("chapter-recovery-notice"))
    .toContainText("操作已取消，已保留取消前的持久化章节状态");
  await expect(page.getByTestId("write-next-button")).toBeEnabled();

  const cancelledBook = await readJson<BookDetailResponse>(
    await request.get(`/api/v1/books/${encodeURIComponent(bookId)}`),
  );
  expect(cancelledBook.chapters).toHaveLength(0);

  await page.getByTestId("write-next-button").click();
  const writtenBook = await waitForFirstChapter(request, bookId);
  expect(writtenBook.chapters).toHaveLength(1);

  const projectRoot = await readE2eProjectRoot();
  const indexPath = join(projectRoot, "books", bookId, "chapters", "index.json");
  const chapterIndex = JSON.parse(await readFile(indexPath, "utf-8")) as Array<Record<string, unknown>>;
  chapterIndex[0] = { ...chapterIndex[0], status: "state-degraded" };
  await writeFile(indexPath, `${JSON.stringify(chapterIndex, null, 2)}\n`, "utf-8");

  await page.reload();
  const repairButton = page.getByTestId("repair-state-1");
  await expect(repairButton).toBeVisible();
  await repairButton.click();
  await expect(page.getByTestId("chapter-recovery-notice"))
    .toContainText("章节状态修复已完成");

  const repairedBook = await pollUntil(
    async () => await readJson<BookDetailResponse>(
      await request.get(`/api/v1/books/${encodeURIComponent(bookId)}`),
    ),
    (value) => value.chapters[0]?.status === "ready-for-review",
    { timeoutMs: 30_000, description: `book ${bookId} state repair` },
  );
  expect(repairedBook.chapters[0]?.status).toBe("ready-for-review");
});

test("recovers an interrupted chapter transaction and preserves the recovery diagnostic", async ({
  page,
  request,
}) => {
  const bookId = "e2e-seeded-book";

  await page.goto(`/#/book/${bookId}/settings`);
  await expect(page.getByTestId("write-next-button")).toBeVisible();
  await page.getByTestId("write-next-button").click();
  const recoveredBook = await waitForFirstChapter(request, bookId);
  expect(recoveredBook.chapters[0]?.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  await expect(page.getByTestId("chapter-recovery-notice")).toBeVisible();

  const diagnostic = await readJson<{ content: string }>(
    await request.get(`/api/v1/books/${bookId}/truth/runtime/recovery.json`),
  );
  expect(JSON.parse(diagnostic.content)).toMatchObject({
    kind: "rolled-back",
    chapterNumber: 1,
    rolledBackTo: 0,
    operationId: "e2e-interrupted-operation",
  });

  await page.getByTestId("truth-files-button").click();
  const recoveryFile = page.locator(
    '[data-testid="truth-file-button"][data-file-name="runtime/recovery.json"]',
  );
  await expect(recoveryFile).toBeVisible();
  await recoveryFile.click();
  await expect(page.getByTestId("runtime-diagnostic-warning")).toBeVisible();
});

test("reclaims a killed writer lock and recovers partial persistence in a fresh process", async () => {
  const projectRoot = await readE2eProjectRoot();
  const bookId = `e2e-process-crash-${Date.now()}`;
  const operationId = "e2e-force-kill-restart-operation";
  const bookDir = join(projectRoot, "books", bookId);
  const storyDir = join(bookDir, "story");
  const chaptersDir = join(bookDir, "chapters");
  const child = spawn(process.execPath, [chapterPersistenceProcess, "prepare", projectRoot, bookId, operationId], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  try {
    const ready = JSON.parse(await waitForChildLine(child, "INKOS_PROCESS_READY ")) as {
      readonly pid: number;
      readonly operationId: string;
    };
    expect(ready.pid).toBe(child.pid);
    expect(ready.operationId).toBe(operationId);

    await forceKillChild(child);
    const recovery = await runRecoveryProcess(projectRoot, bookId, operationId);

    expect(recovery).toEqual({
      kind: "rolled-back",
      chapterNumber: 1,
      rolledBackTo: 0,
      operationId,
    });
    await expect(stat(join(chaptersDir, "0001_process-crash.md"))).rejects.toThrow();
    await expect(readFile(join(chaptersDir, "index.json"), "utf-8").then(JSON.parse)).resolves.toEqual([]);
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("state-before-process-crash");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("hooks-before-process-crash");
    await expect(stat(join(bookDir, ".chapter-persistence.json"))).rejects.toThrow();
    await expect(stat(join(bookDir, ".write.lock"))).rejects.toThrow();
    await expect(
      readFile(join(storyDir, "runtime", "recovery.json"), "utf-8").then(JSON.parse),
    ).resolves.toMatchObject({
      kind: "rolled-back",
      chapterNumber: 1,
      rolledBackTo: 0,
      operationId,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await forceKillChild(child).catch(() => undefined);
    }
    await rm(bookDir, { recursive: true, force: true });
  }
});

test("cleans a killed writer committed marker without rolling back committed artifacts", async () => {
  const projectRoot = await readE2eProjectRoot();
  const bookId = `e2e-process-committed-${Date.now()}`;
  const operationId = "e2e-force-kill-committed-operation";
  const bookDir = join(projectRoot, "books", bookId);
  const storyDir = join(bookDir, "story");
  const chaptersDir = join(bookDir, "chapters");
  const child = spawn(process.execPath, [
    chapterPersistenceProcess,
    "prepare-committed",
    projectRoot,
    bookId,
    operationId,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  try {
    const ready = JSON.parse(await waitForChildLine(child, "INKOS_PROCESS_READY ")) as {
      readonly pid: number;
      readonly operationId: string;
      readonly status: string;
    };
    expect(ready).toMatchObject({ pid: child.pid, operationId, status: "committed" });

    await forceKillChild(child);
    const recovery = await runRecoveryProcess(projectRoot, bookId, operationId);

    expect(recovery).toEqual({
      kind: "committed-cleanup",
      chapterNumber: 1,
      operationId,
    });
    await expect(readFile(join(chaptersDir, "0001_process-crash.md"), "utf-8"))
      .resolves.toBe("committed chapter");
    await expect(readFile(join(chaptersDir, "index.json"), "utf-8").then(JSON.parse))
      .resolves.toEqual([expect.objectContaining({ number: 1, title: "Committed before process crash" })]);
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8"))
      .resolves.toBe("state-after-partial-write");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8"))
      .resolves.toBe("hooks-after-partial-write");
    await expect(stat(join(bookDir, ".chapter-persistence.json"))).rejects.toThrow();
    await expect(stat(join(bookDir, ".write.lock"))).rejects.toThrow();
    await expect(
      readFile(join(storyDir, "runtime", "recovery.json"), "utf-8").then(JSON.parse),
    ).resolves.toMatchObject({
      kind: "committed-cleanup",
      chapterNumber: 1,
      operationId,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await forceKillChild(child).catch(() => undefined);
    }
    await rm(bookDir, { recursive: true, force: true });
  }
});

test("rejects a locked chapter mutation without changing the chapter", async ({ request }) => {
  const bookId = "e2e-seeded-book";
  let book = await waitForBook(request, bookId);
  if (book.chapters.length === 0) {
    const start = await request.post(`/api/v1/books/${bookId}/write-next`, { data: {} });
    expect(start.ok()).toBe(true);
    book = await waitForFirstChapter(request, bookId);
  }
  const target = book.chapters[0];
  if (!target) {
    throw new Error("Seeded E2E book did not contain a chapter to lock.");
  }

  const projectRoot = await readE2eProjectRoot();
  const lockPath = join(projectRoot, "books", bookId, ".write.lock");
  await writeFile(lockPath, `pid:${process.pid} ts:${Date.now()}`, "utf-8");

  try {
    const response = await request.post(`/api/v1/books/${bookId}/chapters/${target.number}/approve`);
    expect(response.status()).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "BOOK_LOCKED" } });
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }

  const after = await waitForBook(request, bookId);
  expect(after.chapters.find((chapter) => chapter.number === target.number)?.status).toBe(target.status);
});

test("shows an unknown-provider connection error without saving the form", async ({
  page,
  request,
}) => {
  const before = await readJson<{ services: unknown[] }>(
    await request.get("/api/v1/services/config"),
  );

  await page.goto("/#/services/e2e-unknown-provider");
  await expect(page.getByTestId("service-api-key")).toBeVisible();

  await page.getByTestId("service-api-key").fill("e2e-invalid-key");
  await page.getByTestId("service-test-connection").click();

  const error = page.getByTestId("service-connection-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("未知服务商");

  const after = await readJson<{ services: unknown[] }>(
    await request.get("/api/v1/services/config"),
  );
  expect(after).toEqual(before);
});

test("tests and saves a custom service after a successful stub probe", async ({
  page,
  request,
}) => {
  const before = await readJson<{
    services: unknown[];
    service: string | null;
    defaultModel: string | null;
    storedConfigSource: string;
  }>(await request.get("/api/v1/services/config"));
  const savedBaseUrl = "http://127.0.0.1:11436/v1";
  try {
    await page.goto("/#/services/custom%3ACustom");
    await expect(page.getByTestId("service-base-url")).toBeVisible();

    await page.getByTestId("service-api-key").fill("e2e-saved-key");
    await page.getByTestId("service-base-url").fill(savedBaseUrl);
    await page.getByTestId("service-test-connection").click();
    await expect(page.getByTestId("service-connection-success")).toBeVisible();

    await page.getByTestId("service-save").click();
    await pollUntil(
      async () => await readJson<{ services: Array<{ service?: string; name?: string; baseUrl?: string }> }>(
        await request.get("/api/v1/services/config"),
      ),
      (config) => config.services.some((service) =>
        service.service === "custom" && service.name === "Custom" && service.baseUrl === savedBaseUrl,
      ),
      {
        timeoutMs: 30_000,
        description: "custom service configuration to be saved",
      },
    );
  } finally {
    const restoreConfig = await request.put("/api/v1/services/config", {
      data: {
        services: before.services,
        service: before.service,
        defaultModel: before.defaultModel,
        configSource: before.storedConfigSource,
      },
    });
    expect(restoreConfig.ok()).toBe(true);
    const restoreSecret = await request.put("/api/v1/services/custom%3ACustom/secret", {
      data: { apiKey: "stub-api-key" },
    });
    expect(restoreSecret.ok()).toBe(true);
  }
});
