import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodeMeta } from "../models/episode.js";
import type { RewriteEpisodeResult } from "../pipeline/runner.js";
import {
  EpisodeMutationEpisodeNotFoundError,
  executeCoreMutation,
  executeEpisodeMutation,
} from "../pipeline/episode-mutations.js";
import { StateManager } from "../state/manager.js";
import { createEpisodeScriptJson, createEpisodeScriptMarkdown } from "./episode-test-fixtures.js";
import { buildEpisodeReviewEvidence } from "../pipeline/episode-review-evidence.js";

describe("executeEpisodeMutation", () => {
  let root: string;
  let state: StateManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-episode-mutation-"));
    state = new StateManager(root);
    const originalLoadEpisodeBookConfig = state.loadEpisodeBookConfig.bind(state);
    vi.spyOn(state, "loadEpisodeBookConfig").mockImplementation(async (bookId) => {
      try {
        return await originalLoadEpisodeBookConfig(bookId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
        return {
          id: bookId,
          title: bookId,
          platform: "other",
          genre: "other",
          status: "active",
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          targetEpisodes: 100,
          episodeDurationSeconds: 90,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      }
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedApprovableEpisode(bookId: string, episodeNumber: number): Promise<void> {
    const episodesDir = join(state.bookDir(bookId), "episodes");
    await mkdir(episodesDir, { recursive: true });
    const jsonFile = `${String(episodeNumber).padStart(4, "0")}_Episode.json`;
    const json = createEpisodeScriptJson(episodeNumber, `Episode ${episodeNumber}`);
    await writeFile(join(episodesDir, jsonFile), json, "utf-8");
    await writeFile(
      join(episodesDir, `${String(episodeNumber).padStart(4, "0")}_review.json`),
      JSON.stringify(buildEpisodeReviewEvidence({
        artifact: `episodes/${jsonFile}`,
        content: json,
        issues: [],
      })),
      "utf-8",
    );
  }

  it("approves under the shared book lock and updates the episode timestamp", async () => {
    const originalUpdatedAt = "2026-01-01T00:00:00.000Z";
    await state.saveEpisodeIndex("approve-book", [episode(1, "ready-for-review", originalUpdatedAt)]);
    await seedApprovableEpisode("approve-book", 1);
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    await expect(executeEpisodeMutation({ state }, {
      kind: "approve",
      bookId: "approve-book",
      episodeNumber: 1,
    })).resolves.toEqual({
      bookId: "approve-book",
      episodeNumber: 1,
      status: "approved",
    });

    expect(acquireLock).toHaveBeenCalledWith("approve-book");
    const [approved] = await state.loadEpisodeIndex("approve-book");
    expect(approved?.status).toBe("approved");
    expect(approved?.updatedAt).not.toBe(originalUpdatedAt);
    await expect(stat(join(state.bookDir("approve-book"), ".write.lock"))).rejects.toThrow();
  });

  it("approves every pending episode in one locked index mutation", async () => {
    const bookId = "approve-all-book";
    await state.saveEpisodeIndex(bookId, [
      episode(1, "ready-for-review"),
      episode(2, "audit-failed"),
      episode(3, "approved"),
    ]);
    await seedApprovableEpisode(bookId, 1);
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    await expect(executeCoreMutation({ state }, {
      kind: "approve-all",
      bookId,
    })).resolves.toEqual({
      bookId,
      approvedCount: 1,
      episodeNumbers: [1],
    });

    expect(acquireLock).toHaveBeenCalledWith(bookId);
    const updated = await state.loadEpisodeIndex(bookId);
    expect(updated.map((entry) => entry.status)).toEqual(["approved", "audit-failed", "approved"]);
    await expect(stat(join(state.bookDir(bookId), ".write.lock"))).rejects.toThrow();
  });

  it("blocks approval when the review sidecar has open blocking findings", async () => {
    const bookId = "approve-blocked-book";
    await state.saveEpisodeIndex(bookId, [episode(1, "ready-for-review")]);
    const episodesDir = join(state.bookDir(bookId), "episodes");
    await mkdir(episodesDir, { recursive: true });
    await writeFile(join(episodesDir, "0001_archive.json"), createEpisodeScriptJson(1), "utf-8");
    await writeFile(
      join(episodesDir, "0001_review.json"),
      JSON.stringify({
        mode: "evidence",
        independent: false,
        status: "REVISE",
        requestedReviewMode: "self_check",
        effectiveReviewMode: "self_check",
        reviewer: {
          owner: "pipeline",
          kind: "self_check",
          independence: false,
          excludedSourceOwner: "writer",
        },
        reviewedArtifacts: [{
          artifact: "episodes/0001_archive.json",
          sha256: "a".repeat(64),
        }],
        findings: [{
          id: "EP-001-screenplay-duration",
          severity: "critical",
          ruleClass: "structural_invariant",
          description: "blocking",
          suggestion: "fix",
          evidenceRefs: [],
          owner: "short-drama-write",
          status: "open",
        }],
      }, null, 2),
      "utf-8",
    );

    await expect(executeEpisodeMutation({ state }, {
      kind: "approve",
      bookId,
      episodeNumber: 1,
    })).rejects.toMatchObject({ code: "EPISODE_HAS_BLOCKING_REVIEW_FINDINGS" });
  });

  it("blocks approval when review evidence is missing or the episode failed audit", async () => {
    await state.saveEpisodeIndex("missing-evidence-book", [episode(1, "ready-for-review")]);
    await expect(executeEpisodeMutation({ state }, {
      kind: "approve",
      bookId: "missing-evidence-book",
      episodeNumber: 1,
    })).rejects.toMatchObject({ code: "EPISODE_HAS_BLOCKING_REVIEW_FINDINGS" });

    await state.saveEpisodeIndex("failed-approval-book", [episode(1, "audit-failed")]);
    await expect(executeEpisodeMutation({ state }, {
      kind: "approve",
      bookId: "failed-approval-book",
      episodeNumber: 1,
    })).rejects.toMatchObject({ code: "EPISODE_NOT_READY_FOR_APPROVAL" });
  });

  it("throws a typed error for a missing episode and releases the lock", async () => {
    await state.saveEpisodeIndex("missing-book", [episode(1)]);

    await expect(executeEpisodeMutation({ state }, {
      kind: "approve",
      bookId: "missing-book",
      episodeNumber: 2,
    })).rejects.toBeInstanceOf(EpisodeMutationEpisodeNotFoundError);

    const release = await state.acquireBookLock("missing-book");
    await release();
  });

  it("rejects keep-subsequent when later episodes depend on the rejected episode", async () => {
    await state.saveEpisodeIndex("keep-book", [episode(1), episode(2)]);

    await expect(executeEpisodeMutation({ state }, {
      kind: "reject",
      bookId: "keep-book",
      episodeNumber: 1,
      keepSubsequent: true,
      reason: "Continuity issue",
    })).rejects.toMatchObject({ code: "UNSAFE_REJECT_WITH_DEPENDENTS" });
    const index = await state.loadEpisodeIndex("keep-book");
    expect(index).toHaveLength(2);
    expect(index[0]).not.toMatchObject({ status: "rejected" });
  });

  it("allows keeping only the latest rejected artifact", async () => {
    await state.saveEpisodeIndex("keep-latest-book", [episode(1)]);

    await expect(executeEpisodeMutation({ state }, {
      kind: "reject",
      bookId: "keep-latest-book",
      episodeNumber: 1,
      keepSubsequent: true,
      reason: "Continuity issue",
    })).resolves.toMatchObject({ status: "rejected", keepSubsequent: true });

    const index = await state.loadEpisodeIndex("keep-latest-book");
    expect(index[0]).toMatchObject({ status: "rejected", reviewNote: "Continuity issue" });
  });

  it("rolls back the rejected episode and all dependent episodes by default", async () => {
    const bookId = "rollback-book";
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const episodesDir = join(bookDir, "episodes");
    await mkdir(episodesDir, { recursive: true });
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "current_state.md"), "state-0", "utf-8");
    await writeFile(join(storyDir, "pending_hooks.md"), "hooks-0", "utf-8");
    await state.snapshotState(bookId, 0);
    await Promise.all([
      writeFile(join(episodesDir, "0001_one.md"), "one", "utf-8"),
      writeFile(join(episodesDir, "0002_two.md"), "two", "utf-8"),
    ]);
    await state.saveEpisodeIndex(bookId, [episode(1), episode(2)]);

    const result = await executeEpisodeMutation({ state }, {
      kind: "reject",
      bookId,
      episodeNumber: 1,
    });

    expect(result).toEqual({
      bookId,
      episodeNumber: 1,
      status: "rejected",
      discarded: [1, 2],
      keepSubsequent: false,
      rolledBackTo: 0,
    });
    await expect(state.loadEpisodeIndex(bookId)).resolves.toEqual([]);
    await expect(stat(join(episodesDir, "0001_one.md"))).rejects.toThrow();
    await expect(stat(join(episodesDir, "0002_two.md"))).rejects.toThrow();
  });

  it("delegates rewrite to PipelineRunner so rollback and regeneration keep one lock owner", async () => {
    const rewriteResult: RewriteEpisodeResult = {
      operationId: "rewrite-operation",
      episodeNumber: 2,
      title: "Rewritten",
      episodeDurationSeconds: 2200,
      auditResult: { passed: true, issues: [], summary: "ok" },
      revised: false,
      status: "ready-for-review",
      rolledBackTo: 1,
      discarded: [2, 3],
    };
    const rewriteEpisode = vi.fn().mockResolvedValue(rewriteResult);
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    const result = await executeEpisodeMutation({ state, pipeline: { rewriteEpisode } }, {
      kind: "rewrite",
      bookId: "rewrite-book",
      episodeNumber: 2,
      episodeDurationSeconds: 2200,
      brief: "Keep the confrontation focused.",
    });

    expect(result).toBe(rewriteResult);
    expect(rewriteEpisode).toHaveBeenCalledWith(
      "rewrite-book",
      2,
      2200,
      "Keep the confrontation focused.",
    );
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it("saves a episode through the shared command, clears stale runtime files, and marks review required", async () => {
    const bookId = "save-book";
    const bookDir = state.bookDir(bookId);
    const episodesDir = join(bookDir, "episodes");
    const runtimeDir = join(bookDir, "story", "runtime");
    await mkdir(episodesDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(episodesDir, "0001_Original.md"), createEpisodeScriptMarkdown(1, "Original"), "utf-8");
    await writeFile(join(episodesDir, "0001_Original.json"), createEpisodeScriptJson(1, "Original"), "utf-8");
    await writeFile(join(runtimeDir, "episode-0001.trace.json"), "{}", "utf-8");
    await state.saveEpisodeIndex(bookId, [episode(1)]);

    const result = await executeCoreMutation({ state }, {
      kind: "save-episode",
      bookId,
      episodeNumber: 1,
      content: createEpisodeScriptMarkdown(1, "Updated"),
    });

    expect(result).toMatchObject({
      bookId,
      episodeNumber: 1,
      status: "audit-failed",
      warning: "[critical] Manual episode edit requires review before continuation.",
    });
    await expect(readFile(join(episodesDir, "0001_Original.md"), "utf-8"))
      .resolves.toContain("Updated");
    await expect(readFile(join(episodesDir, "0001_Original.json"), "utf-8"))
      .resolves.toContain('"title": "Updated"');
    await expect(stat(join(runtimeDir, "episode-0001.trace.json"))).rejects.toThrow();
    const [updated] = await state.loadEpisodeIndex(bookId);
    expect(updated).toMatchObject({
      status: "audit-failed",
      auditIssues: ["[critical] Manual episode edit requires review before continuation."],
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
      schemaVersion: "inkos-episode-v2" as const,
      format: "screenplay" as const,
      targetEpisodes: 20,
      episodeDurationSeconds: 90,
      language: "zh",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    const result = await executeCoreMutation({ state }, {
      kind: "update-book-config",
      bookId,
      updates: {
        targetEpisodes: 30,
        episodeDurationSeconds: 95,
        language: "en",
      },
    });

    expect(result.previous).toMatchObject({ episodeDurationSeconds: 90, targetEpisodes: 20, language: "zh" });
    expect(result.book).toMatchObject({
      targetEpisodes: 30,
      episodeDurationSeconds: 95,
      language: "en",
    });
    expect(result.book.updatedAt).not.toBe(result.previous.updatedAt);
    expect(acquireLock).toHaveBeenCalledWith(bookId);
    await expect(state.loadBookConfig(bookId)).resolves.toEqual(result.book);

    await expect(executeCoreMutation({ state }, {
      kind: "update-book-config",
      bookId,
      updates: { episodeDurationSeconds: "bad" },
    })).rejects.toMatchObject({ code: "INVALID_BOOK_CONFIG" });
    await expect(state.loadBookConfig(bookId)).resolves.toEqual(result.book);
  });

  it("sets and inherits episode review mode without discarding other writing settings", async () => {
    const bookId = "review-mode-book";
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "Review Mode Book",
      platform: "other",
      genre: "urban",
      status: "active",
      schemaVersion: "inkos-episode-v2" as const,
      format: "screenplay" as const,
      targetEpisodes: 20,
      episodeDurationSeconds: 90,
      language: "zh",
      writing: { revisionGate: "lenient" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const acquireLock = vi.spyOn(state, "acquireBookLock");

    const manual = await executeCoreMutation({ state }, {
      kind: "set-episode-review-mode",
      bookId,
      mode: "manual",
    });
    expect(manual).toMatchObject({ bookId, bookMode: "manual" });
    expect(manual.book.writing).toEqual({ reviewMode: "manual", revisionGate: "lenient" });

    const inherited = await executeCoreMutation({ state }, {
      kind: "set-episode-review-mode",
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
      episodeNumber: 3,
      rolledBackTo: 2,
      operationId: "interrupted-write",
    };
    const recover = vi.spyOn(state, "recoverIncompleteEpisodePersistence").mockImplementation(async () => {
      order.push("recover");
      return recovery;
    });
    const acquireLock = vi.spyOn(state, "acquireBookLock");
    const planEpisode = vi.fn(async () => {
      order.push("plan");
      return { bookId, episodeNumber: 3, intentPath: "story/runtime/intent.md", goal: "Advance", conflicts: [] };
    });
    const composeEpisode = vi.fn(async () => {
      order.push("compose");
      return {
        bookId,
        episodeNumber: 3,
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
      return { episodeNumber: 2, passed: true, issues: [], summary: "ok" };
    });
    const consolidateBook = vi.fn(async () => {
      order.push("consolidate");
      return {
        volumeSummaries: "summary",
        archivedVolumes: 1,
        retainedEpisodes: 8,
        promotedHookCount: 0,
      };
    });
    const pipeline = { planEpisode, composeEpisode, auditDraft, consolidateBook };

    const planned = await executeCoreMutation({ state, pipeline }, {
      kind: "plan-episode",
      bookId,
      context: "focus",
    });
    const composed = await executeCoreMutation({ state, pipeline }, {
      kind: "compose-episode",
      bookId,
      context: "reuse plan",
    });
    const audited = await executeCoreMutation({ state, pipeline }, {
      kind: "audit-episode",
      bookId,
      episodeNumber: 2,
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
    expect(planEpisode).toHaveBeenCalledWith(bookId, "focus");
    expect(composeEpisode).toHaveBeenCalledWith(bookId, "reuse plan");
    expect(auditDraft).toHaveBeenCalledWith(bookId, 2);
    expect(consolidateBook).toHaveBeenCalledWith(bookId);
    await expect(stat(join(state.bookDir(bookId), ".write.lock"))).rejects.toThrow();
  });

  it("releases the workflow lock when a delegated operation fails", async () => {
    const bookId = "failed-workflow-book";
    const runtimeDir = join(state.bookDir(bookId), "story", "runtime");
    const intentPath = join(runtimeDir, "episode-0001.intent.md");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(intentPath, "original intent", "utf-8");
    const planEpisode = vi.fn(async () => {
      await writeFile(intentPath, "partial replacement", "utf-8");
      await writeFile(join(runtimeDir, "partial.trace.json"), "{}", "utf-8");
      throw new Error("planning failed");
    });

    await expect(executeCoreMutation({ state, pipeline: { planEpisode } }, {
      kind: "plan-episode",
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
    const intentPath = join(runtimeDir, "episode-0001.intent.md");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(intentPath, "stable intent", "utf-8");
    await state.beginCoreWorkflowMutation(bookId, "plan-episode");
    await writeFile(intentPath, "interrupted intent", "utf-8");

    const result = await executeCoreMutation({
      state,
      pipeline: {
        planEpisode: async () => ({
          bookId,
          episodeNumber: 1,
          intentPath: "story/runtime/episode-0001.intent.md",
          goal: "Continue",
          conflicts: [],
        }),
      },
    }, { kind: "plan-episode", bookId });

    expect(result.workflowRecovery).toEqual({ kind: "rolled-back", workflow: "plan-episode" });
    await expect(readFile(intentPath, "utf-8")).resolves.toBe("stable intent");
  });
});

function episode(
  episodeNumber: number,
  status: EpisodeMeta["status"] = "ready-for-review",
  updatedAt = "2026-01-01T00:00:00.000Z",
): EpisodeMeta {
  return {
    episodeNumber,
    title: `Episode ${episodeNumber}`,
    status,
    episodeDurationSeconds: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    auditIssues: [],
    lengthWarnings: [],
  };
}
