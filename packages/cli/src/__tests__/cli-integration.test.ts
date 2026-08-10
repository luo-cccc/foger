import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StateManager } from "@actalk/inkos-core";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(testDir, "..", "..");
const cliEntry = resolve(cliDir, "dist", "index.js");
const CLI_PROCESS_TIMEOUT_MS = 10_000;
const DOUBLE_CLI_INVOCATION_TEST_TIMEOUT_MS = CLI_PROCESS_TIMEOUT_MS * 2;

let projectDir: string;

function buildTestEnv(overrides?: Record<string, string>) {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !key.startsWith("INKOS_")
      && !key.startsWith("OPENAI_")
      && !key.startsWith("ANTHROPIC_")
      && key !== "TAVILY_API_KEY",
    ),
  );

  return {
    ...baseEnv,
    // Prevent global config from leaking into tests
    HOME: projectDir,
    ...overrides,
  };
}

function run(args: string[], options?: { env?: Record<string, string> }): string {
  try {
    return execFileSync("node", [cliEntry, ...args], {
      cwd: projectDir,
      encoding: "utf-8",
      env: buildTestEnv(options?.env),
      timeout: CLI_PROCESS_TIMEOUT_MS,
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error(`${failure.stderr ?? ""}\n${failure.stdout ?? ""}`.trim(), { cause: error });
  }
}

function runStderr(args: string[], options?: { env?: Record<string, string> }): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [cliEntry, ...args], {
      cwd: projectDir,
      encoding: "utf-8",
      env: buildTestEnv(options?.env),
      timeout: CLI_PROCESS_TIMEOUT_MS,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout: string; stderr: string; status: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.status ?? 1 };
  }
}

const failingLlmEnv = {
  INKOS_LLM_PROVIDER: "openai",
  INKOS_LLM_BASE_URL: "http://127.0.0.1:9/v1",
  INKOS_LLM_MODEL: "test-model",
  INKOS_LLM_API_KEY: "test-key",
};

