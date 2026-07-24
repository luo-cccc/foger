import { describe, expect, it, vi } from "vitest";
import { buildApiUrl, deriveInvalidationPaths, fetchJson, LatestApiRequestGuard } from "./use-api";

describe("LatestApiRequestGuard", () => {
  it("invalidates and aborts an older request when a new request begins", () => {
    const guard = new LatestApiRequestGuard();
    const oldRequest = guard.begin();
    const currentRequest = guard.begin();

    expect(oldRequest.signal.aborted).toBe(true);
    expect(oldRequest.isCurrent()).toBe(false);
    expect(currentRequest.signal.aborted).toBe(false);
    expect(currentRequest.isCurrent()).toBe(true);

    guard.cancel();
    expect(currentRequest.signal.aborted).toBe(true);
    expect(currentRequest.isCurrent()).toBe(false);
  });
});

describe("buildApiUrl", () => {
  it("returns null for blank paths so callers can skip requests", () => {
    expect(buildApiUrl("")).toBeNull();
    expect(buildApiUrl("   ")).toBeNull();
  });

  it("prefixes api paths once", () => {
    expect(buildApiUrl("/books")).toBe("/api/v1/books");
    expect(buildApiUrl("books")).toBe("/api/v1/books");
    expect(buildApiUrl("/api/v1/books")).toBe("/api/v1/books");
  });
});

describe("fetchJson", () => {
  it("surfaces API error payloads on non-ok responses", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Bad request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toThrow("Bad request");
  });

  it("falls back to status text when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("boom", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(fetchJson("/books", {}, { fetchImpl })).rejects.toThrow("500 Internal Server Error");
  });

  it("surfaces nested api error messages from structured error payloads", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "INVALID_BOOK_ID", message: "Invalid book ID: ../bad" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books/../bad", {}, { fetchImpl })).rejects.toThrow("Invalid book ID: ../bad");
  });

  it("localizes known runtime errors before throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        error: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchJson("/books/demo/write-next", { method: "POST" }, { fetchImpl })).rejects.toThrow(
      "最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。",
    );
  });
});

describe("deriveInvalidationPaths", () => {
  it("refreshes book collections after creating a book", () => {
    expect(deriveInvalidationPaths("/books/create")).toEqual(["/api/v1/books"]);
    expect(deriveInvalidationPaths("/spinoff/init")).toEqual([]);
    expect(deriveInvalidationPaths("/imitation/init")).toEqual([]);
  });

  it("refreshes both collections and the current book after book mutations", () => {
    expect(deriveInvalidationPaths("/books/demo/write-next")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
    expect(deriveInvalidationPaths("/books/demo/chapters/3/approve")).toEqual([
      "/api/v1/books",
      "/api/v1/books/demo",
    ]);
  });

  it("refreshes daemon state after daemon mutations", () => {
    expect(deriveInvalidationPaths("/daemon/start")).toEqual(["/api/v1/daemon"]);
    expect(deriveInvalidationPaths("/daemon/stop")).toEqual(["/api/v1/daemon"]);
  });

  it("refreshes project data after project mutations", () => {
    expect(deriveInvalidationPaths("/project")).toEqual(["/api/v1/project"]);
    expect(deriveInvalidationPaths("/project/language")).toEqual(["/api/v1/project", "/api/v1/project/language"]);
  });
});
