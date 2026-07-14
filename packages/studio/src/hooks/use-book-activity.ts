import type { SSEMessage } from "./use-sse";
import type { PipelineFailureStage } from "../lib/pipeline-failure-advice";
import type { BookSummary } from "../shared/contracts";

export type BookOperationKind = "write" | "draft" | "rewrite" | "repair-state" | "resync";

const OPERATION_STARTS: Readonly<Record<string, BookOperationKind>> = {
  "write:start": "write",
  "draft:start": "draft",
  "rewrite:start": "rewrite",
  "repair-state:start": "repair-state",
  "resync:start": "resync",
};
const START_EVENTS = new Set(Object.keys(OPERATION_STARTS));
const TERMINAL_EVENTS = new Set(
  Object.values(OPERATION_STARTS).flatMap((kind) => [
    `${kind}:complete`,
    `${kind}:error`,
    `${kind}:cancelled`,
  ]),
);
const BOOK_REFRESH_EVENTS = new Set([
  "write:complete",
  "write:error",
  "write:cancelled",
  "draft:complete",
  "draft:error",
  "draft:cancelled",
  "rewrite:complete",
  "rewrite:error",
  "rewrite:cancelled",
  "repair-state:complete",
  "repair-state:error",
  "repair-state:cancelled",
  "resync:complete",
  "resync:error",
  "resync:cancelled",
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
  "write:cancelled",
  "draft:complete",
  "draft:error",
  "draft:cancelled",
  "rewrite:complete",
  "rewrite:error",
  "rewrite:cancelled",
  "repair-state:complete",
  "repair-state:error",
  "repair-state:cancelled",
  "resync:complete",
  "resync:error",
  "resync:cancelled",
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
  readonly activeOperation: {
    readonly requestId: string;
    readonly kind: BookOperationKind;
    readonly cancelling: boolean;
  } | null;
}

const FAILURE_STAGES: Readonly<Record<string, PipelineFailureStage>> = {
  "write:error": "write",
  "draft:error": "draft",
  "rewrite:error": "rewrite",
  "revise:error": "revise",
  "audit:error": "audit",
  "repair-state:error": "repair-state",
  "resync:error": "resync",
};

const COMPLETION_STAGES: Readonly<Record<string, PipelineFailureStage>> = {
  "write:complete": "write",
  "draft:complete": "draft",
  "rewrite:complete": "rewrite",
  "revise:complete": "revise",
  "audit:complete": "audit",
  "repair-state:complete": "repair-state",
  "resync:complete": "resync",
};

export type SidebarBookSummary = Pick<
  BookSummary,
  "id" | "title" | "genre" | "status" | "chaptersWritten"
>;

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
  let activeOperation: BookActivity["activeOperation"] = null;

  for (const message of messages) {
    if (getBookId(message) !== bookId) continue;

    const data = message.data as { error?: unknown; requestId?: unknown } | null;
    const operationKind = OPERATION_STARTS[message.event];
    if (operationKind && typeof data?.requestId === "string") {
      activeOperation = { requestId: data.requestId, kind: operationKind, cancelling: false };
      lastError = null;
      lastFailure = null;
    } else if (
      message.event.endsWith(":cancel-requested")
      && activeOperation
      && data?.requestId === activeOperation.requestId
    ) {
      activeOperation = {
        requestId: activeOperation.requestId,
        kind: activeOperation.kind,
        cancelling: true,
      };
    } else if (
      TERMINAL_EVENTS.has(message.event)
      && activeOperation
      && (typeof data?.requestId !== "string" || data.requestId === activeOperation.requestId)
    ) {
      activeOperation = null;
    }
    if (TERMINAL_EVENTS.has(message.event)) {
      if (message.event.startsWith("write:")) writing = false;
      if (message.event.startsWith("draft:")) drafting = false;
    }

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

  return { writing, drafting, lastError, lastFailure, activeOperation };
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
