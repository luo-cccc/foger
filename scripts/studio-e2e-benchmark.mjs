#!/usr/bin/env node
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

function parseRuns(argv) {
  const index = argv.findIndex((arg) => arg === "--runs" || arg === "-n");
  if (index === -1) return 1;
  const parsed = Number(argv[index + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--runs must be a positive integer");
  }
  return parsed;
}

function formatMs(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal,
        durationMs: performance.now() - started,
      });
    });
  });
}

const runs = parseRuns(process.argv.slice(2));
const samples = [];

for (let run = 1; run <= runs; run += 1) {
  console.log(`\nStudio E2E benchmark run ${run}/${runs}`);
  const result = await runCommand("pnpm", ["--filter", "@actalk/inkos-studio", "test:e2e"]);
  samples.push(result.durationMs);
  console.log(`Run ${run} finished in ${formatMs(result.durationMs)}`);
  if (result.code !== 0) {
    console.error(`Studio E2E benchmark failed on run ${run} with exit code ${result.code}.`);
    process.exit(result.code);
  }
}

const total = samples.reduce((sum, value) => sum + value, 0);
const mean = total / samples.length;
const sorted = [...samples].sort((a, b) => a - b);
const min = sorted[0];
const max = sorted[sorted.length - 1];

console.log("\nStudio E2E benchmark summary");
console.log(`runs: ${runs}`);
console.log(`mean: ${formatMs(mean)}`);
console.log(`min: ${formatMs(min)}`);
console.log(`max: ${formatMs(max)}`);
