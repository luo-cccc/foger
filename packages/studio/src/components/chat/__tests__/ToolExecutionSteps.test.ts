import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolExecution } from "../../../store/chat/types";
import { PipelineResultDetails, ToolExecutionSteps, UtilityExecutionRow, getProposedActionDetails, groupToolExecutionsChronologically } from "../ToolExecutionSteps";
import { usePreferencesStore } from "../../../store/preferences";
import { setAppLanguage } from "../../../lib/app-language";

const makeExec = (overrides: Partial<ToolExecution> & { id: string; tool: string }): ToolExecution => ({
  label: "test",
  status: "completed",
  startedAt: Date.now(),
  ...overrides,
});

describe("groupChronologically", () => {
  it("keeps read before pipeline when read happened first", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "sub_agent", agent: "writer", label: "写作" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe("utilities");
    expect(groups[1].type).toBe("pipeline");
  });

  it("groups consecutive utility tools together", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "grep", label: "搜索" }),
      makeExec({ id: "3", tool: "read", label: "读取文件" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("utilities");
    if (groups[0].type === "utilities") {
      expect(groups[0].execs).toHaveLength(3);
    }
  });

  it("interleaves utility groups around pipeline ops", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "sub_agent", agent: "writer", label: "写作" }),
      makeExec({ id: "3", tool: "read", label: "读取文件" }),
      makeExec({ id: "4", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("utilities");
    expect(groups[1].type).toBe("pipeline");
    expect(groups[2].type).toBe("utilities");
    if (groups[2].type === "utilities") {
      expect(groups[2].execs).toHaveLength(2);
    }
  });

  it("handles pipeline-only executions", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "sub_agent", agent: "writer", label: "写作" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("pipeline");
  });

  it("handles empty array", () => {
    expect(groupToolExecutionsChronologically([])).toHaveLength(0);
  });

  it("renders proposed actions as visible pipeline cards", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "propose_action", label: "确认动作" }),
      makeExec({ id: "3", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("propose_action");
  });

  it("renders context compression as a visible pipeline card", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "context_compression", label: "整理会话记忆" }),
      makeExec({ id: "3", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("context_compression");
  });

  it("renders generic pipeline result text in an expandable details block", () => {
    const exec = makeExec({
      id: "writer-1",
      tool: "sub_agent",
      agent: "writer",
      label: "写下一章",
      result: "已完成第 1 章：雨棚。这里是更详细的操作结果。",
    });

    const html = renderToStaticMarkup(React.createElement(ToolExecutionSteps, { executions: [exec] }));

    expect(html).toContain("查看操作结果");
    expect(html).toContain("已完成第 1 章：雨棚");
  });

  it("extracts proposed action details", () => {
    const exec = makeExec({
      id: "proposal-1",
      tool: "propose_action",
      label: "确认动作",
      details: {
        kind: "proposed_action",
        action: "create_book",
        targetSessionKind: "book-create",
        sameSession: true,
        title: "创建长篇",
        summary: "确认后进入长篇创建流程。",
        instruction: "创建一本债务悬疑长篇",
        actionPayload: {
          createBook: {
            title: "债务悬疑",
            genre: "悬疑",
            platform: "qidian",
            language: "zh",
            targetChapters: 120,
            chapterWordCount: 3000,
          },
        },
      },
    });

    expect(getProposedActionDetails(exec)).toMatchObject({
      kind: "proposed_action",
      execId: "proposal-1",
      action: "create_book",
      targetSessionKind: "book-create",
      sameSession: true,
      title: "创建长篇",
      instruction: "创建一本债务悬疑长篇",
      actionPayload: {
        createBook: {
          title: "债务悬疑",
          genre: "悬疑",
          platform: "qidian",
          language: "zh",
          targetChapters: 120,
          chapterWordCount: 3000,
        },
      },
    });
  });

  it("extracts proposed route actions for existing Studio workflows", () => {
    const cases = [
      { action: "import_chapters", route: "import:chapters", title: "导入章节" },
      { action: "import_canon", route: "import:canon", title: "导入设定集" },
    ] as const;

    for (const item of cases) {
      const exec = makeExec({
        id: `proposal-route-${item.action}`,
        tool: "propose_action",
        label: "确认动作",
        details: {
          kind: "proposed_action",
          action: item.action,
          targetSessionKind: "chat",
          targetRoute: item.route,
          title: item.title,
          summary: "确认后打开对应工具入口。",
          instruction: "打开对应工具，等待用户补充材料。",
        },
      });

      expect(getProposedActionDetails(exec)).toMatchObject({
        kind: "proposed_action",
        execId: `proposal-route-${item.action}`,
        action: item.action,
        targetSessionKind: "chat",
        targetRoute: item.route,
        title: item.title,
        instruction: "打开对应工具，等待用户补充材料。",
      });
    }
  });

  it("ignores invalid proposed target routes", () => {
    const exec = makeExec({
      id: "proposal-bad-route",
      tool: "propose_action",
      label: "确认动作",
      details: {
        kind: "proposed_action",
        action: "create_book",
        targetSessionKind: "chat",
        targetRoute: "https://example.com",
        instruction: "打开长篇创建入口。",
      },
    });

    expect(getProposedActionDetails(exec)).toMatchObject({
      action: "create_book",
      targetRoute: undefined,
    });
  });
});

