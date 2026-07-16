import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { renamePathWithRetry } from "./fs-retry.js";

export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  encoding?: BufferEncoding,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    if (typeof data === "string") {
      await writeFile(tempPath, data, encoding ?? "utf-8");
    } else {
      await writeFile(tempPath, data);
    }
    await renamePathWithRetry(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
