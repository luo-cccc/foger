import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";

const rawArgs = process.argv.slice(2);
const linkedLive = consumeFlag(rawArgs, "--linked-live");
const repeatKnownFailure = consumeFlag(rawArgs, "--repeat-known-failure");
const linkedChapters = Math.max(1, positiveInteger(consumeOption(rawArgs, "--linked-chapters"), 1));
const linkedWords = Math.max(1000, positiveInteger(consumeOption(rawArgs, "--linked-words"), 1000));
const linkedMaxTotalTokens = positiveInteger(
  consumeOption(rawArgs, "--linked-max-total-tokens"),
  linkedLive ? 250_000 : 0,
);
const linkedMaxPromptTokensPerCall = positiveInteger(
  consumeOption(rawArgs, "--linked-max-prompt-tokens-per-call"),
  linkedLive ? 16_000 : 0,
);
const linkedQualityPolicy = parseLinkedQualityPolicy(
  consumeOption(rawArgs, "--linked-quality-policy"),
);
const linkedCreateAttempts = Math.max(
  1,
  positiveInteger(consumeOption(rawArgs, "--linked-create-attempts"), linkedLive ? 2 : 1),
);
const linkedRun = linkedLive || rawArgs.some((arg) => arg.includes("@linked"));
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const linkedSourceRoot = resolve(process.env.INKOS_LINKED_SOURCE_ROOT?.trim() || workspaceRoot);
const linkedReportPath = resolve(
  consumeOption(rawArgs, "--linked-report")
    || join(workspaceRoot, ".tmp-linked-acceptance", linkedLive ? "latest-live.json" : "latest-stub.json"),
);
const linkedFingerprint = linkedRun
  ? await buildLinkedFingerprint({
      workspaceRoot,
      sourceRoot: linkedSourceRoot,
      mode: linkedLive ? "live" : "stub",
      chapters: linkedChapters,
      words: linkedWords,
      maxTotalTokens: linkedMaxTotalTokens,
      maxPromptTokensPerCall: linkedMaxPromptTokensPerCall,
      qualityPolicy: linkedQualityPolicy,
      createAttempts: linkedCreateAttempts,
    })
  : "";

if (linkedRun) {
  mkdirSync(resolve(linkedReportPath, ".."), { recursive: true });
}

if (linkedLive && !repeatKnownFailure && existsSync(linkedReportPath)) {
  const previous = readJsonFile(linkedReportPath);
  if (previous?.status === "failed" && previous.runFingerprint === linkedFingerprint) {
    console.error([
      "Linked live acceptance was not started because the previous run failed against the same code and scenario.",
      `Failure signature: ${previous.failureSignature ?? "unknown"}`,
      `Report: ${linkedReportPath}`,
      "Change the code/scenario, or pass --repeat-known-failure when intentionally rechecking a transient provider failure.",
    ].join("\n"));
    process.exit(2);
  }
}

async function findAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate an E2E port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const apiPort = await findAvailablePort();
const clientPort = await findAvailablePort();
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error("Studio E2E must be started through pnpm so the package runtime is available.");
}
cleanupStaleE2ERuntimes();
const runtimeDir = mkdtempSync(join(tmpdir(), "inkos-studio-e2e-runtime-"));
const child = spawn(process.execPath, [pnpmCli, "exec", "playwright", "test", ...rawArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    INKOS_E2E_LLM_MODE: linkedLive ? "live" : "stub",
    INKOS_LINKED_SOURCE_ROOT: linkedSourceRoot,
    INKOS_LINKED_REPORT_PATH: linkedRun ? linkedReportPath : "",
    INKOS_LINKED_RUN_FINGERPRINT: linkedFingerprint,
    INKOS_LINKED_CHAPTERS: String(linkedChapters),
    INKOS_LINKED_WORDS: String(linkedWords),
    INKOS_LINKED_MAX_TOTAL_TOKENS: String(linkedMaxTotalTokens),
    INKOS_LINKED_MAX_PROMPT_TOKENS_PER_CALL: String(linkedMaxPromptTokensPerCall),
    INKOS_LINKED_QUALITY_POLICY: linkedQualityPolicy,
    INKOS_LINKED_CREATE_ATTEMPTS: String(linkedCreateAttempts),
    INKOS_MAX_PROMPT_ESTIMATED_TOKENS_PER_CALL: String(linkedMaxPromptTokensPerCall),
    INKOS_E2E_LAUNCHER_PID: String(process.pid),
    INKOS_STUDIO_PORT: String(apiPort),
    INKOS_STUDIO_CLIENT_PORT: String(clientPort),
    INKOS_E2E_RUNTIME_FILE: join(runtimeDir, "runtime.json"),
    INKOS_E2E_LOG_PATH: join(runtimeDir, "server.log"),
  },
  windowsHide: true,
});

