import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export default function globalTeardown(): void {
  const runtimePath = process.env.INKOS_E2E_RUNTIME_FILE?.trim();
  if (!runtimePath || !existsSync(runtimePath)) return;

  const runtime = readRuntime(readFileSync(runtimePath, "utf-8"));
  const pid = runtime.pid;
  if (Number.isFinite(pid) && pid > 0) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid);
      }
    } catch {
      // Already stopped.
    }
  }
  rmSync(runtimePath, { force: true });
  if (runtime.projectRoot && isOwnedE2eProject(runtime.projectRoot)) {
    rmSync(runtime.projectRoot, { recursive: true, force: true });
  }
  if (isOwnedRuntimeDirectory(path.dirname(runtimePath))) {
    rmSync(path.dirname(runtimePath), { recursive: true, force: true });
  }
}

function readRuntime(raw: string): { pid: number; projectRoot?: string } {
  try {
    const value = JSON.parse(raw) as { pid?: unknown; projectRoot?: unknown };
    return {
      pid: typeof value.pid === "number" ? value.pid : Number.NaN,
      projectRoot: typeof value.projectRoot === "string" ? value.projectRoot : undefined,
    };
  } catch {
    return { pid: Number(raw.trim()) };
  }
}

function isOwnedE2eProject(projectRoot: string): boolean {
  const parent = path.resolve(tmpdir());
  const candidate = path.resolve(projectRoot);
  return path.dirname(candidate) === parent && path.basename(candidate).startsWith("inkos-studio-e2e-");
}

function isOwnedRuntimeDirectory(runtimeDir: string): boolean {
  const parent = path.resolve(tmpdir());
  const candidate = path.resolve(runtimeDir);
  return path.dirname(candidate) === parent && path.basename(candidate).startsWith("inkos-studio-e2e-runtime-");
}
