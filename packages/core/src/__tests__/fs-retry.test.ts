import { describe, expect, it, vi } from "vitest";
import { renamePathWithRetry } from "../utils/fs-retry.js";

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("renamePathWithRetry", () => {
  it("retries transient Windows rename errors with bounded backoff", async () => {
    const renamePath = vi.fn()
      .mockRejectedValueOnce(fsError("EPERM"))
      .mockRejectedValueOnce(fsError("EBUSY"))
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await renamePathWithRetry("staging", "book", {
      baseDelayMs: 10,
      renamePath,
      wait,
    });

    expect(renamePath).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[10], [20]]);
  });

  it("does not retry non-transient rename failures", async () => {
    const error = fsError("ENOENT");
    const renamePath = vi.fn().mockRejectedValue(error);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(renamePathWithRetry("staging", "book", { renamePath, wait }))
      .rejects.toBe(error);
    expect(renamePath).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("rethrows the last transient failure after the attempt limit", async () => {
    const error = fsError("EACCES");
    const renamePath = vi.fn().mockRejectedValue(error);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(renamePathWithRetry("staging", "book", {
      maxAttempts: 3,
      baseDelayMs: 5,
      renamePath,
      wait,
    })).rejects.toBe(error);
    expect(renamePath).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[5], [10]]);
  });
});
