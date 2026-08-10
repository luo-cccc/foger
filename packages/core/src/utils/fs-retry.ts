import { rename } from "node:fs/promises";

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);

export interface RenamePathWithRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly renamePath?: (source: string, destination: string) => Promise<void>;
  readonly wait?: (delayMs: number) => Promise<void>;
}

export async function renamePathWithRetry(
  source: string,
  destination: string,
  options: RenamePathWithRetryOptions = {},
): Promise<void> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 50));
  const renamePath = options.renamePath ?? rename;
  const wait = options.wait ?? ((delayMs: number) => (
    new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  ));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await renamePath(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt === maxAttempts) {
        throw error;
      }
      await wait(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
}
