import type { MessagePart, ToolExecution, PipelineStage, ToolLLMCall } from "./types";
import { localizeKnownRuntimeMessage } from "../../lib/error-copy";
import { tr } from "../../lib/app-language";

// -- Event types for the builder --

export type StreamEvent =
  | { type: "thinking:start" }
  | { type: "thinking:delta"; text: string }
  | { type: "thinking:end" }
  | { type: "draft:delta"; text: string }
  | { type: "tool:start"; id: string; tool: string; agent?: string; stages?: string[] }
  | { type: "tool:end"; id: string; isError?: boolean; result?: unknown; details?: unknown }
  | { type: "log:stage"; stageName: string }
  | { type: "llm:progress"; status: string; elapsedMs: number; totalChars: number; chineseChars: number }
  | LLMTelemetryStreamEvent
  | ContextCompressionStreamEvent;

export interface LLMTelemetryStreamEvent {
  readonly type: "llm:telemetry";
  readonly agent: string;
  readonly phase: string;
  readonly status: "success" | "timeout" | "error" | "partial";
  readonly service: string;
  readonly model: string;
  readonly durationMs: number;
  readonly timeoutMs?: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly failureKind?: "provider-content-policy";
  readonly route?: "content-policy-fallback";
  readonly fallbackFrom?: ToolLLMCall["fallbackFrom"];
  readonly partialContentLength?: number;
  readonly errorMessage?: string;
}

export type ContextCompressionCategory = "session_context" | "story_context";
export type ContextCompressionPhase = "start" | "end" | "error";

export interface ContextCompressionStreamEvent {
  readonly type: "context:compression";
  readonly category: ContextCompressionCategory;
  readonly phase: ContextCompressionPhase;
  readonly message?: string;
  readonly protectedTokens?: number;
  readonly compressibleTokens?: number;
  readonly budgetTokens?: number;
  readonly sources?: readonly string[];
}

// -- Label helpers --

// [zh, en] tuples resolved through tr() at call time so labels follow the
// current app language instead of the language active at module load.
const AGENT_LABELS: Record<string, readonly [string, string]> = {
  architect: ["建书", "Create book"], writer: ["写作", "Write"], auditor: ["审计", "Audit"],
  reviser: ["修订", "Revise"], exporter: ["导出", "Export"],
};
const TOOL_LABELS: Record<string, readonly [string, string]> = {
  read: ["读取文件", "Read file"], edit: ["编辑文件", "Edit file"], grep: ["搜索", "Search"], ls: ["列目录", "List directory"],
  context_compression: ["整理上下文", "Organize context"],
  propose_action: ["确认动作", "Confirm action"],
};

function resolveToolLabel(tool: string, agent?: string): string {
  if (tool === "sub_agent" && agent) {
    const label = AGENT_LABELS[agent];
    return label ? tr(label[0], label[1]) : agent;
  }
  if (tool === "llm_call") {
    return tr("LLM 调用", "LLM call");
  }
  const label = TOOL_LABELS[tool];
  return label ? tr(label[0], label[1]) : tool;
}

function summarizeToolResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 2000);
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.content === "string") return record.content.slice(0, 2000);
    if (Array.isArray(record.content)) {
      const text = record.content
        .map((part) => {
          const item = part as { type?: unknown; text?: unknown };
          return item.type === "text" && typeof item.text === "string" ? item.text : "";
        })
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text.slice(0, 2000);
    }
  }
  return String(result ?? "").slice(0, 2000);
}

function compressionLabel(category: ContextCompressionCategory): string {
  return category === "session_context"
    ? tr("整理会话记忆", "Organize session memory")
    : tr("压缩故事上下文", "Compress story context");
}

function compressionSourceSummary(sources: readonly string[] | undefined): string {
  if (!sources || sources.length === 0) return "";
  const preview = sources.slice(0, 3).join(", ");
  const suffix = sources.length > 3 ? ` +${sources.length - 3}` : "";
  return `${tr("来源", "sources")} ${sources.length}: ${preview}${suffix}`;
}

function compressionProgress(event: ContextCompressionStreamEvent): PipelineStage["progress"] | undefined {
  if (event.phase !== "start") return undefined;
  const parts = [
    event.protectedTokens !== undefined ? `${tr("保护", "protected")} ${event.protectedTokens}` : "",
    event.compressibleTokens !== undefined ? `${tr("可压缩", "compressible")} ${event.compressibleTokens}` : "",
    event.budgetTokens !== undefined ? `${tr("预算", "budget")} ${event.budgetTokens}` : "",
    compressionSourceSummary(event.sources),
  ].filter(Boolean);
  return {
    status: parts.length > 0 ? parts.join(" · ") : "compressing",
    elapsedMs: 0,
    totalChars: 0,
    chineseChars: 0,
  };
}

