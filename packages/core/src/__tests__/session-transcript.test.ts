import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTranscriptEvents,
  readTranscriptEvents,
  transcriptPath,
} from "../interaction/session-transcript.js";

describe("session transcript persistence", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-transcript-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serializes concurrent appends with monotonic sequence numbers", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      appendTranscriptEvents(root, "session-1", ({ nextSeq }) => [{
        type: "request_started",
        version: 1,
        sessionId: "session-1",
        requestId: `request-${index}`,
        seq: nextSeq,
        timestamp: index,
        input: `message-${index}`,
      }]),
    ));

    const events = await readTranscriptEvents(root, "session-1");
    expect(events).toHaveLength(20);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("rejects unsafe ids before resolving a transcript path", () => {
    expect(() => transcriptPath(root, "../secrets")).toThrow("Invalid sessionId");
  });
});
