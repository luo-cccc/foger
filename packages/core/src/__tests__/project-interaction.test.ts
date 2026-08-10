import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createProjectSession,
  loadProjectSession,
  persistProjectSession,
} from "../interaction/project-session-store.js";
import { processProjectInteractionRequest } from "../interaction/project-control.js";

let projectRoot: string;

describe("project interaction control", () => {
  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-project-control-"));
    await mkdir(join(projectRoot, "books", "harbor"), { recursive: true });
    await writeFile(join(projectRoot, "books", "harbor", "book.json"), "{}", "utf-8");
  });

  afterAll(async () => {
    // tmpdir cleanup omitted
  });

  it("persists structured create_book requests into the shared project session", async () => {
    await persistProjectSession(projectRoot, createProjectSession(projectRoot));

    const tools = {
      listBooks: vi.fn(async () => ["harbor"]),
      createBook: vi.fn(async () => ({
        bookId: "night-harbor",
        title: "Night Harbor",
        __interaction: {
          responseText: "Created Night Harbor.",
        },
      })),
      exportBook: vi.fn(async () => ({ ok: true })),
      writeNextEpisode: vi.fn(async () => ({ ok: true })),
      reviseDraft: vi.fn(async () => ({ ok: true })),
      patchEpisodeText: vi.fn(async () => ({ ok: true })),
      replaceEpisodeText: vi.fn(async () => ({ ok: true })),
      renameEntity: vi.fn(async () => ({ ok: true })),
      updateCurrentFocus: vi.fn(async () => ({ ok: true })),
      updateAuthorIntent: vi.fn(async () => ({ ok: true })),
      writeTruthFile: vi.fn(async () => ({ ok: true })),
    };

    const result = await processProjectInteractionRequest({
      projectRoot,
      request: {
        intent: "create_book",
        title: "Night Harbor",
        genre: "urban",
        platform: "tomato",
        episodeDurationSeconds: 90,
        targetEpisodes: 100,
      },
      tools,
    });

    expect(tools.createBook).toHaveBeenCalledWith({
      title: "Night Harbor",
      genre: "urban",
      platform: "tomato",
      episodeDurationSeconds: 90,
      targetEpisodes: 100,
    });
    expect(result.session.activeBookId).toBe("night-harbor");

    const persisted = await loadProjectSession(projectRoot);
    expect(persisted.activeBookId).toBe("night-harbor");
  });

});
