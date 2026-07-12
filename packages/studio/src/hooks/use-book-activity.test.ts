import { describe, expect, it } from "vitest";
import type { SSEMessage } from "./use-sse";
import {
  applyBookCollectionEvent,
  deriveActiveBookIds,
  deriveBookActivity,
  shouldRefetchBookCollections,
  shouldRefetchBookView,
  shouldRefetchDaemonStatus,
} from "./use-book-activity";

function msg(event: string, data: unknown, timestamp: number): SSEMessage {
  return { event, data, timestamp, seq: timestamp };
}

describe("deriveBookActivity", () => {
  it("keeps a book in writing state after write:start until completion", () => {
    const messages: ReadonlyArray<SSEMessage> = [
      msg("write:start", { bookId: "alpha" }, 1),
      msg("log", { message: "Phase 1" }, 2),
      msg("llm:progress", { totalChars: 1200 }, 3),
    ];

    expect(deriveBookActivity(messages, "alpha")).toMatchObject({
      writing: true,
      drafting: false,
      lastError: null,
    });
  });

  it("clears writing state after completion or error", () => {
    const completed: ReadonlyArray<SSEMessage> = [
      msg("write:start", { bookId: "alpha" }, 1),
      msg("write:complete", { bookId: "alpha", chapterNumber: 2 }, 2),
    ];
    const errored: ReadonlyArray<SSEMessage> = [
      msg("write:start", { bookId: "alpha" }, 1),
      msg("write:error", { bookId: "alpha", error: "locked" }, 2),
    ];

    expect(deriveBookActivity(completed, "alpha")).toMatchObject({
      writing: false,
      lastError: null,
    });
    expect(deriveBookActivity(errored, "alpha")).toMatchObject({
      writing: false,
      lastError: "locked",
    });
  });

  it("tracks drafting independently from writing", () => {
    const messages: ReadonlyArray<SSEMessage> = [
      msg("draft:start", { bookId: "alpha" }, 1),
      msg("write:start", { bookId: "beta" }, 2),
    ];

    expect(deriveBookActivity(messages, "alpha")).toMatchObject({
      writing: false,
      drafting: true,
    });
  });

  it("retains the failed pipeline stage for follow-up actions", () => {
    const messages: ReadonlyArray<SSEMessage> = [
      msg("rewrite:error", { bookId: "alpha", error: "gateway timeout" }, 1),
      msg("audit:error", { bookId: "alpha", error: "audit model unavailable" }, 2),
    ];

    expect(deriveBookActivity(messages, "alpha")).toMatchObject({
      writing: false,
      drafting: false,
      lastError: "audit model unavailable",
      lastFailure: { stage: "audit", error: "audit model unavailable" },
    });
  });

  it("tracks cancellation by request id until the terminal cancelled event", () => {
    const cancelling: ReadonlyArray<SSEMessage> = [
      msg("resync:start", { bookId: "alpha", requestId: "req-1" }, 1),
      msg("resync:cancel-requested", { bookId: "alpha", requestId: "req-1" }, 2),
    ];
    const cancelled: ReadonlyArray<SSEMessage> = [
      ...cancelling,
      msg("resync:cancelled", { bookId: "alpha", requestId: "req-1" }, 3),
    ];

    expect(deriveBookActivity(cancelling, "alpha").activeOperation).toEqual({
      requestId: "req-1",
      kind: "resync",
      cancelling: true,
    });
    expect(deriveBookActivity(cancelled, "alpha").activeOperation).toBeNull();
  });

  it("does not clear a newer operation when an older request terminates", () => {
    const messages: ReadonlyArray<SSEMessage> = [
      msg("write:start", { bookId: "alpha", requestId: "req-old" }, 1),
      msg("write:start", { bookId: "alpha", requestId: "req-new" }, 2),
      msg("write:cancelled", { bookId: "alpha", requestId: "req-old" }, 3),
    ];

    expect(deriveBookActivity(messages, "alpha").activeOperation).toEqual({
      requestId: "req-new",
      kind: "write",
      cancelling: false,
    });
  });
});

describe("deriveActiveBookIds", () => {
  it("returns only books with in-flight background work", () => {
    const messages: ReadonlyArray<SSEMessage> = [
      msg("write:start", { bookId: "alpha" }, 1),
      msg("draft:start", { bookId: "beta" }, 2),
      msg("write:complete", { bookId: "alpha", chapterNumber: 2 }, 3),
      msg("write:start", { bookId: "gamma" }, 4),
      msg("draft:error", { bookId: "beta", error: "quota" }, 5),
    ];

    expect([...deriveActiveBookIds(messages)].sort()).toEqual(["gamma"]);
  });
});

describe("shouldRefetchBookView", () => {
  it("refreshes the book detail view after terminal background jobs for that book", () => {
    expect(shouldRefetchBookView(msg("write:complete", { bookId: "alpha" }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("draft:error", { bookId: "alpha", error: "quota" }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("rewrite:complete", { bookId: "alpha", chapterNumber: 3 }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("write:cancelled", { bookId: "alpha", requestId: "req-1" }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("resync:complete", { bookId: "alpha", chapter: 3 }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("revise:error", { bookId: "alpha", error: "bad" }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("audit:complete", { bookId: "alpha", chapter: 3, passed: true }, 1), "alpha")).toBe(true);
    expect(shouldRefetchBookView(msg("audit:start", { bookId: "alpha", chapter: 3 }, 1), "alpha")).toBe(false);
    expect(shouldRefetchBookView(msg("rewrite:complete", { bookId: "beta" }, 1), "alpha")).toBe(false);
  });
});

describe("shouldRefetchBookCollections", () => {
  it("refreshes book lists for create/delete and chapter-changing terminal events", () => {
    expect(shouldRefetchBookCollections(msg("book:created", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("book:deleted", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("write:complete", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("draft:error", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("rewrite:complete", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("repair-state:cancelled", { bookId: "alpha" }, 1))).toBe(true);
    expect(shouldRefetchBookCollections(msg("audit:start", { bookId: "alpha" }, 1))).toBe(false);
    expect(shouldRefetchBookCollections(undefined)).toBe(false);
  });
});

describe("shouldRefetchDaemonStatus", () => {
  it("refreshes daemon status for daemon terminal events", () => {
    expect(shouldRefetchDaemonStatus(msg("daemon:started", {}, 1))).toBe(true);
    expect(shouldRefetchDaemonStatus(msg("daemon:stopped", {}, 1))).toBe(true);
    expect(shouldRefetchDaemonStatus(msg("daemon:error", {}, 1))).toBe(true);
    expect(shouldRefetchDaemonStatus(msg("daemon:chapter", {}, 1))).toBe(false);
  });
});

describe("applyBookCollectionEvent", () => {
  it("upserts a created book from the event payload without requiring a refetch", () => {
    const books = [
      { id: "alpha", title: "Alpha", genre: "urban", status: "active", chaptersWritten: 3 },
    ];

    expect(applyBookCollectionEvent(books, msg("book:created", {
      bookId: "beta",
      book: { id: "beta", title: "Beta", genre: "xuanhuan", status: "outlining", chaptersWritten: 0 },
    }, 1))).toEqual([
      { id: "alpha", title: "Alpha", genre: "urban", status: "active", chaptersWritten: 3 },
      { id: "beta", title: "Beta", genre: "xuanhuan", status: "outlining", chaptersWritten: 0 },
    ]);
  });

  it("returns null when a collection event lacks enough data for incremental update", () => {
    expect(applyBookCollectionEvent([], msg("book:created", { bookId: "beta" }, 1))).toBeNull();
  });
});
