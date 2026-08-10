import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { renamePathWithRetry } from "./fs-retry.js";

export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  encodingOrOptions?: BufferEncoding | { readonly encoding?: BufferEncoding; readonly mode?: number },
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const options = typeof encodingOrOptions === "string"
    ? { encoding: encodingOrOptions }
    : encodingOrOptions ?? {};

  try {
    if (typeof data === "string") {
      await writeFile(tempPath, data, {
        encoding: options.encoding ?? "utf-8",
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      });
    } else {
      await writeFile(tempPath, data, options.mode === undefined ? undefined : { mode: options.mode });
    }
    await renamePathWithRetry(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  options?: { readonly mode?: number },
): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    ...(options?.mode === undefined ? {} : { mode: options.mode }),
  });
}
