import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterMeta } from "../models/chapter.js";
import type { RewriteChapterResult } from "../pipeline/runner.js";
import {
  ChapterMutationChapterNotFoundError,
  executeCoreMutation,
  executeChapterMutation,
} from "../pipeline/chapter-mutations.js";
import { StateManager } from "../state/manager.js";

describe("executeChapterMutation", () => {
  let root: string;
  let state: StateManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-chapter-mutation-"));
    state = new StateManager(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("approves under the shared book lock and updates the chapter timestamp", async () => {
    const originalUpdatedAt = "2026-01-01T00:00:00.000Z";
    await state.saveChapterIndex("approve-book", [chapter(1, "ready-for-review", originalUpdatedAt)]);
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    await expect(executeChapterMutation({ state }, {
      kind: "approve",
      bookId: "approve-book",
      chapterNumber: 1,
    })).resolves.toEqual({
      bookId: "approve-book",
      chapterNumber: 1,
      status: "approved",
    });

    expect(acquireLock).toHaveBeenCalledWith("approve-book");
    const [approved] = await state.loadChapterIndex("approve-book");
    expect(approved?.status).toBe("approved");
    expect(approved?.updatedAt).not.toBe(originalUpdatedAt);
    await expect(stat(join(state.bookDir("approve-book"), ".write.lock"))).rejects.toThrow();
  });

  it("approves every pending chapter in one locked index mutation", async () => {
    const bookId = "approve-all-book";
    await state.saveChapterIndex(bookId, [
      chapter(1, "ready-for-review"),
      chapter(2, "audit-failed"),
      chapter(3, "approved"),
    ]);
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    await expect(executeCoreMutation({ state }, {
      kind: "approve-all",
      bookId,
    })).resolves.toEqual({
      bookId,
      approvedCount: 2,
      chapterNumbers: [1, 2],
    });

    expect(acquireLock).toHaveBeenCalledWith(bookId);
    const updated = await state.loadChapterIndex(bookId);
    expect(updated.map((entry) => entry.status)).toEqual(["approved", "approved", "approved"]);
    await expect(stat(join(state.bookDir(bookId), ".write.lock"))).rejects.toThrow();
  });

  it("throws a typed error for a missing chapter and releases the lock", async () => {
    await state.saveChapterIndex("missing-book", [chapter(1)]);

    await expect(executeChapterMutation({ state }, {
      kind: "approve",
      bookId: "missing-book",
      chapterNumber: 2,
    })).rejects.toBeInstanceOf(ChapterMutationChapterNotFoundError);

    const release = await state.acquireBookLock("missing-book");
    await release();
  });

  it("preserves subsequent chapters when legacy reject behavior is requested", async () => {
    await state.saveChapterIndex("keep-book", [chapter(1), chapter(2)]);

    const result = await executeChapterMutation({ state }, {
      kind: "reject",
      bookId: "keep-book",
      chapterNumber: 1,
      keepSubsequent: true,
      reason: "Continuity issue",
    });

    expect(result).toEqual({
      bookId: "keep-book",
      chapterNumber: 1,
      status: "rejected",
      discarded: [],
      keepSubsequent: true,
    });
    const index = await state.loadChapterIndex("keep-book");
    expect(index).toHaveLength(2);
    expect(index[0]).toMatchObject({ status: "rejected", reviewNote: "Continuity issue" });
  });

  it("rolls back the rejected chapter and all dependent chapters by default", async () => {
    const bookId = "rollback-book";
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "current_state.md"), "state-0", "utf-8");
    await writeFile(join(storyDir, "pending_hooks.md"), "hooks-0", "utf-8");
    await state.snapshotState(bookId, 0);
    await Promise.all([
      writeFile(join(chaptersDir, "0001_one.md"), "one", "utf-8"),
      writeFile(join(chaptersDir, "0002_two.md"), "two", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [chapter(1), chapter(2)]);

    const result = await executeChapterMutation({ state }, {
      kind: "reject",
      bookId,
      chapterNumber: 1,
    });

    expect(result).toEqual({
      bookId,
      chapterNumber: 1,
      status: "rejected",
      discarded: [1, 2],
      keepSubsequent: false,
      rolledBackTo: 0,
    });
    await expect(state.loadChapterIndex(bookId)).resolves.toEqual([]);
    await expect(stat(join(chaptersDir, "0001_one.md"))).rejects.toThrow();
    await expect(stat(join(chaptersDir, "0002_two.md"))).rejects.toThrow();
  });

  it("delegates rewrite to PipelineRunner so rollback and regeneration keep one lock owner", async () => {
    const rewriteResult: RewriteChapterResult = {
      operationId: "rewrite-operation",
      chapterNumber: 2,
      title: "Rewritten",
      wordCount: 2200,
      auditResult: { passed: true, issues: [], summary: "ok" },
      revised: false,
      status: "ready-for-review",
      rolledBackTo: 1,
      discarded: [2, 3],
    };
    const rewriteChapter = vi.fn().mockResolvedValue(rewriteResult);
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    const result = await executeChapterMutation({ state, pipeline: { rewriteChapter } }, {
      kind: "rewrite",
      bookId: "rewrite-book",
      chapterNumber: 2,
      wordCount: 2200,
      brief: "Keep the confrontation focused.",
    });

    expect(result).toBe(rewriteResult);
    expect(rewriteChapter).toHaveBeenCalledWith(
      "rewrite-book",
      2,
      2200,
      "Keep the confrontation focused.",
    );
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it("saves a chapter through the shared command, clears stale runtime files, and marks review required", async () => {
    const bookId = "save-book";
    const bookDir = state.bookDir(bookId);
    const chaptersDir = join(bookDir, "chapters");
    const runtimeDir = join(bookDir, "story", "runtime");
    await mkdir(chaptersDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(chaptersDir, "0001_Original.md"), "# Original\n\nOld body.\n", "utf-8");
    await writeFile(join(runtimeDir, "chapter-0001.trace.json"), "{}", "utf-8");
    await state.saveChapterIndex(bookId, [chapter(1)]);

    const result = await executeCoreMutation({ state }, {
      kind: "save-chapter",
      bookId,
      chapterNumber: 1,
      content: "# Updated\n\nNew body.",
    });

    expect(result).toMatchObject({
      bookId,
      chapterNumber: 1,
      status: "audit-failed",
      warning: "[warning] Manual chapter edit requires review before continuation.",
    });
    await expect(readFile(join(chaptersDir, "0001_Original.md"), "utf-8"))
      .resolves.toBe("# Updated\n\nNew body.\n");
    await expect(stat(join(runtimeDir, "chapter-0001.trace.json"))).rejects.toThrow();
    const [updated] = await state.loadChapterIndex(bookId);
    expect(updated).toMatchObject({
      status: "audit-failed",
      auditIssues: ["[warning] Manual chapter edit requires review before continuation."],
    });
  });

  it("revises foundation under the command-owned book lock", async () => {
    const reviseFoundation = vi.fn(async () => undefined);
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    await expect(executeCoreMutation({ state, pipeline: { reviseFoundation } }, {
      kind: "revise-foundation",
      bookId: "foundation-book",
      feedback: "Make the protagonist colder.",
    })).resolves.toEqual({ bookId: "foundation-book", revised: true });

    expect(acquireLock).toHaveBeenCalledWith("foundation-book");
    expect(reviseFoundation).toHaveBeenCalledWith("foundation-book", "Make the protagonist colder.");
    await expect(stat(join(state.bookDir("foundation-book"), ".write.lock"))).rejects.toThrow();
  });

  it("writes canonical truth files atomically and rejects new-layout compatibility shims", async () => {
    const bookId = "truth-book";
    const storyDir = join(state.bookDir(bookId), "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await writeFile(join(storyDir, "outline", "story_frame.md"), "# Frame\n", "utf-8");

    await expect(executeCoreMutation({ state }, {
      kind: "edit-truth",
      bookId,
      fileName: "current_focus.md",
      content: "# Current Focus\n\nFollow the harbor debt.\n",
    })).resolves.toEqual({ bookId, fileName: "current_focus.md" });
    await expect(readFile(join(storyDir, "current_focus.md"), "utf-8"))
      .resolves.toContain("Follow the harbor debt");

    await expect(executeCoreMutation({ state }, {
      kind: "edit-truth",
      bookId,
      fileName: "book_rules.md",
      content: "# Wrong target\n",
    })).rejects.toMatchObject({
      code: "LEGACY_TRUTH_SHIM",
    });
  });

  it("renames an entity through the command-owned lock", async () => {
    const bookId = "rename-book";
    const storyDir = join(state.bookDir(bookId), "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "current_focus.md"), "Find Alpha before dawn.\n", "utf-8");
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    const result = await executeCoreMutation({ state }, {
      kind: "rename-entity",
      bookId,
      entityType: "character",
      oldValue: "Alpha",
      newValue: "Beta",
    });

    expect(result.execution.summary).toContain("Renamed Alpha to Beta");
    expect(acquireLock).toHaveBeenCalledWith(bookId);
    await expect(readFile(join(storyDir, "current_focus.md"), "utf-8")).resolves.toBe("Find Beta before dawn.\n");
    await expect(stat(join(state.bookDir(bookId), ".write.lock"))).rejects.toThrow();
  });

  it("validates and updates book config inside the shared lock", async () => {
    const bookId = "config-book";
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "Config Book",
      platform: "other",
      genre: "urban",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2000,
      language: "zh",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    const result = await executeCoreMutation({ state }, {
      kind: "update-book-config",
      bookId,
      updates: { chapterWordCount: 2600, targetChapters: 30, language: "en" },
    });

    expect(result.previous).toMatchObject({ chapterWordCount: 2000, targetChapters: 20, language: "zh" });
    expect(result.book).toMatchObject({ chapterWordCount: 2600, targetChapters: 30, language: "en" });
    expect(result.book.updatedAt).not.toBe(result.previous.updatedAt);
    expect(acquireLock).toHaveBeenCalledWith(bookId);
    await expect(state.loadBookConfig(bookId)).resolves.toEqual(result.book);

    await expect(executeCoreMutation({ state }, {
      kind: "update-book-config",
      bookId,
      updates: { chapterWordCount: "bad" },
    })).rejects.toMatchObject({ code: "INVALID_BOOK_CONFIG" });
    await expect(state.loadBookConfig(bookId)).resolves.toEqual(result.book);
  });

  it("sets and inherits chapter review mode without discarding other writing settings", async () => {
    const bookId = "review-mode-book";
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "Review Mode Book",
      platform: "other",
      genre: "urban",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2000,
      language: "zh",
      writing: { revisionGate: "lenient" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    const manual = await executeCoreMutation({ state }, {
      kind: "set-chapter-review-mode",
      bookId,
      mode: "manual",
    });
    expect(manual).toMatchObject({ bookId, bookMode: "manual" });
    expect(manual.book.writing).toEqual({ reviewMode: "manual", revisionGate: "lenient" });

    const inherited = await executeCoreMutation({ state }, {
      kind: "set-chapter-review-mode",
      bookId,
      mode: "inherit",
    });
    expect(inherited).toMatchObject({ bookId, bookMode: null });
    expect(inherited.book.writing).toEqual({ revisionGate: "lenient" });
    expect(acquireLock).toHaveBeenCalledTimes(2);
    await expect(stat(join(state.bookDir(bookId), ".write.lock"))).rejects.toThrow();
  });

  it("deletes a book under the command-owned lock", async () => {
    const bookId = "delete-book";
    const bookDir = state.bookDir(bookId);
    await mkdir(bookDir, { recursive: true });
    await writeFile(join(bookDir, "book.json"), "{}", "utf-8");
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    await expect(executeCoreMutation({ state }, {
      kind: "delete-book",
      bookId,
    })).resolves.toEqual({ bookId, deleted: true });

    expect(acquireLock).toHaveBeenCalledWith(bookId);
    await expect(stat(bookDir)).rejects.toThrow();
  });

  it("rejects unsafe book IDs before acquiring a mutation lock", async () => {
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    await expect(executeCoreMutation({ state }, {
      kind: "delete-book",
      bookId: "../outside",
    })).rejects.toMatchObject({ code: "INVALID_MUTATION" });

    expect(acquireLock).not.toHaveBeenCalled();
  });

  it("returns a typed not-found error when deleting a missing book", async () => {
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    await expect(executeCoreMutation({ state }, {
      kind: "delete-book",
      bookId: "missing-delete-book",
    })).rejects.toMatchObject({ code: "BOOK_NOT_FOUND" });

    expect(acquireLock).not.toHaveBeenCalled();
  });

  it("runs plan, compose, audit, and consolidate with one lock and a shared recovery contract", async () => {
    const bookId = "workflow-book";
    const order: string[] = [];
    const recovery = {
      kind: "rolled-back" as const,
      chapterNumber: 3,
      rolledBackTo: 2,
      operationId: "interrupted-write",
    };
    const recover = vi.spyOn(state, "recoverIncompleteChapterPersistence").mockImplementation(async () => {
      order.push("recover");
      return recovery;
    });
    const acquireLock = vi.spyOn(state, "acquireBookLock");
    const planChapter = vi.fn(async () => {
      order.push("plan");
      return { bookId, chapterNumber: 3, intentPath: "story/runtime/intent.md", goal: "Advance", conflicts: [] };
    });
    const composeChapter = vi.fn(async () => {
      order.push("compose");
      return {
        bookId,
        chapterNumber: 3,
        intentPath: "story/runtime/intent.md",
        goal: "Advance",
        conflicts: [],
        contextPath: "story/runtime/context.md",
        ruleStackPath: "story/runtime/rules.json",
        tracePath: "story/runtime/trace.json",
      };
    });
    const auditDraft = vi.fn(async () => {
      order.push("audit");
      return { chapterNumber: 2, passed: true, issues: [], summary: "ok" };
    });
    const consolidateBook = vi.fn(async () => {
      order.push("consolidate");
      return {
        volumeSummaries: "summary",
        archivedVolumes: 1,
        retainedChapters: 8,
        promotedHookCount: 0,
      };
    });
    const pipeline = { planChapter, composeChapter, auditDraft, consolidateBook };

    const planned = await executeCoreMutation({ state, pipeline }, {
      kind: "plan-chapter",
      bookId,
      context: "focus",
    });
    const composed = await executeCoreMutation({ state, pipeline }, {
      kind: "compose-chapter",
      bookId,
      context: "reuse plan",
    });
    const audited = await executeCoreMutation({ state, pipeline }, {
      kind: "audit-chapter",
      bookId,
      chapterNumber: 2,
    });
    const consolidated = await executeCoreMutation({ state, pipeline }, {
      kind: "consolidate-book",
      bookId,
    });

    expect(planned.recovery).toEqual(recovery);
    expect(composed.recovery).toEqual(recovery);
    expect(audited.recovery).toEqual(recovery);
    expect(consolidated.recovery).toEqual(recovery);
    expect(order).toEqual([
      "recover", "plan",
      "recover", "compose",
      "recover", "audit",
      "recover", "consolidate",
    ]);
    expect(acquireLock).toHaveBeenCalledTimes(4);
    expect(recover).toHaveBeenCalledTimes(4);
    expect(planChapter).toHaveBeenCalledWith(bookId, "focus");
    expect(composeChapter).toHaveBeenCalledWith(bookId, "reuse plan");
    expect(auditDraft).toHaveBeenCalledWith(bookId, 2);
    expect(consolidateBook).toHaveBeenCalledWith(bookId);
    await expect(stat(join(state.bookDir(bookId), ".write.lock"))).rejects.toThrow();
  });

  it("releases the workflow lock when a delegated operation fails", async () => {
    const bookId = "failed-workflow-book";
    const runtimeDir = join(state.bookDir(bookId), "story", "runtime");
    const intentPath = join(runtimeDir, "chapter-0001.intent.md");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(intentPath, "original intent", "utf-8");
    const planChapter = vi.fn(async () => {
      await writeFile(intentPath, "partial replacement", "utf-8");
      await writeFile(join(runtimeDir, "partial.trace.json"), "{}", "utf-8");
      throw new Error("planning failed");
    });

    await expect(executeCoreMutation({ state, pipeline: { planChapter } }, {
      kind: "plan-chapter",
      bookId,
    })).rejects.toThrow("planning failed");

    await expect(readFile(intentPath, "utf-8")).resolves.toBe("original intent");
    await expect(stat(join(runtimeDir, "partial.trace.json"))).rejects.toThrow();
    await expect(stat(join(state.bookDir(bookId), ".core-workflow-mutation.json"))).rejects.toThrow();
    const release = await state.acquireBookLock(bookId);
    await release();
  });

  it("recovers an interrupted workflow before starting the next command", async () => {
    const bookId = "interrupted-workflow-book";
    const runtimeDir = join(state.bookDir(bookId), "story", "runtime");
    const intentPath = join(runtimeDir, "chapter-0001.intent.md");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(intentPath, "stable intent", "utf-8");
    await state.beginCoreWorkflowMutation(bookId, "plan-chapter");
    await writeFile(intentPath, "interrupted intent", "utf-8");

    const result = await executeCoreMutation({
      state,
      pipeline: {
        planChapter: async () => ({
          bookId,
          chapterNumber: 1,
          intentPath: "story/runtime/chapter-0001.intent.md",
          goal: "Continue",
          conflicts: [],
        }),
      },
    }, { kind: "plan-chapter", bookId });

    expect(result.workflowRecovery).toEqual({ kind: "rolled-back", workflow: "plan-chapter" });
    await expect(readFile(intentPath, "utf-8")).resolves.toBe("stable intent");
  });
});

function chapter(
  number: number,
  status: ChapterMeta["status"] = "ready-for-review",
  updatedAt = "2026-01-01T00:00:00.000Z",
): ChapterMeta {
  return {
    number,
    title: `Chapter ${number}`,
    status,
    wordCount: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    auditIssues: [],
    lengthWarnings: [],
  };
}
