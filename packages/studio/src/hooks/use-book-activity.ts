import type { SSEMessage } from "./use-sse";
import type { PipelineFailureStage } from "../lib/pipeline-failure-advice";

const START_EVENTS = new Set(["write:start", "draft:start"]);
const TERMINAL_EVENTS = new Set(["write:complete", "write:error", "draft:complete", "draft:error"]);
const BOOK_REFRESH_EVENTS = new Set([
  "write:complete",
  "write:error",
  "draft:complete",
  "draft:error",
  "rewrite:complete",
  "rewrite:error",
  "revise:complete",
  "revise:error",
  "audit:complete",
  "audit:error",
]);

const BOOK_COLLECTION_REFRESH_EVENTS = new Set([
  "book:created",
  "book:deleted",
  "book:error",
  "write:complete",
  "write:error",
  "draft:complete",
  "draft:error",
  "rewrite:complete",
  "rewrite:error",
  "revise:complete",
  "revise:error",
  "audit:complete",
  "audit:error",
]);

const DAEMON_STATUS_REFRESH_EVENTS = new Set([
  "daemon:started",
  "daemon:stopped",
  "daemon:error",
]);

export interface BookActivity {
  readonly writing: boolean;
  readonly drafting: boolean;
  readonly lastError: string | null;
  readonly lastFailure: { readonly stage: PipelineFailureStage; readonly error: string } | null;
}

const FAILURE_STAGES: Readonly<Record<string, PipelineFailureStage>> = {
  "write:error": "write",
  "draft:error": "draft",
  "rewrite:error": "rewrite",
  "revise:error": "revise",
  "audit:error": "audit",
};

const COMPLETION_STAGES: Readonly<Record<string, PipelineFailureStage>> = {
  "write:complete": "write",
  "draft:complete": "draft",
  "rewrite:complete": "rewrite",
  "revise:complete": "revise",
  "audit:complete": "audit",
};

export interface SidebarBookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
}

function getBookId(message: SSEMessage): string | null {
  const data = message.data as { bookId?: unknown } | null;
  return typeof data?.bookId === "string" ? data.bookId : null;
}

function getBookSummary(message: SSEMessage): SidebarBookSummary | null {
  const data = message.data as { book?: unknown } | null;
  const book = data?.book;
  if (!book || typeof book !== "object") return null;
  const candidate = book as Partial<SidebarBookSummary>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.genre !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.chaptersWritten !== "number"
  ) {
    return null;
  }
  return {
    id: candidate.id,
    title: candidate.title,
    genre: candidate.genre,
    status: candidate.status,
    chaptersWritten: candidate.chaptersWritten,
  };
}

export function deriveActiveBookIds(messages: ReadonlyArray<SSEMessage>): ReadonlySet<string> {
  const active = new Set<string>();

  for (const message of messages) {
    const bookId = getBookId(message);
    if (!bookId) continue;

    if (START_EVENTS.has(message.event)) {
      active.add(bookId);
      continue;
    }

    if (TERMINAL_EVENTS.has(message.event)) {
      active.delete(bookId);
    }
  }

  return active;
}

export function deriveBookActivity(messages: ReadonlyArray<SSEMessage>, bookId: string): BookActivity {
  let writing = false;
  let drafting = false;
  let lastError: string | null = null;
  let lastFailure: BookActivity["lastFailure"] = null;

  for (const message of messages) {
    if (getBookId(message) !== bookId) continue;

    const data = message.data as { error?: unknown } | null;

    switch (message.event) {
      case "write:start":
        writing = true;
        lastError = null;
        lastFailure = null;
        break;
      case "write:complete":
        writing = false;
        if (lastFailure?.stage === COMPLETION_STAGES[message.event]) {
          lastError = null;
          lastFailure = null;
        }
        break;
      case "draft:start":
        drafting = true;
        lastError = null;
        lastFailure = null;
        break;
      case "draft:complete":
        drafting = false;
        if (lastFailure?.stage === COMPLETION_STAGES[message.event]) {
          lastError = null;
          lastFailure = null;
        }
        break;
      default:
        if (message.event === "write:error") writing = false;
        if (message.event === "draft:error") drafting = false;
        const stage = FAILURE_STAGES[message.event];
        if (stage) {
          const error = typeof data?.error === "string" ? data.error : "Unknown error";
          lastError = error;
          lastFailure = { stage, error };
          break;
        }
        const completionStage = COMPLETION_STAGES[message.event];
        if (completionStage && lastFailure?.stage === completionStage) {
          lastError = null;
          lastFailure = null;
        }
        break;
    }
  }

  return { writing, drafting, lastError, lastFailure };
}

export function shouldRefetchBookView(message: SSEMessage, bookId: string): boolean {
  return getBookId(message) === bookId && BOOK_REFRESH_EVENTS.has(message.event);
}

export function shouldRefetchBookCollections(message: SSEMessage | undefined): boolean {
  return Boolean(message && BOOK_COLLECTION_REFRESH_EVENTS.has(message.event));
}

export function shouldRefetchDaemonStatus(message: SSEMessage | undefined): boolean {
  return Boolean(message && DAEMON_STATUS_REFRESH_EVENTS.has(message.event));
}

export function applyBookCollectionEvent(
  books: ReadonlyArray<SidebarBookSummary>,
  message: SSEMessage | undefined,
): ReadonlyArray<SidebarBookSummary> | null {
  if (!message) return null;

  if (message.event === "book:created") {
    const book = getBookSummary(message);
    if (!book) return null;
    const existingIndex = books.findIndex((candidate) => candidate.id === book.id);
    if (existingIndex < 0) {
      return [...books, book];
    }
    return books.map((candidate, index) => index === existingIndex ? book : candidate);
  }

  if (message.event === "book:deleted") {
    const bookId = getBookId(message);
    if (!bookId) return null;
    return books.filter((book) => book.id !== bookId);
  }

  return null;
}