let finalized = false;
child.on("exit", (code, signal) => {
  if (finalized) return;
  finalized = true;
  cleanupOwnedRuntimeArtifacts(runtimeDir, false);
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (finalized) return;
    finalized = true;
    terminateProcess(child.pid);
    cleanupOwnedRuntimeArtifacts(runtimeDir, false);
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

function consumeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function consumeOption(args, name) {
  const equalsIndex = args.findIndex((arg) => arg.startsWith(`${name}=`));
  if (equalsIndex >= 0) {
    const [entry] = args.splice(equalsIndex, 1);
    return entry.slice(name.length + 1);
  }
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, received "${value}".`);
  }
  return parsed;
}

function parseLinkedQualityPolicy(value) {
  const policy = value?.trim() || "strict";
  if (policy !== "strict" && policy !== "report-only") {
    throw new Error(`Expected --linked-quality-policy to be strict or report-only, received "${value}".`);
  }
  return policy;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function cleanupStaleE2ERuntimes() {
  const root = resolve(tmpdir());
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("inkos-studio-e2e-runtime-"));
  for (const entry of entries) {
    try {
      cleanupOwnedRuntimeArtifacts(join(root, entry.name), true);
    } catch {
      // Another launcher or teardown may have removed it concurrently.
    }
  }
}

function cleanupOwnedRuntimeArtifacts(runtimeDir, staleOnly) {
  if (!isOwnedTempDirectory(runtimeDir, "inkos-studio-e2e-runtime-")) return;
  if (!existsSync(runtimeDir)) return;
  const runtimePath = join(runtimeDir, "runtime.json");
  if (!existsSync(runtimePath)) {
    const ageMs = Date.now() - statSync(runtimeDir).mtimeMs;
    if (staleOnly && ageMs < 60 * 60_000) return;
    rmSync(runtimeDir, { recursive: true, force: true });
    return;
  }

  const runtime = readJsonFile(runtimePath) ?? {};
  const hasLauncherPid = Number.isSafeInteger(runtime.launcherPid) && runtime.launcherPid > 0;
  const launcherAlive = isProcessAlive(runtime.launcherPid);
  const serverAlive = isProcessAlive(runtime.pid);
  if (staleOnly && launcherAlive) return;
  if (staleOnly && !hasLauncherPid && serverAlive) return;
  if (serverAlive) terminateProcess(runtime.pid);
  if (typeof runtime.projectRoot === "string" && isOwnedTempDirectory(runtime.projectRoot, "inkos-studio-e2e-")) {
    rmSync(runtime.projectRoot, { recursive: true, force: true });
  }
  rmSync(runtimeDir, { recursive: true, force: true });
}

function isOwnedTempDirectory(candidate, prefix) {
  const resolved = resolve(candidate);
  return dirname(resolved) === resolve(tmpdir())
    && Boolean(resolved.split(/[\\/]/).at(-1)?.startsWith(prefix));
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Already stopped.
  }
}

async function buildLinkedFingerprint(options) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    mode: options.mode,
    chapters: options.chapters,
    words: options.words,
    maxTotalTokens: options.maxTotalTokens,
    maxPromptTokensPerCall: options.maxPromptTokensPerCall,
    qualityPolicy: options.qualityPolicy,
    createAttempts: options.createAttempts,
  }));

  const roots = [
    join(options.workspaceRoot, "packages", "core", "src"),
    join(options.workspaceRoot, "packages", "studio", "src"),
    join(options.workspaceRoot, "packages", "studio", "e2e", "linked-authoring.spec.ts"),
    join(options.workspaceRoot, "packages", "studio", "e2e", "global-setup.ts"),
    join(options.workspaceRoot, "packages", "studio", "scripts", "run-e2e.mjs"),
    join(options.sourceRoot, "inkos.json"),
  ];

  for (const root of roots) {
    await hashPath(hash, root, options.workspaceRoot);
  }
  return hash.digest("hex");
}

async function hashPath(hash, path, base) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (entries) {
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await hashPath(hash, join(path, entry.name), base);
    }
    return;
  }

  if (!existsSync(path)) return;
  const extension = extname(path);
  if (extension && ![".ts", ".tsx", ".mjs", ".json"].includes(extension)) return;
  hash.update(relative(base, path).replace(/\\/g, "/"));
  hash.update(await readFile(path));
}