function upsertCompressionStage(stages: PipelineStage[] | undefined, event: ContextCompressionStreamEvent): PipelineStage[] {
  const label = compressionLabel(event.category);
  const nextStatus: PipelineStage["status"] = event.phase === "start" ? "active" : "completed";
  const found = stages?.some((stage) => stage.label === label) ?? false;
  const base = found ? [...(stages ?? [])] : [...(stages ?? []), { label, status: "pending" as const }];
  return base.map((stage) =>
    stage.label === label
      ? {
          ...stage,
          status: nextStatus,
          progress: event.phase === "start" ? compressionProgress(event) : undefined,
        }
      : stage
  );
}

function applyContextCompressionEvent(parts: MessagePart[], event: ContextCompressionStreamEvent): void {
  const shouldUseStandaloneCard = event.category === "session_context";
  const runningTool = shouldUseStandaloneCard ? undefined : findLastRunningTool(parts);
  if (runningTool) {
    runningTool.stages = upsertCompressionStage(runningTool.stages, event);
    if (event.phase === "error") {
      runningTool.status = "error";
      runningTool.error = event.message ?? `${compressionLabel(event.category)}${tr("失败", " failed")}`;
    }
    return;
  }

  const id = `context-${event.category}`;
  const existing = parts.find((part): part is { type: "tool"; execution: ToolExecution } =>
    part.type === "tool" && part.execution.id === id
  );
  const status: ToolExecution["status"] = event.phase === "start" ? "running" : event.phase === "error" ? "error" : "completed";
  const execution: ToolExecution = existing?.execution ?? {
    id,
    tool: "context_compression",
    label: compressionLabel(event.category),
    status,
    startedAt: Date.now(),
    stages: [],
  };
  execution.status = status;
  execution.label = compressionLabel(event.category);
  execution.stages = upsertCompressionStage(execution.stages, event);
  if (event.phase !== "start") execution.completedAt = Date.now();
  if (event.phase === "error") execution.error = event.message ?? `${compressionLabel(event.category)}${tr("失败", " failed")}`;
  if (!existing) parts.push({ type: "tool", execution });
}

function findLastRunningTool(parts: MessagePart[]): ToolExecution | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.type === "tool" && p.execution.status === "running") return p.execution;
  }
  return undefined;
}

function appendToolLLMCall(
  existing: ReadonlyArray<ToolLLMCall> | undefined,
  incoming: LLMTelemetryStreamEvent,
): ReadonlyArray<ToolLLMCall> {
  return [
    ...(existing ?? []),
    {
      agent: incoming.agent,
      phase: incoming.phase,
      status: incoming.status,
      service: incoming.service,
      model: incoming.model,
      durationMs: incoming.durationMs,
      ...(incoming.timeoutMs !== undefined ? { timeoutMs: incoming.timeoutMs } : {}),
      promptTokens: incoming.promptTokens,
      completionTokens: incoming.completionTokens,
      totalTokens: incoming.totalTokens,
      ...(incoming.failureKind ? { failureKind: incoming.failureKind } : {}),
      ...(incoming.route ? { route: incoming.route } : {}),
      ...(incoming.fallbackFrom ? { fallbackFrom: incoming.fallbackFrom } : {}),
      ...(incoming.partialContentLength !== undefined ? { partialContentLength: incoming.partialContentLength } : {}),
      ...(incoming.errorMessage ? { errorMessage: incoming.errorMessage } : {}),
    },
  ].slice(-6);
}

function shouldCreateStandaloneLLMCall(event: LLMTelemetryStreamEvent): boolean {
  return event.status !== "success" || event.durationMs >= 15_000;
}

