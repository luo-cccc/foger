import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComposerAgent, type CompressibleContextCompileRequest } from "../agents/composer.js";
import { createLLMClient } from "../llm/provider.js";
import {
  createContextCompilationCache,
  fingerprintContextCompilationKey,
} from "../utils/context-compilation-cache.js";

describe("context compilation cache", () => {
  const previousStub = process.env.INKOS_AGENT_LLM_STUB;

  afterEach(() => {
    if (previousStub === undefined) delete process.env.INKOS_AGENT_LLM_STUB;
    else process.env.INKOS_AGENT_LLM_STUB = previousStub;
  });

  it("tracks hits and misses without exposing source content in keys", () => {
    const cache = createContextCompilationCache();
    const key = fingerprintContextCompilationKey(["book", "foundation text"]);

    expect(cache.get(key)).toBeUndefined();
    cache.set(key, "compiled foundation");
    expect(cache.get(key)).toBe("compiled foundation");
    expect(key).not.toContain("foundation text");
    expect(cache.stats()).toEqual({ entries: 1, hits: 1, misses: 1, writes: 1 });
  });

  it("evicts the least recently used entry when full", () => {
    const cache = createContextCompilationCache(1);
    cache.set("first", "one");
    cache.set("second", "two");

    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")).toBe("two");
    expect(cache.stats().entries).toBe(1);
  });

  it("reuses stable context compilation while keeping chapter context dynamic", async () => {
    process.env.INKOS_AGENT_LLM_STUB = "1";
    const cache = createContextCompilationCache();
    const composer = new ComposerAgent({
      client: createLLMClient({
        provider: "openai",
        service: "custom",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test-key",
        model: "test-model",
        configSource: "env",
        temperature: 0.7,
        thinkingBudget: 0,
        apiFormat: "chat",
        stream: false,
      }),
      model: "test-model",
      projectRoot: "/tmp/inkos-cache-test",
      bookId: "cache-book",
    });
    const request = (chapterNumber: number): CompressibleContextCompileRequest => ({
      chapterNumber,
      goal: "Continue the investigation.",
      language: "zh",
      maxInputTokens: 900,
      protectedEntries: [],
      semanticEntries: [{
        source: "story/story_bible.md#world-rules",
        reason: "Stable canon",
        excerpt: "The jade seal cannot be destroyed.",
      }],
      compressibleEntries: [{
        source: "story/chapter_summaries.md#recent_titles",
        reason: "Recent title history",
        excerpt: `Chapter ${chapterNumber} title`,
      }],
    });

    await composer.compileCompressibleContext(request(1), cache);
    await composer.compileCompressibleContext(request(2), cache);

    expect(cache.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1, writes: 1 });
  });

  it("loads persisted entries across cache instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-context-cache-"));
    const persistencePath = join(root, "runtime", "context-compilation-cache.json");
    try {
      const first = createContextCompilationCache(4, persistencePath);
      first.set("stable-key", "compiled value");

      const second = createContextCompilationCache(4, persistencePath);
      expect(second.get("stable-key")).toBe("compiled value");
      expect(second.stats()).toMatchObject({ hits: 1, misses: 0, writes: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a corrupted persisted cache and can recover by writing a new entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-context-cache-"));
    const persistencePath = join(root, "context-compilation-cache.json");
    try {
      await writeFile(persistencePath, "{not-json", "utf8");
      const cache = createContextCompilationCache(4, persistencePath);

      expect(cache.get("missing")).toBeUndefined();
      cache.set("recovered", "value");
      const persisted = JSON.parse(await readFile(persistencePath, "utf8")) as Record<string, unknown>;
      expect(persisted).toHaveProperty("recovered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes persisted contents when cleared", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-context-cache-"));
    const persistencePath = join(root, "context-compilation-cache.json");
    try {
      const cache = createContextCompilationCache(4, persistencePath);
      cache.set("stable-key", "compiled value");
      expect(existsSync(persistencePath)).toBe(true);

      cache.clear();

      expect(existsSync(persistencePath)).toBe(false);
      expect(cache.get("stable-key")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
