import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-write.js";

const PROJECT_CONFIG_LOCK = ".inkos-project-config.lock";
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

export async function mutateProjectConfig<T>(
  projectRoot: string,
  mutator: (config: Record<string, unknown>) => Promise<T> | T,
): Promise<T> {
  const release = await acquireProjectConfigLock(projectRoot);
  try {
    const configPath = join(projectRoot, "inkos.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const result = await mutator(config);
    await atomicWriteJson(configPath, config);
    return result;
  } finally {
    await release();
  }
}

export async function initializeProjectConfig(
  projectRoot: string,
  config: Record<string, unknown>,
): Promise<void> {
  const release = await acquireProjectConfigLock(projectRoot);
  try {
    const configPath = join(projectRoot, "inkos.json");
    try {
      await readFile(configPath, "utf-8");
      throw new Error(`inkos.json already exists in ${projectRoot}. Use a different directory or delete the existing project.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
    await atomicWriteJson(configPath, config);
  } finally {
    await release();
  }
}

async function acquireProjectConfigLock(projectRoot: string): Promise<() => Promise<void>> {
  await mkdir(projectRoot, { recursive: true });
  const lockPath = join(projectRoot, PROJECT_CONFIG_LOCK);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`pid:${process.pid} ts:${Date.now()}`, "utf-8");
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
      const lockData = await readFile(lockPath, "utf-8").catch(() => "");
      const pid = extractPid(lockData);
      if (pid !== undefined && !isProcessAlive(pid)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Project config is locked by another process (${lockData || "unknown owner"})`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}

function extractPid(lockData: string): number | undefined {
  const match = lockData.match(/pid:(\d+)/);
  if (!match?.[1]) return undefined;
  const pid = Number.parseInt(match[1], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}
