import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger, type LogSink } from "../index.js";
import {
  buildEpisodeFileLookup,
  createInteractionToolsFromDeps,
} from "../interaction/project-tools.js";
import { createEpisodeScriptMarkdown } from "./episode-test-fixtures.js";

let projectRoot: string;

function noopBookLock() {
  return vi.fn(async () => async () => undefined);
}

describe("interaction tools", () => {
  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-core-interaction-tools-"));
    await mkdir(join(projectRoot, "books", "harbor", "story"), { recursive: true });
  });

  it("delegates writeNextEpisode and reviseDraft to the pipeline", async () => {
    const events: string[] = [];
    const sink: LogSink = {
      write(entry) {
        events.push(entry.message);
      },
    };
    const pipeline = {
      config: {
        logger: createLogger({ tag: "test", sinks: [sink] }),
      },
      writeNextEpisode: vi.fn(async () => ({
        config: undefined,
        episodeNumber: 1,
        title: "Draft",
        episodeDurationSeconds: 1000,
        revised: false,
        status: "ready-for-review" as const,
        auditResult: { passed: true, issues: [], summary: "ok" },
      })),
      reviseDraft: vi.fn(async () => ({
        episodeNumber: 3,
        episodeDurationSeconds: 1200,
        fixedIssues: [],
        applied: true,
        status: "ready-for-review" as const,
      })),
    };
    const state = {
      ensureControlDocuments: vi.fn(async () => {}),
      bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
      loadBookConfig: vi.fn(async () => ({
        id: "harbor",
        title: "Harbor",
        platform: "other" as const,
        genre: "other",
        status: "outlining" as const,
        schemaVersion: "inkos-episode-v2" as const,
        format: "screenplay" as const,
        targetEpisodes: 100,
        episodeDurationSeconds: 90,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
      loadEpisodeIndex: vi.fn(async () => []),
      saveEpisodeIndex: vi.fn(async () => undefined),
      listBooks: vi.fn(async () => ["harbor"]),
      acquireBookLock: noopBookLock(),
    };

    const tools = createInteractionToolsFromDeps(pipeline, state);

    const writeResult = await tools.writeNextEpisode("harbor");
    await tools.reviseDraft("harbor", 3, "rewrite");

    expect(pipeline.writeNextEpisode).toHaveBeenCalledWith("harbor");
    expect(pipeline.reviseDraft).toHaveBeenCalledWith("harbor", 3, "rewrite");
    expect((writeResult as { __interaction?: { activeEpisodeNumber?: number } }).__interaction?.activeEpisodeNumber).toBe(1);
    expect(events).toEqual([]);
  });

  it("takes the book lock before deterministic text edit transactions", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-core-interaction-lock-"));
    try {
      await mkdir(join(root, "books", "harbor", "story"), { recursive: true });
      await mkdir(join(root, "books", "harbor", "episodes"), { recursive: true });
      await writeFile(join(root, "books", "harbor", "story", "story_bible.md"), "Alpha leads.\n", "utf-8");
      const script = createEpisodeScriptMarkdown(1)
        .replaceAll("Mara", "Alpha")
        .replaceAll("Taryn", "Gamma");
      await writeFile(join(root, "books", "harbor", "episodes", "0001_Start.md"), script, "utf-8");
      await writeFile(join(root, "books", "harbor", "episodes", "index.json"), JSON.stringify([{
        episodeNumber: 1,
        title: "Start",
        status: "audit-failed",
        episodeDurationSeconds: 90,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      }]), "utf-8");

      let releases = 0;
      const acquireBookLock = vi.fn(async () => async () => {
        releases += 1;
      });
      const pipeline = {
        writeNextEpisode: vi.fn(),
        reviseDraft: vi.fn(),
      };
      const state = {
        ensureControlDocuments: vi.fn(async () => {}),
        bookDir: vi.fn((bookId: string) => join(root, "books", bookId)),
        loadBookConfig: vi.fn(),
        loadEpisodeIndex: vi.fn(async () => JSON.parse(await readFile(join(root, "books", "harbor", "episodes", "index.json"), "utf-8"))),
        saveEpisodeIndex: vi.fn(async (_bookId: string, index) => {
          await writeFile(join(root, "books", "harbor", "episodes", "index.json"), JSON.stringify(index, null, 2), "utf-8");
        }),
        listBooks: vi.fn(async () => ["harbor"]),
        acquireBookLock,
      };
      const tools = createInteractionToolsFromDeps(pipeline as never, state as never);

      await tools.renameEntity("harbor", "Alpha", "Beta");
      await tools.patchEpisodeText("harbor", 1, "Gamma", "Delta");

      expect(acquireBookLock).toHaveBeenNthCalledWith(1, "harbor");
      expect(acquireBookLock).toHaveBeenNthCalledWith(2, "harbor");
      expect(releases).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures pipeline stage logs into interaction events", async () => {
    const pipeline = {
      config: {
        logger: createLogger({
          tag: "test",
          sinks: [{
            write() {},
          }],
        }),
      },
      writeNextEpisode: vi.fn(async function (this: { config: { logger?: { info: (msg: string) => void } } }) {
        this.config.logger?.info("Stage: preparing episode inputs");
        this.config.logger?.info("Stage: writing episode draft");
        return {
          episodeNumber: 4,
          title: "Draft",
          episodeDurationSeconds: 1000,
          revised: false,
          status: "ready-for-review" as const,
          auditResult: { passed: true, issues: [], summary: "ok" },
        };
      }),
      reviseDraft: vi.fn(async () => ({
        episodeNumber: 3,
        episodeDurationSeconds: 1200,
        fixedIssues: [],
        applied: true,
        status: "ready-for-review" as const,
      })),
    };
    const state = {
      ensureControlDocuments: vi.fn(async () => {}),
      bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
      loadBookConfig: vi.fn(async () => ({
        id: "harbor",
        title: "Harbor",
        platform: "other" as const,
        genre: "other",
        status: "outlining" as const,
        schemaVersion: "inkos-episode-v2" as const,
        format: "screenplay" as const,
        targetEpisodes: 100,
        episodeDurationSeconds: 90,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
      loadEpisodeIndex: vi.fn(async () => []),
      saveEpisodeIndex: vi.fn(async () => undefined),
      listBooks: vi.fn(async () => ["harbor"]),
      acquireBookLock: noopBookLock(),
    };

    const tools = createInteractionToolsFromDeps(pipeline, state);
    const result = await tools.writeNextEpisode("harbor");

    expect((result as {
      __interaction?: {
        events?: ReadonlyArray<{ kind: string; status: string; detail?: string }>;
      };
    }).__interaction?.events).toEqual([
      expect.objectContaining({ kind: "stage.changed", status: "planning", detail: "preparing episode inputs" }),
      expect.objectContaining({ kind: "stage.changed", status: "writing", detail: "writing episode draft" }),
    ]);
  });

  it("writes current_focus and author_intent into canonical story paths", async () => {
    const tools = createInteractionToolsFromDeps(
      {
        writeNextEpisode: vi.fn(async () => ({
          episodeNumber: 1,
          title: "Draft",
          episodeDurationSeconds: 1000,
          revised: false,
          status: "ready-for-review" as const,
          auditResult: { passed: true, issues: [], summary: "ok" },
        })),
        reviseDraft: vi.fn(async () => ({
          episodeNumber: 3,
          episodeDurationSeconds: 1200,
          fixedIssues: [],
          applied: true,
          status: "ready-for-review" as const,
        })),
      },
      {
        ensureControlDocuments: vi.fn(async () => {}),
        bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
        loadBookConfig: vi.fn(async () => ({
          id: "harbor",
          title: "Harbor",
          platform: "other" as const,
          genre: "other",
          status: "outlining" as const,
          schemaVersion: "inkos-episode-v2" as const,
          format: "screenplay" as const,
          targetEpisodes: 100,
          episodeDurationSeconds: 90,
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        })),
        loadEpisodeIndex: vi.fn(async () => []),
        saveEpisodeIndex: vi.fn(async () => undefined),
        listBooks: vi.fn(async () => ["harbor"]),
        acquireBookLock: noopBookLock(),
      },
    );

    await tools.updateCurrentFocus("harbor", "# Current Focus\n\nBring focus back.\n");
    await tools.updateAuthorIntent("harbor", "# Author Intent\n\nWrite a harbor mystery.\n");

    await expect(readFile(join(projectRoot, "books", "harbor", "story", "current_focus.md"), "utf-8"))
      .resolves.toContain("Bring focus back");
    await expect(readFile(join(projectRoot, "books", "harbor", "story", "author_intent.md"), "utf-8"))
      .resolves.toContain("harbor mystery");
  });

  it("rejects truth-file writes outside the canonical truth-file allowlist", async () => {
    const tools = createInteractionToolsFromDeps(
      {
        writeNextEpisode: vi.fn(async () => ({
          episodeNumber: 1,
          title: "Draft",
          episodeDurationSeconds: 1000,
          revised: false,
          status: "ready-for-review" as const,
          auditResult: { passed: true, issues: [], summary: "ok" },
        })),
        reviseDraft: vi.fn(async () => ({
          episodeNumber: 3,
          episodeDurationSeconds: 1200,
          fixedIssues: [],
          applied: true,
          status: "ready-for-review" as const,
        })),
      },
      {
        ensureControlDocuments: vi.fn(async () => {}),
        bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
        loadBookConfig: vi.fn(async () => ({
          id: "harbor",
          title: "Harbor",
          platform: "other" as const,
          genre: "other",
          status: "outlining" as const,
          schemaVersion: "inkos-episode-v2" as const,
          format: "screenplay" as const,
          targetEpisodes: 100,
          episodeDurationSeconds: 90,
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        })),
        loadEpisodeIndex: vi.fn(async () => []),
        saveEpisodeIndex: vi.fn(async () => undefined),
        listBooks: vi.fn(async () => ["harbor"]),
        acquireBookLock: noopBookLock(),
      },
    );

    await expect(tools.writeTruthFile("harbor", "runtime/agent_notes.md", "notes"))
      .rejects.toThrow("Invalid truth file name");
  });

  it("forwards foundation draft fields into shared book creation", async () => {
    const pipeline = {
      initBook: vi.fn(async () => undefined),
      writeNextEpisode: vi.fn(async () => ({
        episodeNumber: 1,
        title: "Draft",
        episodeDurationSeconds: 1000,
        revised: false,
        status: "ready-for-review" as const,
        auditResult: { passed: true, issues: [], summary: "ok" },
      })),
      reviseDraft: vi.fn(async () => ({
        episodeNumber: 3,
        episodeDurationSeconds: 1200,
        fixedIssues: [],
        applied: true,
        status: "ready-for-review" as const,
      })),
    };
    const state = {
      ensureControlDocuments: vi.fn(async () => {}),
      bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
      loadBookConfig: vi.fn(async () => ({
        id: "night-harbor",
        title: "Night Harbor",
        platform: "other" as const,
        genre: "urban",
        status: "outlining" as const,
        schemaVersion: "inkos-episode-v2" as const,
        format: "screenplay" as const,
        targetEpisodes: 100,
        episodeDurationSeconds: 90,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
      loadEpisodeIndex: vi.fn(async () => []),
      saveEpisodeIndex: vi.fn(async () => undefined),
      listBooks: vi.fn(async () => []),
      acquireBookLock: noopBookLock(),
    };

    const tools = createInteractionToolsFromDeps(pipeline, state);
    await tools.createBook?.({
      title: "Night Harbor",
      genre: "urban",
      platform: "tomato",
      episodeDurationSeconds: 2800,
      targetEpisodes: 120,
      blurb: "一个做灰产生意的人，准备在夜港洗白，却先被旧账拖回去。",
      worldPremise: "近未来架空香港，港口账本牵出多方势力。",
      protagonist: "林砚，水货账房出身，聪明克制，不轻易信人。",
      conflictCore: "洗白与旧债回潮的对撞。",
      volumeOutline: "卷一先查账，再暴露港口旧案。",
      authorIntent: "# 作者意图\n\n写成冷硬、克制、利益驱动的商战悬疑。\n",
      currentFocus: "# 当前聚焦\n\n先把旧账线和港口势力网立住。\n",
    });

    expect(pipeline.initBook).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Night Harbor",
        genre: "urban",
        platform: "tomato",
        targetEpisodes: 120,
        episodeDurationSeconds: 2800,
      }),
      expect.objectContaining({
        externalContext: expect.stringContaining("近未来架空香港"),
        authorIntent: expect.stringContaining("冷硬、克制"),
        currentFocus: expect.stringContaining("旧账线"),
      }),
    );
  });

  it("normalizes human-facing platform aliases before creating a book", async () => {
    const pipeline = {
      initBook: vi.fn(async () => undefined),
      writeNextEpisode: vi.fn(),
      reviseDraft: vi.fn(),
    };
    const state = {
      ensureControlDocuments: vi.fn(async () => {}),
      bookDir: vi.fn((bookId: string) => join(projectRoot, "books", bookId)),
      loadBookConfig: vi.fn(),
      loadEpisodeIndex: vi.fn(async () => []),
      saveEpisodeIndex: vi.fn(async () => undefined),
      listBooks: vi.fn(async () => []),
      acquireBookLock: noopBookLock(),
    };

    const tools = createInteractionToolsFromDeps(pipeline, state);
    await tools.createBook?.({
      title: "测试书",
      genre: "urban",
      platform: "番茄小说",
    });

    expect(pipeline.initBook).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "测试书",
        platform: "tomato",
      }),
      expect.any(Object),
    );
  });

  it("builds a reusable episode lookup from a single directory listing", () => {
    const lookup = buildEpisodeFileLookup([
      "0001_First.md",
      "0002_Second.md",
      "notes.txt",
      "0002_Second.backup",
    ]);

    expect(lookup.get(1)).toBe("0001_First.md");
    expect(lookup.get(2)).toBe("0002_Second.md");
    expect(lookup.size).toBe(2);
  });
});