function applyLLMTelemetryEvent(parts: MessagePart[], event: LLMTelemetryStreamEvent): void {
  const runningTool = findLastRunningTool(parts);
  if (runningTool) {
    runningTool.llmCalls = appendToolLLMCall(runningTool.llmCalls, event);
    return;
  }
  if (!shouldCreateStandaloneLLMCall(event)) return;

  const now = Date.now();
  const exec: ToolExecution = {
    id: `llm-${parts.length + 1}-${event.phase}`,
    tool: "llm_call",
    agent: event.agent,
    label: resolveToolLabel("llm_call"),
    status: event.status === "error" || event.status === "timeout" ? "error" : "completed",
    llmCalls: appendToolLLMCall(undefined, event),
    ...(event.errorMessage ? { error: event.errorMessage } : {}),
    startedAt: now - Math.max(0, event.durationMs),
    completedAt: now,
  };
  parts.push({ type: "tool", execution: exec });
}

// -- Builder --

export function buildPartsFromEvents(events: StreamEvent[]): MessagePart[] {
  const parts: MessagePart[] = [];

  /** Find the last tool part that is still "running". */
  function findRunningTool(): ToolExecution | undefined {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.type === "tool" && p.execution.status === "running") return p.execution;
    }
    return undefined;
  }

  for (const event of events) {
    switch (event.type) {
      case "thinking:start": {
        parts.push({ type: "thinking", content: "", streaming: true });
        break;
      }

      case "thinking:delta": {
        // Append to last thinking part
        const last = parts[parts.length - 1];
        if (last?.type === "thinking") {
          last.content += event.text;
        }
        break;
      }

      case "thinking:end": {
        const last = parts[parts.length - 1];
        if (last?.type === "thinking") {
          last.streaming = false;
        }
        break;
      }

      case "draft:delta": {
        // Append to last text part, or create a new one
        const last = parts[parts.length - 1];
        if (last?.type === "text") {
          last.content += event.text;
        } else {
          parts.push({ type: "text", content: event.text });
        }
        break;
      }

      case "tool:start": {
        // For pipeline operations (sub_agent), move trailing text to thinking
        // (it's the agent's reasoning before calling the tool, not user-facing content).
        // For utility tools (read/grep/edit/ls), keep text as-is.
        if (event.tool === "sub_agent") {
          const last = parts[parts.length - 1];
          if (last?.type === "text" && last.content) {
            parts.pop();
            const prevPart = parts[parts.length - 1];
            if (prevPart?.type === "thinking") {
              prevPart.content += (prevPart.content ? "\n\n" : "") + last.content;
            } else {
              parts.push({ type: "thinking", content: last.content, streaming: false });
            }
          }
        }

        const stages: PipelineStage[] | undefined = event.stages?.length
          ? event.stages.map((label) => ({ label, status: "pending" as const }))
          : undefined;

        const exec: ToolExecution = {
          id: event.id,
          tool: event.tool,
          agent: event.agent,
          label: resolveToolLabel(event.tool, event.agent),
          status: "running",
          stages,
          startedAt: Date.now(),
        };

        parts.push({ type: "tool", execution: exec });
        break;
      }

      case "tool:end": {
        // Find matching tool part by id
        for (const p of parts) {
          if (p.type === "tool" && p.execution.id === event.id) {
            const exec = p.execution;
            exec.status = event.isError ? "error" : "completed";
            exec.completedAt = Date.now();
            if (event.isError) exec.error = localizeKnownRuntimeMessage(summarizeToolResult(event.result));
            else exec.result = summarizeToolResult(event.result);
            if (event.details !== undefined) exec.details = event.details;
            // Mark all remaining stages as completed
            exec.stages = exec.stages?.map((s) =>
              s.status !== "completed" ? { ...s, status: "completed" as const, progress: undefined } : s
            );
            break;
          }
        }
        break;
      }

      case "log:stage": {
        const exec = findRunningTool();
        if (!exec?.stages) break;
        let found = false;
        exec.stages = exec.stages.map((stage) => {
          if (stage.label === event.stageName) {
            found = true;
            return { ...stage, status: "active" as const };
          }
          if (!found && stage.status === "active") {
            return { ...stage, status: "completed" as const, progress: undefined };
          }
          return stage;
        });
        break;
      }

      case "llm:progress": {
        const exec = findRunningTool();
        if (!exec?.stages) break;
        exec.stages = exec.stages.map((stage) =>
          stage.status === "active"
            ? { ...stage, progress: { status: event.status, elapsedMs: event.elapsedMs, totalChars: event.totalChars, chineseChars: event.chineseChars } }
            : stage
        );
        break;
      }

      case "llm:telemetry": {
        applyLLMTelemetryEvent(parts, event);
        break;
      }

      case "context:compression": {
        applyContextCompressionEvent(parts, event);
        break;
      }
    }
  }

  return parts;
}