describe("tool details default-open preference", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ toolDetailsDefaultOpen: true });
  });

  it("the preferences store defaults to expanded, keeping today's behavior", () => {
    expect(usePreferencesStore.getState().toolDetailsDefaultOpen).toBe(true);
  });

  it("renders the pipeline result details expanded when the preference is on (default)", () => {
    const exec = makeExec({
      id: "writer-1",
      tool: "sub_agent",
      agent: "writer",
      label: "写下一章",
      result: "已完成第 1 章：雨棚。这里是更详细的操作结果。",
    });

    const html = renderToStaticMarkup(React.createElement(ToolExecutionSteps, { executions: [exec] }));

    expect(html).toContain("查看操作结果");
    expect(html).toContain("<details open");
  });

  it("renders the pipeline result details collapsed when the preference is off", () => {
    const html = renderToStaticMarkup(React.createElement(PipelineResultDetails, {
      result: "已完成第 1 章：雨棚。这里是更详细的操作结果。",
      defaultOpen: false,
    }));

    // The block is still there (manually expandable), just not open by default.
    expect(html).toContain("查看操作结果");
    expect(html).toContain("已完成第 1 章：雨棚");
    expect(html).not.toContain("<details open");
  });

  it("renders the pipeline result details expanded when defaultOpen is true", () => {
    const html = renderToStaticMarkup(React.createElement(PipelineResultDetails, {
      result: "已完成第 1 章：雨棚。",
      defaultOpen: true,
    }));

    expect(html).toContain("<details open");
  });
});

describe("English app language", () => {
  beforeEach(() => {
    setAppLanguage("en");
  });

  afterEach(() => {
    setAppLanguage("zh");
  });

  it("renders pipeline status, result summary, and file-operation group in English", () => {
    const execs: ToolExecution[] = [
      makeExec({
        id: "writer-en-1",
        tool: "sub_agent",
        agent: "writer",
        label: "Write",
        result: "Chapter 1 finished.",
      }),
      makeExec({ id: "read-en-1", tool: "read", label: "Read file", args: { path: "books/demo/chapter-1.md" } }),
    ];

    const html = renderToStaticMarkup(React.createElement(ToolExecutionSteps, { executions: execs }));

    expect(html).toContain("Completed");
    expect(html).toContain("View result");
    expect(html).toContain("1 file operation");
    expect(html).not.toContain("已完成");
    expect(html).not.toContain("查看操作结果");
  });

});

describe("UtilityExecutionRow", () => {
  it("renders an expandable, default-collapsed result body when the execution has a result", () => {
    const exec = makeExec({
      id: "read-1",
      tool: "read",
      label: "读取文件",
      args: { path: "books/demo/chapter-1.md" },
      result: "第一章正文：雨停了，巷口的灯还亮着。",
    });

    const html = renderToStaticMarkup(React.createElement(UtilityExecutionRow, { exec }));

    expect(html).toContain("read books/demo/chapter-1.md");
    expect(html).toContain("第一章正文：雨停了，巷口的灯还亮着。");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
  });

  it("renders a plain row without details when the execution has no result", () => {
    const exec = makeExec({
      id: "ls-1",
      tool: "ls",
      label: "列目录",
      args: { path: "books/demo" },
    });

    const html = renderToStaticMarkup(React.createElement(UtilityExecutionRow, { exec }));

    expect(html).toContain("ls books/demo");
    expect(html).not.toContain("<details");
  });

  it("treats a whitespace-only result as no result", () => {
    const exec = makeExec({
      id: "grep-1",
      tool: "grep",
      label: "搜索",
      args: { pattern: "灯" },
      result: "   \n  ",
    });

    const html = renderToStaticMarkup(React.createElement(UtilityExecutionRow, { exec }));

    expect(html).toContain("grep 灯");
    expect(html).not.toContain("<details");
  });
});
