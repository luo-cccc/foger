import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const args = new Set(process.argv.slice(2));
const serverOnly = args.has("--server-only");
const clientOnly = args.has("--client-only");
const e2e = args.has("--e2e");
const watchCore = !clientOnly && !args.has("--no-watch-core");
const workspaceRoot = resolve(process.cwd(), "../..");
const coreRoot = join(workspaceRoot, "packages", "core");
const e2eProjectRoot = e2e ? requiredE2eEnv("INKOS_PROJECT_ROOT") : undefined;
const e2eApiPort = e2e ? requiredE2eEnv("INKOS_STUDIO_PORT") : undefined;
const e2eClientPort = e2e ? requiredE2eEnv("INKOS_STUDIO_CLIENT_PORT") : undefined;

const env = {
  ...process.env,
  ...(e2e ? { INKOS_AGENT_LLM_STUB: "1" } : {}),
  INKOS_STUDIO_PORT: e2eApiPort ?? process.env.INKOS_STUDIO_PORT ?? "4569",
  INKOS_PROJECT_ROOT: e2eProjectRoot ?? process.env.INKOS_PROJECT_ROOT ?? "../..",
};

const clientPort = e2eClientPort ?? process.env.INKOS_STUDIO_CLIENT_PORT ?? "4567";
const bin = (name) => {
  const local = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? `${name}.CMD` : name);
  return existsSync(local) ? local : name;
};
const children = [];
const e2eLogPath = e2e ? requiredE2eEnv("INKOS_E2E_LOG_PATH") : null;
const verboseE2e = process.env.INKOS_E2E_VERBOSE === "1";

if (e2e) {
  logE2e(`[studio-dev] e2e project=${env.INKOS_PROJECT_ROOT} api=${env.INKOS_STUDIO_PORT} client=${clientPort}`);
}

function requiredE2eEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when running Studio with --e2e.`);
  return value;
}

function start(command, args, options = {}) {
  if (e2e) {
    logE2e(`[studio-dev] start ${command} ${args.join(" ")}`);
  }
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
    ...options,
  });
  children.push(child);
  child.on("error", (error) => {
    logE2e(`[studio-dev] error ${command}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
  child.on("exit", (code, signal) => {
    logE2e(`[studio-dev] exit ${command}: code=${code} signal=${signal}`);
    if (shuttingDown) return;
    if (code === 0 || signal) return;
    shutdown(code ?? 1);
  });
  return child;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function rebuildCoreDist() {
  execFileSync(npmCommand(), ["run", "build"], {
    cwd: coreRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 100).unref();
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("exit", () => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
});

if (watchCore && !e2e) {
  // The Studio API server imports @actalk/inkos-core via dist output, so a
  // one-off rebuild plus a watcher keeps local Studio work aligned with core.
  rebuildCoreDist();
  start(npmCommand(), ["run", "dev"], { cwd: coreRoot });
}

if (!clientOnly) {
  start(bin("tsx"), [
    "watch",
    "--clear-screen=false",
    "src/api/index.ts",
  ]);
}

if (!serverOnly) {
  start(bin("vite"), ["--host", "--port", clientPort, ...(e2e ? ["--strictPort"] : [])]);
}

function logE2e(message) {
  if (!e2eLogPath) return;
  const line = `${new Date().toISOString()} ${message}\n`;
  appendFileSync(e2eLogPath, line, "utf-8");
  if (verboseE2e) {
    console.error(message);
  }
}
