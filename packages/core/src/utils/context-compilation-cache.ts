import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ContextCompilationCacheStats {
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
}

export interface ContextCompilationCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  clear(): void;
  stats(): ContextCompilationCacheStats;
}

interface CacheEntry {
  readonly value: string;
  lastUsedAt: number;
}

export function createContextCompilationCache(
  maxEntries = 32,
  persistencePath?: string,
): ContextCompilationCache {
  const entries = new Map<string, CacheEntry>();
  let hits = 0;
  let misses = 0;
  let writes = 0;

  if (persistencePath) {
    try {
      const persisted = JSON.parse(readFileSync(persistencePath, "utf8")) as Record<string, CacheEntry>;
      for (const [key, entry] of Object.entries(persisted)) {
        if (entry && typeof entry.value === "string" && Number.isFinite(entry.lastUsedAt)) {
          entries.set(key, { value: entry.value, lastUsedAt: entry.lastUsedAt });
        }
      }
    } catch {
      // A stale or partial cache is disposable; recompute on miss.
    }
  }

  const persist = (): void => {
    if (!persistencePath) return;
    try {
      mkdirSync(dirname(persistencePath), { recursive: true });
      const tempPath = `${persistencePath}.${process.pid}.tmp`;
      writeFileSync(tempPath, JSON.stringify(Object.fromEntries(entries)), "utf8");
      renameSync(tempPath, persistencePath);
    } catch {
      // Cache persistence must never block chapter generation.
    }
  };

  return {
    get(key): string | undefined {
      const entry = entries.get(key);
      if (!entry) {
        misses += 1;
        return undefined;
      }
      entry.lastUsedAt = Date.now();
      hits += 1;
      return entry.value;
    },
    set(key, value): void {
      if (!value.trim()) return;
      entries.set(key, { value, lastUsedAt: Date.now() });
      writes += 1;
      persist();

      if (entries.size <= Math.max(1, maxEntries)) return;
      const oldest = [...entries.entries()]
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (oldest) entries.delete(oldest[0]);
      persist();
    },
    clear(): void {
      entries.clear();
      hits = 0;
      misses = 0;
      writes = 0;
      if (persistencePath && existsSync(persistencePath)) {
        try { unlinkSync(persistencePath); } catch { /* disposable */ }
      }
    },
    stats(): ContextCompilationCacheStats {
      return { entries: entries.size, hits, misses, writes };
    },
  };
}

export function fingerprintContextCompilationKey(parts: ReadonlyArray<string>): string {
  return createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex").slice(0, 24);
}
