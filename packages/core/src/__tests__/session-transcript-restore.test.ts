import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTranscriptEvent } from "../interaction/session-transcript.js";
import { deriveBookSessionFromTranscript } from "../interaction/session-transcript-restore.js";
import type { MessageEvent } from "../interaction/session-transcript-schema.js";

describe("session transcript restore", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-restore-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("restores a direct terminal tool call as a standalone assistant card", async () => {
    await appendTranscriptEvent(projectRoot, {
      type: "session_created",
      version: 1,
      sessionId: "s1",
      seq: 1,
      timestamp: 1,
      bookId: "book-a",
      sessionKind: "book",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await appendTranscriptEvent(projectRoot, {
      type: "request_started",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      sessionKind: "book",
      seq: 2,
      timestamp: 2,
      input: "读取设定",
    });
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "u1",
      parentUuid: null,
      seq: 3,
      role: "user",
      timestamp: 3,
      message: { role: "user", content: "读取设定", timestamp: 3 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a1",
      parentUuid: "u1",
      seq: 4,
      role: "assistant",
      timestamp: 4,
      toolCallId: "read-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "读取当前设定" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "story/story_bible.md" } },
        ],
        timestamp: 4,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "t1",
      parentUuid: "a1",
      seq: 5,
      role: "toolResult",
      timestamp: 5,
      toolCallId: "read-1",
      sourceToolAssistantUuid: "a1",
      message: {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "设定内容" }],
        details: { path: "story/story_bible.md" },
        isError: false,
        timestamp: 5,
      },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "message",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      uuid: "a2",
      parentUuid: "t1",
      seq: 6,
      role: "assistant",
      timestamp: 6,
      message: { role: "assistant", content: [], timestamp: 6 },
    } as MessageEvent);
    await appendTranscriptEvent(projectRoot, {
      type: "request_committed",
      version: 1,
      sessionId: "s1",
      requestId: "r1",
      seq: 7,
      timestamp: 7,
    });

    const session = await deriveBookSessionFromTranscript(projectRoot, "s1");

    expect(session?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "读取设定" }),
      expect.objectContaining({
        role: "assistant",
        content: "",
        thinking: "读取当前设定",
        toolExecutions: [expect.objectContaining({
          id: "read-1",
          tool: "read",
          label: "读取文件",
          args: { path: "story/story_bible.md" },
          details: { path: "story/story_bible.md" },
          status: "completed",
        })],
      }),
    ]);
  });
});