describe("CLI integration", () => {
  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "inkos-cli-test-"));
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  describe("inkos --version", () => {
    it("prints version number", () => {
      const output = run(["--version"]);
      expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    }, CLI_PROCESS_TIMEOUT_MS);
  });

  describe("inkos --help", () => {
    it("prints help with command list", () => {
      const output = run(["--help"]);
      expect(output).toContain("inkos");
      expect(output).toContain("init");
      expect(output).toContain("book");
      expect(output).toContain("write");
    });
  });

  describe("inkos init", () => {
    it("initializes project in current directory", () => {
      const output = run(["init"]);
      expect(output).toContain("Project initialized");
    });

    it("creates inkos.json with correct structure", async () => {
      const raw = await readFile(join(projectDir, "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.llm).toBeDefined();
      expect(config.llm.provider).toBeDefined();
      expect(config.llm.model).toBeDefined();
      expect(config.daemon).toBeDefined();
      expect(config.notify).toEqual([]);
    });

    it("creates .env file", async () => {
      const envContent = await readFile(join(projectDir, ".env"), "utf-8");
      expect(envContent).toContain("INKOS_LLM_API_KEY");
    });

    it("creates .gitignore", async () => {
      const gitignore = await readFile(join(projectDir, ".gitignore"), "utf-8");
      expect(gitignore).toContain(".env");
    });

    it("creates Node version hints for sqlite-backed memory features", async () => {
      await expect(readFile(join(projectDir, ".nvmrc"), "utf-8")).resolves.toContain("22");
      await expect(readFile(join(projectDir, ".node-version"), "utf-8")).resolves.toContain("22");
    });

    it("creates books/ directory", async () => {
      const booksStat = await stat(join(projectDir, "books"));
      expect(booksStat.isDirectory()).toBe(true);
    });
  });

  describe("inkos init <name>", () => {
    it("creates project in subdirectory", () => {
      const output = run(["init", "subproject"]);
      expect(output).toContain("Project initialized");
    });

    it("creates inkos.json in subdirectory", async () => {
      const raw = await readFile(join(projectDir, "subproject", "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.name).toBe("subproject");
    });

    it("supports absolute project paths instead of nesting them under cwd", async () => {
      const absoluteDir = await mkdtemp(join(tmpdir(), "inkos-cli-abs-init-"));

      try {
        const output = run(["init", absoluteDir]);
        expect(output).toContain(`Project initialized at ${absoluteDir}`);

        const raw = await readFile(join(absoluteDir, "inkos.json"), "utf-8");
        const config = JSON.parse(raw);
        expect(config.name).toBe(basename(absoluteDir));
      } finally {
        await rm(absoluteDir, { recursive: true, force: true });
      }
    });

    it("prints English next steps when initialized with --lang en", async () => {
      const englishDir = await mkdtemp(join(tmpdir(), "inkos-cli-en-init-"));

      try {
        const output = run(["init", englishDir, "--lang", "en"]);
        expect(output).toContain("Project initialized");
        expect(output).toContain("inkos book create --title 'My Novel'");
        expect(output).not.toContain("我的小说");
      } finally {
        await rm(englishDir, { recursive: true, force: true });
      }
    });
  });

  describe("inkos analytics LLM report", () => {
    it("joins episode operations with telemetry and saves a range report", async () => {
      const bookId = "analytics-llm-report";
      const bookDir = join(projectDir, "books", bookId);
      const telemetryDir = join(projectDir, ".inkos", "runtime", "llm-calls");
      const reportPath = join(
        projectDir,
        ".inkos",
        "reports",
        `${bookId}-episodes-4-5-llm-report.json`,
      );
      const configPath = join(projectDir, "inkos.json");
      const originalConfig = await readFile(configPath, "utf-8").catch(() => undefined);
      const operation4 = "11111111-1111-4111-8111-111111111111";
      const operation5 = "22222222-2222-4222-8222-222222222222";
      const makeTelemetry = (operationId: string, timestamp: string) => ({
        bookId,
        operationId,
        agent: "writer",
        model: "test-model",
        service: "test-service",
        apiFormat: "chat",
        stream: false,
        phase: "chat",
        durationMs: 10,
        attemptCount: 1,
        retryCount: 0,
        promptAssembly: {
          totalChars: 40,
          estimatedTokens: 10,
          messages: [],
          sources: [],
          duplicateSourceGroups: [],
        },
        status: "success",
        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
        timestamp,
      });

      try {
        await writeFile(configPath, JSON.stringify({
          name: "analytics-report-test",
          version: "0.1.0",
          language: "en",
          llm: {
            provider: "openai",
            service: "custom",
            baseUrl: "http://127.0.0.1:9/v1",
            model: "test-model",
            apiFormat: "chat",
            stream: false,
            temperature: 0.7,
          },
          modelOverrides: {},
          notify: [],
          daemon: { schedule: { writeCron: "0 * * * *" }, maxConcurrentBooks: 1 },
        }, null, 2), "utf-8");
        await mkdir(join(bookDir, "episodes"), { recursive: true });
        await mkdir(telemetryDir, { recursive: true });
        await writeFile(join(bookDir, "book.json"), JSON.stringify({
          id: bookId,
          title: "Analytics Report",
          platform: "other",
          genre: "other",
          status: "active",
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          targetEpisodes: 10,
          episodeDurationSeconds: 90,
          language: "en",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
        }, null, 2), "utf-8");
        await writeFile(join(bookDir, "episodes", "index.json"), JSON.stringify([
          {
            episodeNumber: 4,
            title: "Fourth",
            status: "ready-for-review",
          episodeDurationSeconds: 90,
            createdAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-15T00:00:30.000Z",
            auditIssues: [],
            lengthWarnings: [],
            operationId: operation4,
            tokenUsage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
          },
          {
            episodeNumber: 5,
            title: "Fifth",
            status: "ready-for-review",
          episodeDurationSeconds: 90,
            createdAt: "2026-07-15T00:01:00.000Z",
            updatedAt: "2026-07-15T00:01:30.000Z",
            auditIssues: [],
            lengthWarnings: [],
            operationId: operation5,
            tokenUsage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
          },
        ], null, 2), "utf-8");
        await writeFile(
          join(telemetryDir, `${bookId}.jsonl`),
          [
            JSON.stringify(makeTelemetry(operation4, "2026-07-15T00:00:00.000Z")),
            JSON.stringify(makeTelemetry(operation5, "2026-07-15T00:01:00.000Z")),
          ].join("\n") + "\n",
          "utf-8",
        );

        const output = JSON.parse(run([
          "analytics",
          bookId,
          "--episodes",
          "4-5",
          "--llm-report",
          "--save-report",
          "--max-total-tokens",
          "100",
          "--max-audit-calls",
          "2",
          "--max-revision-calls",
          "2",
          "--max-normalize-calls",
          "2",
          "--max-settle-calls",
          "2",
          "--json",
        ]));

        expect(output.analytics).toMatchObject({ totalEpisodes: 2, totalDurationSeconds: 180 });
        expect(output.llmReport).toMatchObject({
          totals: { telemetryCalls: 2, telemetryTokens: 24 },
          telemetryWindow: { matchedEpisodeOperations: 2, unattributedCalls: 0 },
          gate: { passed: true, issues: [] },
        });
        await expect(readFile(reportPath, "utf-8")).resolves.toContain('"telemetryTokens": 24');
      } finally {
        await rm(bookDir, { recursive: true, force: true });
        await rm(join(telemetryDir, `${bookId}.jsonl`), { force: true });
        await rm(reportPath, { force: true });
        if (originalConfig === undefined) {
          await rm(configPath, { force: true });
        } else {
          await writeFile(configPath, originalConfig, "utf-8");
        }
      }
    }, CLI_PROCESS_TIMEOUT_MS);
  });

  describe("inkos config set", () => {
    it("sets a known config value", () => {
      const output = run(["config", "set", "llm.provider", "anthropic"]);
      expect(output).toContain("Set llm.provider = anthropic");
    });

    it("sets a nested config value", async () => {
      run(["config", "set", "llm.model", "gpt-5"]);
      const raw = await readFile(join(projectDir, "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.llm.model).toBe("gpt-5");
    });

    it("rejects unknown config keys", () => {
      expect(() => {
        run(["config", "set", "custom.nested.key", "value"]);
      }).toThrow();
    });

    it("sets input governance mode", async () => {
      const output = run(["config", "set", "inputGovernanceMode", "v2"]);
      expect(output).toContain("Set inputGovernanceMode = v2");

      const raw = await readFile(join(projectDir, "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.inputGovernanceMode).toBe("v2");
    });

    it("sets long-form writing review retries", async () => {
      const output = run(["config", "set", "writing.reviewRetries", "3"]);
      expect(output).toContain("Set writing.reviewRetries = 3");

      const raw = await readFile(join(projectDir, "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.writing.reviewRetries).toBe(3);
    });

    it("sets the assisted manual episode review mode", async () => {
      try {
        await readFile(join(projectDir, "inkos.json"), "utf-8");
      } catch {
        run(["init"]);
      }
      const output = run(["config", "set", "writing.reviewMode", "manual"]);
      expect(output).toContain("Set writing.reviewMode = manual");

      const raw = await readFile(join(projectDir, "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.writing.reviewMode).toBe("manual");
    });
  });

  describe("inkos config show", () => {
    it("shows current config as JSON", () => {
      const output = run(["config", "show"]);
      const config = JSON.parse(output);
      expect(config.llm.model).toBe("gpt-5");
    });
  });

  describe("inkos interact", () => {
    it("returns the agent-session JSON contract for natural-language interactions", async () => {
      const initialized = await stat(join(projectDir, "inkos.json")).then(() => true).catch(() => false);
      if (!initialized) run(["init"]);
      const envPath = join(projectDir, ".env");
      const originalEnv = await readFile(envPath, "utf-8");
      try {
        await writeFile(
          envPath,
          Object.entries(failingLlmEnv).map(([key, value]) => `${key}=${value}`).join("\n"),
          "utf-8",
        );
        const output = run(["interact", "--json", "--message", "切换到全自动"]);
        const data = JSON.parse(output);

        expect(data.request).toBeUndefined();
        expect(data.responseText).toEqual(expect.any(String));
        expect(data.session).toEqual(expect.objectContaining({
          sessionKind: "chat",
        }));
      } finally {
        await writeFile(envPath, originalEnv, "utf-8");
      }
    }, CLI_PROCESS_TIMEOUT_MS);

    it("binds the requested book when interact is called with --book", async () => {
      const initialized = await stat(join(projectDir, "inkos.json")).then(() => true).catch(() => false);
      if (!initialized) run(["init"]);
      const envPath = join(projectDir, ".env");
      const originalEnv = await readFile(envPath, "utf-8");
      try {
        await writeFile(
          envPath,
          Object.entries(failingLlmEnv).map(([key, value]) => `${key}=${value}`).join("\n"),
          "utf-8",
        );
        const state = new StateManager(projectDir);
        await state.saveBookConfig("harbor", {
          id: "harbor",
          title: "Harbor",
          platform: "tomato",
          genre: "other",
          status: "active",
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          targetEpisodes: 20,
          episodeDurationSeconds: 90,
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
        });

        const output = run(["interact", "--json", "--book", "harbor", "--message", "/books"]);
        const data = JSON.parse(output);

        expect(data.session.activeBookId).toBe("harbor");
      } finally {
        await writeFile(envPath, originalEnv, "utf-8");
        await rm(join(projectDir, "books", "harbor"), { recursive: true, force: true });
        await rm(join(projectDir, ".inkos-session.json"), { force: true }).catch(() => {});
      }
    }, CLI_PROCESS_TIMEOUT_MS);
  });

  describe("inkos config set-model", () => {
    it("rejects raw API keys passed to --api-key-env", async () => {
      const { exitCode, stderr } = runStderr([
        "config",
        "set-model",
        "writer",
        "gpt-4-turbo",
        "--provider",
        "custom",
        "--base-url",
        "https://poloai.top/v1",
        "--api-key-env",
        "sk-test-direct-key",
      ]);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("--api-key-env expects an environment variable name");

      const raw = await readFile(join(projectDir, "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.modelOverrides).toBeUndefined();
    });

    it("shows effective default model and known Phase 7 routing agents", async () => {
      await stat(join(projectDir, "inkos.json")).catch(() => {
        run(["init"]);
      });
      const configPath = join(projectDir, "inkos.json");
      const originalConfig = await readFile(configPath, "utf-8");
      try {
        const config = JSON.parse(originalConfig);
        config.llm = {
          ...(config.llm ?? {}),
          configSource: "studio",
          services: [{
            service: "custom",
            name: "Local Test",
            baseUrl: "http://127.0.0.1:11434/v1",
          }],
          service: "custom:Local Test",
          defaultModel: "studio-default-model",
          model: "stale-top-level-model",
        };
        config.modelOverrides = {
          "canon-extractor": "strict-json-model",
          "state-validator": { model: "validator-model", baseUrl: "http://127.0.0.1:11435/v1" },
        };
        await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

        const data = JSON.parse(run(["config", "show-models", "--json"]));
        expect(data.defaultModel).toBe("studio-default-model");
        expect(data.configMode).toBe("cli-project");
        expect(data.modelSource).toBe("project");
        expect(data.knownAgents).toContain("volume-auditor");
        expect(data.overrides["canon-extractor"]).toBe("strict-json-model");
      } finally {
        await writeFile(configPath, originalConfig, "utf-8");
      }
    });

    it("configures and removes an explicit governance content-policy fallback", async () => {
      await stat(join(projectDir, "inkos.json")).catch(() => {
        run(["init"]);
      });
      const configPath = join(projectDir, "inkos.json");
      const originalConfig = await readFile(configPath, "utf-8");
      try {
        const output = run([
          "config",
          "set-content-policy-fallback",
          "fallback-model",
          "--service",
          "fallback-service",
          "--base-url",
          "https://fallback.example/v1",
          "--api-key-env",
          "INKOS_FALLBACK_API_KEY",
          "--agents",
            "planner,auditor,state-validator",
          "--no-stream",
        ]);
        expect(output).toContain("fallback-service/fallback-model");

        const configured = JSON.parse(await readFile(configPath, "utf-8"));
        expect(configured.contentPolicyFallback).toMatchObject({
          model: "fallback-model",
          service: "fallback-service",
          baseUrl: "https://fallback.example/v1",
          apiKeyEnv: "INKOS_FALLBACK_API_KEY",
          agents: ["planner", "auditor", "state-validator"],
          stream: false,
        });
        expect(JSON.parse(run(["config", "show-models", "--json"])).contentPolicyFallback)
          .toMatchObject({ service: "fallback-service", model: "fallback-model" });

        expect(run(["config", "remove-content-policy-fallback"]))
          .toContain("Removed content-policy fallback");
        const removed = JSON.parse(await readFile(configPath, "utf-8"));
        expect(removed.contentPolicyFallback).toBeUndefined();
      } finally {
        await writeFile(configPath, originalConfig, "utf-8");
      }
    }, DOUBLE_CLI_INVOCATION_TEST_TIMEOUT_MS);
  });

  describe("inkos book list", () => {
    it("shows no books in empty project", () => {
      const output = run(["book", "list"]);
      expect(output).toContain("No books found");
    });

    it("returns empty array in JSON mode", () => {
      const output = run(["book", "list", "--json"]);
      const data = JSON.parse(output);
      expect(data.books).toEqual([]);
    });
  });

  describe("inkos book create", () => {
    it("rejects invalid numeric book settings before writing book config", () => {
      const { exitCode, stderr } = runStderr([
        "book",
        "create",
        "--title",
        "Bad Numbers",
        "--duration",
        "abc",
      ], {
        env: failingLlmEnv,
      });

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Expected number");
    }, CLI_PROCESS_TIMEOUT_MS);

    it("removes stale incomplete book directories before retrying create", async () => {
      try {
        await stat(join(projectDir, "inkos.json"));
      } catch {
        run(["init"]);
      }
      const bookId = "stale-book";
      const staleDir = join(projectDir, "books", bookId);
      await mkdir(join(staleDir, "story"), { recursive: true });
      await writeFile(join(staleDir, "book.json"), JSON.stringify({
        id: bookId,
        title: "Stale Book",
      }, null, 2));
      await writeFile(join(staleDir, "story", "current_state.md"), "# stale\n", "utf-8");

      const { exitCode, stderr } = runStderr([
        "book",
        "create",
        "--title",
        "stale book",
      ], {
        env: failingLlmEnv,
      });

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Failed to create book");
      await expect(stat(staleDir)).rejects.toThrow();
    }, CLI_PROCESS_TIMEOUT_MS);
  });

  describe("inkos book update", () => {
    it("updates validated settings through the shared core mutation", async () => {
      const initialized = await stat(join(projectDir, "inkos.json")).then(() => true).catch(() => false);
      if (!initialized) run(["init"]);
      const state = new StateManager(projectDir);
      const bookId = "book-update-cli";
      try {
        await state.saveBookConfig(bookId, {
          id: bookId,
          title: "Book Update CLI",
          platform: "other",
          genre: "urban",
          status: "active",
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          targetEpisodes: 20,
          episodeDurationSeconds: 90,
          language: "zh",
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
        });

        const output = run([
          "book", "update", bookId,
          "--duration", "95",
          "--episodes", "30",
          "--status", "paused",
          "--lang", "en",
          "--json",
        ]);
        expect(JSON.parse(output)).toMatchObject({
          id: bookId,
          episodeDurationSeconds: 95,
          targetEpisodes: 30,
          status: "paused",
          language: "en",
        });
        await expect(state.loadBookConfig(bookId)).resolves.toMatchObject({
          episodeDurationSeconds: 95,
          targetEpisodes: 30,
          status: "paused",
          language: "en",
        });
        await expect(stat(join(state.bookDir(bookId), ".write.lock"))).rejects.toThrow();
      } finally {
        await rm(state.bookDir(bookId), { recursive: true, force: true });
      }
    }, CLI_PROCESS_TIMEOUT_MS);
  });

  describe("inkos status", () => {
    it("shows project status with zero books", () => {
      const output = run(["status"]);
      expect(output).toContain("Books: 0");
    });

    it("returns JSON with --json flag", () => {
      const output = run(["status", "--json"]);
      const data = JSON.parse(output);
      expect(data.project).toBeDefined();
      expect(data.books).toEqual([]);
    });

    it("errors for nonexistent book", () => {
      const { exitCode, stderr } = runStderr(["status", "nonexistent"]);
      expect(exitCode).not.toBe(0);
    });

    it("shows English episode counts in words for episode rows", async () => {
      const bookDir = join(projectDir, "books", "english-status");
      await mkdir(join(bookDir, "episodes"), { recursive: true });
      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "english-status",
          title: "English Status Book",
          platform: "other",
          genre: "other",
          status: "active",
          targetEpisodes: 10,
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          episodeDurationSeconds: 90,
          language: "en",
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(
        join(bookDir, "episodes", "index.json"),
        JSON.stringify([
          {
            episodeNumber: 1,
            title: "A Quiet Sky",
            status: "ready-for-review",
            episodeDurationSeconds: 7,
            createdAt: "2026-03-22T00:00:00.000Z",
            updatedAt: "2026-03-22T00:00:00.000Z",
            auditIssues: ["[warning] minor pacing drift"],
            lengthWarnings: [],
          },
        ], null, 2),
        "utf-8",
      );

      const output = run(["status", "english-status", "--episodes"]);
      expect(output).toContain('Ep.1 "A Quiet Sky" | 7s | ready-for-review');
      expect(output).toContain("+ 1 warning(s)");
      expect(output).not.toContain("7字");
    });

    it("shows degraded episode counts and issues explicitly", async () => {
      const bookDir = join(projectDir, "books", "degraded-status");
      await mkdir(join(bookDir, "episodes"), { recursive: true });
      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "degraded-status",
          title: "Degraded Status Book",
          platform: "other",
          genre: "other",
          status: "active",
          targetEpisodes: 10,
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          episodeDurationSeconds: 90,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(
        join(bookDir, "episodes", "index.json"),
        JSON.stringify([
          {
            episodeNumber: 1,
            title: "Broken State",
            status: "state-degraded",
            episodeDurationSeconds: 90,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
            auditIssues: ["[warning] state validation still failed after retry"],
            lengthWarnings: [],
          },
        ], null, 2),
        "utf-8",
      );

      const output = run(["status", "degraded-status", "--episodes"]);
      expect(output).toContain("Degraded: 1");
      expect(output).toContain('Ep.1 "Broken State" | 90s | state-degraded');
      expect(output).toContain("[warning] state validation still failed after retry");

      const json = JSON.parse(run(["status", "degraded-status", "--json"]));
      expect(json.books[0]?.degraded).toBe(1);
    }, DOUBLE_CLI_INVOCATION_TEST_TIMEOUT_MS);

    it("shows a migration hint for legacy pre-v0.6 books", async () => {
      const bookDir = join(projectDir, "books", "legacy-status-hint");
      const storyDir = join(bookDir, "story");
      await mkdir(join(bookDir, "episodes"), { recursive: true });
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "legacy-status-hint",
          title: "Legacy Status Hint",
          platform: "other",
          genre: "other",
          status: "active",
          targetEpisodes: 10,
          episodeDurationSeconds: 2200,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(join(bookDir, "episodes", "index.json"), "[]", "utf-8");
      await writeFile(join(storyDir, "current_state.md"), "# Current State\n\nLegacy state.\n", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n", "utf-8");

      const { stdout, stderr } = runStderr(["status", "legacy-status-hint"]);
      expect(`${stdout}\n${stderr}`).toContain("UNSUPPORTED_LEGACY_FORMAT");
    });

    it("reports persisted episode file count instead of runtime progress when state runs ahead", async () => {
      const bookId = "ahead-status";
      const bookDir = join(projectDir, "books", bookId);
      const episodesDir = join(bookDir, "episodes");
      const stateDir = join(bookDir, "story", "state");

      await mkdir(episodesDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: bookId,
          title: "Ahead Status Book",
          platform: "other",
          genre: "other",
          status: "active",
          targetEpisodes: 10,
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          episodeDurationSeconds: 90,
          createdAt: "2026-03-29T00:00:00.000Z",
          updatedAt: "2026-03-29T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(join(episodesDir, "0001_First.md"), "# 第1集 First\n\nOnly persisted episode.", "utf-8");
      await writeFile(
        join(episodesDir, "index.json"),
        JSON.stringify([
          {
            episodeNumber: 1,
            title: "First",
            status: "ready-for-review",
            episodeDurationSeconds: 42,
            createdAt: "2026-03-29T00:00:00.000Z",
            updatedAt: "2026-03-29T00:00:00.000Z",
            auditIssues: [],
            lengthWarnings: [],
          },
        ], null, 2),
        "utf-8",
      );
      await Promise.all([
        writeFile(
          join(stateDir, "manifest.json"),
          JSON.stringify({
            schemaVersion: 2,
            language: "zh",
            lastAppliedEpisode: 4,
            projectionVersion: 1,
            migrationWarnings: [],
          }, null, 2),
          "utf-8",
        ),
        writeFile(
          join(stateDir, "current_state.json"),
          JSON.stringify({
            episode: 4,
            facts: [],
          }, null, 2),
          "utf-8",
        ),
        writeFile(join(stateDir, "hooks.json"), JSON.stringify({ hooks: [] }, null, 2), "utf-8"),
        writeFile(join(stateDir, "episode_summaries.json"), JSON.stringify({ rows: [] }, null, 2), "utf-8"),
      ]);

      const output = run(["status", bookId]);
      expect(output).toContain("Episodes: 1 / 10");
      expect(output).not.toContain("Episodes: 4 / 10");

      const json = JSON.parse(run(["status", bookId, "--json"]));
      expect(json.books[0]?.episodes).toBe(1);
    }, DOUBLE_CLI_INVOCATION_TEST_TIMEOUT_MS);
  });

  describe("inkos doctor", () => {
    it("checks environment health", () => {
      const { stdout } = runStderr(["doctor"]);
      expect(stdout).toContain("InkOS Doctor");
      expect(stdout).toContain("Node.js >= 20");
      expect(stdout).toContain("SQLite memory index");
      expect(stdout).toContain("inkos.json");
      expect(stdout).toContain("Agent Model Routing");
    });

    it("repairs missing node runtime pin files for old projects", async () => {
      await stat(join(projectDir, "inkos.json")).catch(() => {
        run(["init"]);
      });

      await rm(join(projectDir, ".nvmrc"), { force: true });
      await rm(join(projectDir, ".node-version"), { force: true });

      const before = runStderr(["doctor"]);
      expect(before.stdout).toContain("Node runtime pin files");
      expect(before.stdout).toContain(".nvmrc");
      expect(before.stdout).toContain(".node-version");

      const repaired = runStderr(["doctor", "--repair-node-runtime"]);
      expect(repaired.stdout).toContain("Node runtime pin files repaired");
      expect(repaired.stdout).toContain(".nvmrc");
      expect(repaired.stdout).toContain(".node-version");

      await expect(readFile(join(projectDir, ".nvmrc"), "utf-8")).resolves.toBe("22\n");
      await expect(readFile(join(projectDir, ".node-version"), "utf-8")).resolves.toBe("22\n");
    }, CLI_PROCESS_TIMEOUT_MS);

    it("treats localhost OpenAI-compatible endpoints as API-key optional", async () => {
      await stat(join(projectDir, "inkos.json")).catch(() => {
        run(["init"]);
      });
      const configPath = join(projectDir, "inkos.json");
      const envPath = join(projectDir, ".env");
      const originalConfig = await readFile(configPath, "utf-8");
      const originalEnv = await readFile(envPath, "utf-8");

      try {
        const config = JSON.parse(originalConfig);
        config.llm.provider = "openai";
        config.llm.baseUrl = "http://127.0.0.1:11434/v1";
        config.llm.model = "gpt-oss:20b";
        await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
        await writeFile(envPath, [
          "INKOS_LLM_PROVIDER=openai",
          "INKOS_LLM_BASE_URL=http://127.0.0.1:11434/v1",
          "INKOS_LLM_MODEL=gpt-oss:20b",
          "",
        ].join("\n"), "utf-8");

        const { stdout } = runStderr(["doctor"], {
          env: { INKOS_LLM_API_KEY: "" },
        });
        expect(stdout).toContain("LLM API Key");
        expect(stdout).toContain("Optional for local/self-hosted endpoint");
        expect(stdout).toContain("LLM Config");
        expect(stdout).not.toContain("No LLM config available");
      } finally {
        await writeFile(configPath, originalConfig, "utf-8");
        await writeFile(envPath, originalEnv, "utf-8");
      }
    });

    it("reports legacy books in the version migration check", async () => {
      const bookDir = join(projectDir, "books", "legacy-doctor-hint");
      const storyDir = join(bookDir, "story");
      await mkdir(join(bookDir, "episodes"), { recursive: true });
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "legacy-doctor-hint",
          title: "Legacy Doctor Hint",
          platform: "other",
          genre: "other",
          status: "active",
          targetEpisodes: 10,
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          episodeDurationSeconds: 90,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(join(bookDir, "episodes", "index.json"), "[]", "utf-8");
      await writeFile(join(storyDir, "current_state.md"), "# Current State\n\nLegacy state.\n", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n", "utf-8");

      const { stdout } = runStderr(["doctor"]);
      expect(stdout).toContain("Version Migration");
      expect(stdout).toContain("legacy format");
    });
  });

  describe("inkos write", () => {
    it("warns before writing when the target book still uses legacy format", async () => {
      const bookDir = join(projectDir, "books", "legacy-write-hint");
      const storyDir = join(bookDir, "story");
      await mkdir(join(bookDir, "episodes"), { recursive: true });
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "legacy-write-hint",
          title: "Legacy Write Hint",
          platform: "other",
          genre: "other",
          status: "active",
          targetEpisodes: 10,
          episodeDurationSeconds: 2200,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(join(bookDir, "episodes", "index.json"), "[]", "utf-8");
      await writeFile(join(storyDir, "current_state.md"), "# Current State\n\nLegacy state.\n", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n", "utf-8");

      const { stdout, stderr } = runStderr(["write", "next", "legacy-write-hint"], {
        env: failingLlmEnv,
      });
      expect(`${stdout}\n${stderr}`).toContain("UNSUPPORTED_LEGACY_FORMAT");
    });

    it("fails rewrite before deleting episodes when the rollback snapshot is missing", async () => {
      const bookId = "rewrite-missing-snapshot";
      const bookDir = join(projectDir, "books", bookId);
      const storyDir = join(bookDir, "story");
      const episodesDir = join(bookDir, "episodes");

      await mkdir(episodesDir, { recursive: true });
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: bookId,
          title: "Rewrite Missing Snapshot",
          platform: "other",
          genre: "other",
          status: "active",
          targetEpisodes: 10,
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          episodeDurationSeconds: 90,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(join(storyDir, "current_state.md"), "State at ch1", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "Hooks at ch1", "utf-8");
      await writeFile(join(episodesDir, "0001_ch1.md"), "# Episode 1\n\nContent 1", "utf-8");
      await writeFile(join(episodesDir, "0002_ch2.md"), "# Episode 2\n\nContent 2", "utf-8");
      await writeFile(join(episodesDir, "index.json"), JSON.stringify([
        { episodeNumber: 1, title: "Ch1", status: "approved", episodeDurationSeconds: 100, createdAt: "", updatedAt: "", auditIssues: [], lengthWarnings: [] },
        { episodeNumber: 2, title: "Ch2", status: "approved", episodeDurationSeconds: 100, createdAt: "", updatedAt: "", auditIssues: [], lengthWarnings: [] },
      ], null, 2), "utf-8");

      const { exitCode, stdout, stderr } = runStderr(["write", "rewrite", bookId, "2", "--force"], {
        env: failingLlmEnv,
      });
      expect(exitCode).not.toBe(0);
      expect(`${stdout}\n${stderr}`).toContain("Cannot restore snapshot for episode 1");
      await expect(readFile(join(episodesDir, "0002_ch2.md"), "utf-8")).resolves.toContain("Content 2");
    });

    it("restores later episodes when rewrite regeneration fails", async () => {
      const state = new StateManager(projectDir);
      const bookId = "rewrite-cli";
      const bookDir = join(projectDir, "books", bookId);
      const storyDir = join(bookDir, "story");
      const episodesDir = join(bookDir, "episodes");
      const stateDir = join(storyDir, "state");

      await mkdir(episodesDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: bookId,
          title: "Rewrite CLI",
          platform: "other",
          genre: "other",
          status: "active",
          targetEpisodes: 10,
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          episodeDurationSeconds: 90,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(join(storyDir, "current_state.md"), "State at ch1", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "Hooks at ch1", "utf-8");
      await writeFile(join(episodesDir, "0001_ch1.md"), "# Episode 1\n\nContent 1", "utf-8");
      await writeFile(join(episodesDir, "0002_ch2.md"), "# Episode 2\n\nContent 2", "utf-8");
      await writeFile(join(episodesDir, "0003_ch3.md"), "# Episode 3\n\nContent 3", "utf-8");
      await writeFile(
        join(episodesDir, "index.json"),
        JSON.stringify([
          { episodeNumber: 1, title: "Ch1", status: "approved", episodeDurationSeconds: 100, createdAt: "", updatedAt: "", auditIssues: [], lengthWarnings: [] },
          { episodeNumber: 2, title: "Ch2", status: "approved", episodeDurationSeconds: 100, createdAt: "", updatedAt: "", auditIssues: [], lengthWarnings: [] },
          { episodeNumber: 3, title: "Ch3", status: "approved", episodeDurationSeconds: 100, createdAt: "", updatedAt: "", auditIssues: [], lengthWarnings: [] },
        ], null, 2),
        "utf-8",
      );

      await state.snapshotState(bookId, 1);

      await writeFile(join(storyDir, "current_state.md"), "State at ch3", "utf-8");
      await writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedEpisode: 4,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8");
      await writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        episode: 3,
        facts: [],
      }, null, 2), "utf-8");

      const { exitCode, stdout, stderr } = runStderr(["write", "rewrite", bookId, "2", "--force"], {
        env: failingLlmEnv,
      });
      expect(exitCode).not.toBe(0);
      expect(`${stdout}\n${stderr}`).toContain("Regenerating episode 2");
      expect(`${stdout}\n${stderr}`).not.toContain("resolved to 3");

      const next = await state.getNextEpisodeNumber(bookId);
      expect(next).toBe(4);
      await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("State at ch3");
      await expect(readFile(join(episodesDir, "0002_ch2.md"), "utf-8")).resolves.toContain("Content 2");
      await expect(readFile(join(episodesDir, "0003_ch3.md"), "utf-8")).resolves.toContain("Content 3");
    });
  });

  describe("inkos analytics", () => {
    it("errors when no book exists", () => {
      const { exitCode } = runStderr(["analytics"]);
      expect(exitCode).not.toBe(0);
    });
  });

  describe("inkos review", () => {
    it("preserves the original episode snapshot when approving review", async () => {
      const configPath = join(projectDir, "inkos.json");
      const initialized = await stat(configPath).then(() => true).catch(() => false);
      if (!initialized) run(["init"]);

      const state = new StateManager(projectDir);
      const bookId = "review-approve-cli";
      const bookDir = join(projectDir, "books", bookId);
      const storyDir = join(bookDir, "story");
      const episodesDir = join(bookDir, "episodes");
      await mkdir(episodesDir, { recursive: true });
      await mkdir(storyDir, { recursive: true });

      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: bookId,
          title: "Review Approve CLI",
          platform: "other",
          genre: "other",
          status: "active",
          targetEpisodes: 10,
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          episodeDurationSeconds: 90,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(join(storyDir, "current_state.md"), "State at ch1", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "Hooks at ch1", "utf-8");
      await writeFile(join(episodesDir, "0001_ch1.md"), "# Episode 1\n\nContent 1", "utf-8");
      await writeFile(
        join(episodesDir, "index.json"),
        JSON.stringify([
          {
            episodeNumber: 1,
            title: "Ch1",
            status: "ready-for-review",
            episodeDurationSeconds: 100,
            createdAt: "",
            updatedAt: "",
            auditIssues: [],
            lengthWarnings: [],
          },
        ], null, 2),
        "utf-8",
      );

      await state.snapshotState(bookId, 1);

      await writeFile(join(storyDir, "current_state.md"), "State at ch3", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "Hooks at ch3", "utf-8");

      const output = run(["review", "approve", bookId, "1"]);
      expect(output).toContain("Episode 1 approved");

      await expect(
        readFile(join(storyDir, "snapshots", "1", "current_state.md"), "utf-8"),
      ).resolves.toBe("State at ch1");
      await expect(
        readFile(join(storyDir, "snapshots", "1", "pending_hooks.md"), "utf-8"),
      ).resolves.toBe("Hooks at ch1");

      const index = await state.loadEpisodeIndex(bookId);
      expect(index[0]?.status).toBe("approved");
    });

    it("approves all pending episodes through one shared core mutation", async () => {
      const initialized = await stat(join(projectDir, "inkos.json")).then(() => true).catch(() => false);
      if (!initialized) run(["init"]);
      const state = new StateManager(projectDir);
      const bookId = "review-approve-all-cli";
      try {
        await state.saveBookConfig(bookId, {
          id: bookId,
          title: "Review Approve All CLI",
          platform: "other",
          genre: "urban",
          status: "active",
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          targetEpisodes: 10,
          episodeDurationSeconds: 90,
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
        });
        await state.saveEpisodeIndex(bookId, [
        {
          episodeNumber: 1,
          title: "One",
          status: "ready-for-review",
          episodeDurationSeconds: 100,
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
          auditIssues: [],
          lengthWarnings: [],
        },
        {
          episodeNumber: 2,
          title: "Two",
          status: "audit-failed",
          episodeDurationSeconds: 100,
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
          auditIssues: ["Needs review"],
          lengthWarnings: [],
        },
        {
          episodeNumber: 3,
          title: "Three",
          status: "rejected",
          episodeDurationSeconds: 100,
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
          auditIssues: [],
          lengthWarnings: [],
        },
        ]);

        const output = JSON.parse(run(["review", "approve-all", bookId, "--json"]));
        expect(output).toEqual({ bookId, approvedCount: 2 });
        const index = await state.loadEpisodeIndex(bookId);
        expect(index.map((entry) => entry.status)).toEqual(["approved", "approved", "rejected"]);
        await expect(stat(join(state.bookDir(bookId), ".write.lock"))).rejects.toThrow();
      } finally {
        await rm(state.bookDir(bookId), { recursive: true, force: true });
      }
    }, CLI_PROCESS_TIMEOUT_MS);
  });

  describe("inkos plan/compose", () => {
    beforeAll(async () => {
      const configPath = join(projectDir, "inkos.json");
      const initialized = await stat(configPath).then(() => true).catch(() => false);
      if (!initialized) run(["init"]);

      const bookDir = join(projectDir, "books", "cli-book");
      const storyDir = join(bookDir, "story");
      await mkdir(join(storyDir, "runtime"), { recursive: true });

      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "cli-book",
          title: "CLI Book",
          platform: "tomato",
          genre: "other",
          status: "active",
          targetEpisodes: 20,
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          episodeDurationSeconds: 90,
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(join(bookDir, "episodes", "index.json"), "[]", "utf-8").catch(async () => {
        await mkdir(join(bookDir, "episodes"), { recursive: true });
        await writeFile(join(bookDir, "episodes", "index.json"), "[]", "utf-8");
      });

      const plannedGoal = "Ignore the guild chase and focus on the mentor conflict.";
      const intentMarkdown = [
        "# Episode Intent",
        "",
        "## Goal",
        plannedGoal,
        "",
        "## Outline Node",
        "(not found)",
        "",
        "## Must Keep",
        "- none",
        "",
        "## Must Avoid",
        "- none",
        "",
        "## Style Emphasis",
        "- none",
        "",
        "## Conflicts",
        "- none",
        "",
        "## Episode Brief",
        "- episodeType: 推进",
        "- isGoldenOpening: false",
        "",
        "### Beat Outline",
        "- opening: Track the merchant guild trail",
        "",
        "### Hook Plan",
        "- none",
        "",
        "### Props And Setting",
        "- none",
        "",
      ].join("\n");

      await Promise.all([
        writeFile(join(storyDir, "author_intent.md"), "# Author Intent\n\nKeep the story centered on the mentor conflict.\n", "utf-8"),
        writeFile(join(storyDir, "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
        writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
        writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Episode 1\nTrack the merchant guild trail.\n", "utf-8"),
        writeFile(join(storyDir, "book_rules.md"), "---\nprohibitions:\n  - Do not reveal the mastermind\n---\n\n# Book Rules\n", "utf-8"),
        writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
        writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
        writeFile(join(storyDir, "runtime", "episode-0001.intent.md"), intentMarkdown, "utf-8"),
      ]);
    });

    it("loads a pre-planned intent and returns the generated intent path in JSON mode", async () => {
      const output = run(["compose", "episode", "cli-book", "--json"]);
      const data = JSON.parse(output);

      expect(data.bookId).toBe("cli-book");
      expect(data.episodeNumber).toBe(1);
      expect(data.intentPath).toContain("story/runtime/episode-0001.intent.md");
      await expect(stat(join(projectDir, "books", "cli-book", data.intentPath))).resolves.toBeTruthy();
    });

    it("runs compose episode and returns runtime artifact paths in JSON mode", async () => {
      const output = run(["compose", "episode", "cli-book", "--json"]);
      const data = JSON.parse(output);

      expect(data.bookId).toBe("cli-book");
      expect(data.episodeNumber).toBe(1);
      expect(data.contextPath).toContain("story/runtime/episode-0001.context.json");
      expect(data.ruleStackPath).toContain("story/runtime/episode-0001.rule-stack.yaml");
      expect(data.tracePath).toContain("story/runtime/episode-0001.trace.json");

      await expect(stat(join(projectDir, "books", "cli-book", data.contextPath))).resolves.toBeTruthy();
      await expect(stat(join(projectDir, "books", "cli-book", data.ruleStackPath))).resolves.toBeTruthy();
      await expect(stat(join(projectDir, "books", "cli-book", data.tracePath))).resolves.toBeTruthy();
    });

    it("re-plans from outline when compose runs without a new context (Phase 1: persisted plans disabled)", async () => {
      const output = run(["compose", "episode", "cli-book", "--json"]);
      const data = JSON.parse(output);
      const intentMarkdown = await readFile(join(projectDir, "books", "cli-book", data.intentPath), "utf-8");

      expect(typeof data.goal).toBe("string");
      expect(data.goal.length).toBeGreaterThan(0);
      expect(intentMarkdown).toContain(data.goal);
    });
  });

  describe("inkos export", () => {
    beforeAll(async () => {
      const configPath = join(projectDir, "inkos.json");
      const initialized = await stat(configPath).then(() => true).catch(() => false);
      if (!initialized) run(["init"]);

      const bookDir = join(projectDir, "books", "export-book");
      await mkdir(join(bookDir, "episodes"), { recursive: true });

      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "export-book",
          title: "Export Book",
          platform: "tomato",
          genre: "xuanhuan",
          status: "active",
          targetEpisodes: 10,
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          episodeDurationSeconds: 90,
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(
        join(bookDir, "episodes", "index.json"),
        JSON.stringify([
          {
            episodeNumber: 1,
            title: "Dawn Ledger",
            status: "ready-for-review",
            episodeDurationSeconds: 90,
            createdAt: "2026-03-23T00:00:00.000Z",
            updatedAt: "2026-03-23T00:00:00.000Z",
            auditIssues: [],
          },
        ], null, 2),
        "utf-8",
      );
      await writeFile(
        join(bookDir, "episodes", "0001_Dawn_Ledger.md"),
        "# 第1集 Dawn Ledger\n\n正文。\n",
        "utf-8",
      );
    });

    it("creates missing parent directories for custom output paths", async () => {
      const outputPath = join(projectDir, "exports", "nested", "book.md");
      const output = run(["export", "export-book", "--format", "screenplay-md", "--output", outputPath, "--json"]);
      const data = JSON.parse(output);

      expect(data.outputPath).toBe(outputPath);
      await expect(stat(outputPath)).resolves.toBeTruthy();
      await expect(readFile(outputPath, "utf-8")).resolves.toContain("# Export Book");
    });
  });
});
