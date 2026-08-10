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
const e2eLlmMode = e2e ? (process.env.INKOS_E2E_LLM_MODE?.trim() || "stub") : undefined;

if (e2e && e2eLlmMode !== "stub" && e2eLlmMode !== "live") {
  throw new Error(`Unsupported INKOS_E2E_LLM_MODE: ${e2eLlmMode}`);
}

const env = {
  ...process.env,
  ...(e2e ? {
    INKOS_AGENT_LLM_STUB: e2eLlmMode === "live" ? "" : "1",
    INKOS_AGENT_LLM_STUB_DELAY_MS: process.env.INKOS_AGENT_LLM_STUB_DELAY_MS ?? "150",
  } : {}),
  INKOS_STUDIO_PORT: resolvePort(e2eApiPort ?? process.env.INKOS_STUDIO_PORT ?? "4569", "INKOS_STUDIO_PORT"),
  INKOS_PROJECT_ROOT: e2eProjectRoot ?? process.env.INKOS_PROJECT_ROOT ?? "../..",
};

const clientPort = resolvePort(
  e2eClientPort ?? process.env.INKOS_STUDIO_CLIENT_PORT ?? "4567",
  "INKOS_STUDIO_CLIENT_PORT",
);
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

function resolvePort(value, name) {
  const raw = String(value).trim();
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port, received "${value}".`);
  }
  return String(port);
}

function commandInvocation(command, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args],
  };
}

function start(command, args, options = {}) {
  if (e2e) {
    logE2e(`[studio-dev] start ${command} ${args.join(" ")}`);
  }
  const invocation = commandInvocation(command, args);
  const child = spawn(invocation.command, invocation.args, {
    stdio: "inherit",
    env,
    ...options,
  });
  children.push(child);
  child.on("error", (error) => {
    logE2e(`[studio-dev] error ${command}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
  child.on("exit", (code, signal) => {
    logE2e(`[studio-dev] exit ${command}: code=${code} signal=${signal}`);
    if (shuttingDown) return;
    shutdown(code ?? (signal ? 1 : 0));
  });
  return child;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function rebuildCoreDist() {
  const invocation = commandInvocation(npmCommand(), ["run", "build"]);
  execFileSync(invocation.command, invocation.args, {
    cwd: coreRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
}

let shuttingDown = false;
function terminateChildTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // The process may have exited between the status check and taskkill.
    }
    return;
  }
  child.kill("SIGTERM");
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    terminateChildTree(child);
  }
  setTimeout(() => process.exit(code), 100).unref();
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.on("exit", () => {
  for (const child of children) {
    terminateChildTree(child);
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
  start(bin("vite"), ["--host", "--port", clientPort, "--strictPort"]);
}

function logE2e(message) {
  if (!e2eLogPath) return;
  const line = `${new Date().toISOString()} ${message}\n`;
  appendFileSync(e2eLogPath, line, "utf-8");
  if (verboseE2e) {
    console.error(message);
  }
}
