#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = process.cwd();
const DIST_DIR = resolve(ROOT, "packages/studio/dist");
const INDEX_HTML = resolve(DIST_DIR, "index.html");

const DEFAULT_LIMITS = {
  entryJsBytes: 600 * 1024,
  entryCssBytes: 150 * 1024,
  maxJsChunkBytes: 700 * 1024,
};

function parseByteLimit(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive byte count; received ${raw}`);
  }
  return Math.round(parsed);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const limits = {
  entryJsBytes: parseByteLimit("INKOS_STUDIO_ENTRY_JS_LIMIT_BYTES", DEFAULT_LIMITS.entryJsBytes),
  entryCssBytes: parseByteLimit("INKOS_STUDIO_ENTRY_CSS_LIMIT_BYTES", DEFAULT_LIMITS.entryCssBytes),
  maxJsChunkBytes: parseByteLimit("INKOS_STUDIO_MAX_JS_CHUNK_LIMIT_BYTES", DEFAULT_LIMITS.maxJsChunkBytes),
};

let html;
try {
  html = await readFile(INDEX_HTML, "utf-8");
} catch {
  fail("Studio dist is missing. Run `pnpm --filter @actalk/inkos-studio build` first.");
  process.exit();
}

const entryJs = [...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/g)].map((match) => match[1]);
const entryCss = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g)].map((match) => match[1]);

if (entryJs.length === 0) fail("No Studio entry JavaScript asset found in dist/index.html.");
if (entryCss.length === 0) fail("No Studio entry CSS asset found in dist/index.html.");

async function checkAsset(assetPath, limitBytes, label) {
  const normalized = assetPath.replace(/^\//, "");
  const asset = resolve(DIST_DIR, normalized);
  const { size } = await stat(asset);
  const ok = size <= limitBytes;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${normalized} ${formatBytes(size)} / ${formatBytes(limitBytes)}`);
  if (!ok) {
    fail(`${label} exceeds the configured budget.`);
  }
}

for (const asset of entryJs) {
  await checkAsset(asset, limits.entryJsBytes, "Studio entry JS");
}
for (const asset of entryCss) {
  await checkAsset(asset, limits.entryCssBytes, "Studio entry CSS");
}

const assetNames = await readdir(resolve(DIST_DIR, "assets"));
const jsChunks = await Promise.all(assetNames.filter((name) => name.endsWith(".js")).map(async (name) => ({
  name,
  size: (await stat(resolve(DIST_DIR, "assets", name))).size,
})));
const oversizedChunks = jsChunks.filter(({ size }) => size > limits.maxJsChunkBytes);
const largestChunk = jsChunks.toSorted((left, right) => right.size - left.size)[0];
if (largestChunk) {
  console.log(
    `${oversizedChunks.length === 0 ? "PASS" : "FAIL"} largest Studio JS chunk: `
    + `assets/${largestChunk.name} ${formatBytes(largestChunk.size)} / ${formatBytes(limits.maxJsChunkBytes)}`,
  );
}
for (const chunk of oversizedChunks) {
  fail(`Studio JS chunk exceeds the configured budget: assets/${chunk.name} ${formatBytes(chunk.size)}`);
}
