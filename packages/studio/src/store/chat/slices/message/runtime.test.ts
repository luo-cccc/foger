import { describe, expect, it } from "vitest";
import type { Message, ToolExecution } from "../../types";
import { createSessionRuntime, deriveResolvedProposals, deserializeMessages, extractErrorMessage, extractToolError, withToolExecutions } from "./runtime";

function exec(overrides: Partial<ToolExecution> & { id: string; tool: string }): ToolExecution {
  const { id, tool, ...rest } = overrides;
  return {
    id,
    tool,
    label: tool,
    status: "completed",
    startedAt: 1,
    ...rest,
  };
}

describe("chat runtime error copy", () => {
  it("localizes known assistant errors", () => {
    expect(extractErrorMessage({
      message: "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
    })).toBe("最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });

  it("localizes known tool errors", () => {
    expect(extractToolError({
      content: [
        {
          type: "text",
          text: "Latest chapter 2 is state-degraded. Repair state or rewrite that chapter before continuing.",
        },
      ],
    })).toBe("最新第 2 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });
});

describe("deriveResolvedProposals", () => {
  it("marks a proposed book creation as confirmed only by an architect sub-agent", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "proposal-1",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "create_book",
              targetSessionKind: "book-create",
              instruction: "建一本债务悬疑",
            },
          }),
          exec({ id: "writer-1", tool: "sub_agent", agent: "writer" }),
          exec({ id: "architect-1", tool: "sub_agent", agent: "architect" }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "proposal-1": "confirmed" });
  });

  it("confirms only one matching proposal per completed production action", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        toolExecutions: [
          exec({
            id: "old-proposal",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "create_book",
              targetSessionKind: "book-create",
              instruction: "建一本悬疑长篇",
            },
          }),
          exec({
            id: "new-proposal",
            tool: "propose_action",
            details: {
              kind: "proposed_action",
              action: "create_book",
              targetSessionKind: "book-create",
              instruction: "建一本都市长篇",
            },
          }),
        ],
      },
      {
        role: "assistant",
        content: "",
        timestamp: 2,
        toolExecutions: [
          exec({ id: "architect-1", tool: "sub_agent", agent: "architect" }),
        ],
      },
    ];

    expect(deriveResolvedProposals(messages)).toEqual({ "new-proposal": "confirmed" });
  });
});

describe("deserializeMessages", () => {
  it("restores tool executions from legacyDisplay for tool-only assistant messages", () => {
    const messages = deserializeMessages([
      {
        role: "assistant",
        content: "",
        timestamp: 1,
        legacyDisplay: {
          toolExecutions: [
            exec({
              id: "import-1",
              tool: "import_chapters",
              details: { kind: "import_chapters_completed", bookId: "night-harbor" },
            }),
          ],
        },
      } as any,
    ]);

    expect(messages[0]?.toolExecutions?.[0]?.tool).toBe("import_chapters");
    expect(messages[0]?.parts?.[0]?.type).toBe("tool");
  });
});

describe("withToolExecutions", () => {
  it("adds returned tool executions before final text content", () => {
    const message = withToolExecutions({
      role: "assistant",
      content: "完成。",
      timestamp: 1,
    }, [
      exec({
        id: "script-1",
        tool: "script_create",
        details: { kind: "script_created" },
      }),
    ]);

    expect(message.toolExecutions?.map((execution) => execution.tool)).toEqual(["script_create"]);
    expect(message.parts?.map((part) => part.type)).toEqual(["tool", "text"]);
    expect(message.content).toBe("完成。");
  });
});
