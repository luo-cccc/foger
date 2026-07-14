import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Rebuild @actalk/inkos-core before E2E tests start.
 *
 * The E2E API server (tsx watch src/api/index.ts) imports core via the pnpm
 * workspace symlink, which resolves to packages/core/dist/index.js — the
 * compiled output, not the TypeScript source.  If dist/ is stale the server
 * runs old code regardless of what the TypeScript sources say, causing
 * otherwise-correct agent logic (e.g. the terminalToolResultTail guard) to be
 * silently absent at runtime.
 *
 * Rebuilding here ensures the dist is always fresh before tests run.
 */
export default async function globalSetup(): Promise<void> {
  const thisFile = fileURLToPath(import.meta.url);
  // From packages/studio/e2e: ../ = studio, ../../ = packages, ../../../ = the
  // worktree/workspace root (where pnpm-workspace.yaml lives). A fourth ../ would
  // point at the .worktrees parent, where the --filter matches nothing and the
  // build silently no-ops, leaving core dist stale (agent stub absent at runtime).
  const workspaceRoot = path.resolve(path.dirname(thisFile), "../../../");
  const apiPort = readRequiredPort("INKOS_STUDIO_PORT");
  const clientPort = readRequiredPort("INKOS_STUDIO_CLIENT_PORT");
  const llmMode = readLlmMode();
  const linkedSourceRoot = path.resolve(process.env.INKOS_LINKED_SOURCE_ROOT?.trim() || workspaceRoot);
  const e2eProjectRoot = mkdtempSync(path.join(tmpdir(), "inkos-studio-e2e-"));
  ensureE2eProject(e2eProjectRoot, llmMode, linkedSourceRoot);
  execSync("pnpm --filter @actalk/inkos-core build", {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  const studioRoot = path.resolve(workspaceRoot, "packages/studio");
  const verboseE2e = process.env.INKOS_E2E_VERBOSE === "1";
  const runtimeFile = readRequiredEnv("INKOS_E2E_RUNTIME_FILE");
  const e2eLog = createWriteStream(readRequiredEnv("INKOS_E2E_LOG_PATH"), { flags: "a" });
  const child = spawn(process.execPath, ["scripts/dev.mjs", "--e2e"], {
    cwd: studioRoot,
    env: {
      ...process.env,
      INKOS_AGENT_LLM_STUB: llmMode === "live" ? "" : "1",
      INKOS_E2E_LLM_MODE: llmMode,
      INKOS_STUDIO_PORT: String(apiPort),
      INKOS_STUDIO_CLIENT_PORT: String(clientPort),
      INKOS_PROJECT_ROOT: e2eProjectRoot,
      INKOS_E2E_PROJECT_ROOT: e2eProjectRoot,
    },
    stdio: verboseE2e ? "inherit" : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!verboseE2e) {
    child.stdout?.pipe(e2eLog, { end: false });
    child.stderr?.pipe(e2eLog, { end: false });
    child.on("close", () => e2eLog.end());
  }
  writeFileSync(
    runtimeFile,
    `${JSON.stringify({
      pid: child.pid ?? null,
      launcherPid: Number(process.env.INKOS_E2E_LAUNCHER_PID) || null,
      projectRoot: e2eProjectRoot,
    })}\n`,
    "utf-8",
  );
  process.env.INKOS_E2E_PROJECT_ROOT = e2eProjectRoot;
  await waitForUrl(`http://127.0.0.1:${clientPort}/api/v1/books`, 120_000);
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set by the E2E launcher.`);
  return value;
}

function readRequiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be set to a valid port by the E2E launcher.`);
  }
  return value;
}

function readLlmMode(): "stub" | "live" {
  const value = process.env.INKOS_E2E_LLM_MODE?.trim() || "stub";
  if (value !== "stub" && value !== "live") {
    throw new Error(`INKOS_E2E_LLM_MODE must be "stub" or "live", received "${value}".`);
  }
  return value;
}

function ensureE2eProject(projectRoot: string, llmMode: "stub" | "live", sourceRoot: string): void {
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(path.join(projectRoot, "books"), { recursive: true });
  mkdirSync(path.join(projectRoot, ".inkos"), { recursive: true });

  if (llmMode === "live") {
    copyLiveProjectConfig(projectRoot, sourceRoot);
    return;
  }

  writeFileSync(
    path.join(projectRoot, "inkos.json"),
    `${JSON.stringify({
      name: "studio-e2e-project",
      version: "0.1.0",
      language: "zh",
      llm: {
        provider: "custom",
        service: "custom:Custom",
        configSource: "studio",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "stub-model",
        defaultModel: "stub-model",
        apiFormat: "chat",
        stream: true,
        services: [
          {
            service: "custom",
            name: "Custom",
            baseUrl: "http://127.0.0.1:11434/v1",
            apiFormat: "chat",
            stream: true,
          },
        ],
      },
      notify: [],
      inputGovernanceMode: "v2",
      daemon: {
        schedule: {
          writeCron: "*/15 * * * *",
        },
        maxConcurrentBooks: 3,
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(path.join(projectRoot, ".env"), "# E2E project uses INKOS_AGENT_LLM_STUB=1.\n", "utf-8");
  writeFileSync(path.join(projectRoot, ".node-version"), "22\n", "utf-8");
  writeFileSync(path.join(projectRoot, ".nvmrc"), "22\n", "utf-8");
  writeFileSync(
    path.join(projectRoot, ".inkos", "secrets.json"),
    `${JSON.stringify({
      services: {
        "custom:Custom": {
          apiKey: "stub-api-key",
        },
      },
    }, null, 2)}\n`,
    "utf-8",
  );
  seedE2eBook(projectRoot);
}

function copyLiveProjectConfig(projectRoot: string, sourceRoot: string): void {
  const sourceConfig = path.join(sourceRoot, "inkos.json");
  if (!existsSync(sourceConfig)) {
    throw new Error(`Linked live E2E requires ${sourceConfig}.`);
  }

  copyFileSync(sourceConfig, path.join(projectRoot, "inkos.json"));
  const sourceSecrets = path.join(sourceRoot, ".inkos", "secrets.json");
  if (existsSync(sourceSecrets)) {
    copyFileSync(sourceSecrets, path.join(projectRoot, ".inkos", "secrets.json"));
  }

  writeFileSync(
    path.join(projectRoot, ".env"),
    "# Linked live E2E inherits provider environment variables from the launcher.\n",
    "utf-8",
  );
  writeFileSync(path.join(projectRoot, ".node-version"), "22\n", "utf-8");
  writeFileSync(path.join(projectRoot, ".nvmrc"), "22\n", "utf-8");
}

function seedE2eBook(projectRoot: string): void {
  const now = new Date().toISOString();
  const bookId = "e2e-seeded-book";
  const bookDir = path.join(projectRoot, "books", bookId);
  const storyDir = path.join(bookDir, "story");
  const outlineDir = path.join(storyDir, "outline");
  const rolesDir = path.join(storyDir, "roles", "major");

  rmSync(bookDir, { recursive: true, force: true });
  mkdirSync(outlineDir, { recursive: true });
  mkdirSync(rolesDir, { recursive: true });
  mkdirSync(path.join(bookDir, "chapters"), { recursive: true });

  writeFileSync(
    path.join(bookDir, "book.json"),
    `${JSON.stringify({
      id: bookId,
      title: "E2E Seeded Book",
      platform: "other",
      genre: "urban",
      status: "active",
      targetChapters: 12,
      chapterWordCount: 1200,
      language: "zh",
      createdAt: now,
      updatedAt: now,
    }, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(
    path.join(outlineDir, "story_frame.md"),
    [
      "# 故事设定",
      "",
      "- 世界：近未来港城，账本能改写债务归属。",
      "- 主角：林越，想摆脱码头旧债。",
      "- 核心冲突：一册被焚毁的旧账本把他重新拖回黑市。",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    path.join(outlineDir, "volume_map.md"),
    [
      "# 卷纲",
      "",
      "## 第1章 失踪账本",
      "林越发现被焚毁的账本碎页重新出现在码头线人手里。",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    path.join(storyDir, "book_rules.md"),
    [
      "# 写作规则",
      "",
      "- 保持港口黑色惊悚气质。",
      "- 关键信息优先通过行动与对话呈现。",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    path.join(storyDir, "pending_hooks.md"),
    [
      "# Pending Hooks",
      "",
      "- Burned ledger fragment resurfaces at the docks.",
      "",
    ].join("\n"),
    "utf-8",
  );
  const snapshotDir = path.join(storyDir, "snapshots", "0");
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(
    path.join(snapshotDir, "current_state.md"),
    "# Current State\n\n- 林越手里只有半枚誓印。\n- 他仍欠码头行会一笔旧债。\n",
    "utf-8",
  );
  writeFileSync(
    path.join(snapshotDir, "pending_hooks.md"),
    "# Pending Hooks\n\n- Burned ledger fragment resurfaces at the docks.\n",
    "utf-8",
  );
  writeFileSync(
    path.join(bookDir, ".chapter-persistence.json"),
    `${JSON.stringify({ chapterNumber: 1, previousChapter: 0, status: "preparing", operationId: "e2e-interrupted-operation" })}\n`,
    "utf-8",
  );
  writeFileSync(
    path.join(bookDir, "chapters", "0001_interrupted.md"),
    "# 第1章 中断章节\n\n这段内容不应保留。\n",
    "utf-8",
  );
  writeFileSync(
    path.join(storyDir, "current_state.md"),
    [
      "# Current State",
      "",
      "- 林越手里只有半枚誓印。",
      "- 他仍欠码头行会一笔旧债。",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    path.join(storyDir, "current_focus.md"),
    [
      "# Current Focus",
      "",
      "- 写出林越被迫重新追查账本的开场。",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    path.join(storyDir, "author_intent.md"),
    [
      "# Author Intent",
      "",
      "- 以账本阴影和债务压迫推动长篇悬疑节奏。",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    path.join(rolesDir, "Lin Yue.md"),
    [
      "# 林越",
      "",
      "- 主角，码头账房出身，想洗白上岸。",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}
