import { memo, useMemo, useState, useEffect } from "react";
import type { ChatActionPayload, ChatRequestedIntent, ChatSessionKind, ToolExecution, PipelineStage, ToolLLMCall } from "../../store/chat/types";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../ui/collapsible";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Wrench,
  Check,
} from "lucide-react";
import { tr } from "../../lib/app-language";
import { summarizeLLMCallRootCause } from "../../lib/error-copy";
import { chatSelectors, useChatStore } from "../../store/chat";
import { usePreferencesStore } from "../../store/preferences";

// -- Status rendering helpers --

function ExecStatusBadge({ status }: { status: ToolExecution["status"] }) {
  switch (status) {
    case "running":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-primary">
          <Loader2 size={12} className="animate-spin" />
          <span>{tr("执行中", "Running")}</span>
        </span>
      );
    case "processing":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" style={{ animationDuration: "2s" }} />
          <span>{tr("处理结果", "Processing result")}</span>
        </span>
      );
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
          <CheckCircle2 size={12} />
          <span>{tr("已完成", "Completed")}</span>
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-destructive">
          <XCircle size={12} />
          <span>{tr("失败", "Failed")}</span>
        </span>
      );
  }
}

function StageIcon({ status }: { status: PipelineStage["status"] }) {
  switch (status) {
    case "pending":
      return <span className="w-4 h-4 rounded-full border border-border/60 flex items-center justify-center shrink-0 text-[8px] text-muted-foreground/40">○</span>;
    case "active":
      return <Loader2 size={14} className="text-primary animate-spin shrink-0" />;
    case "completed":
      return <CheckCircle2 size={14} className="text-green-600 dark:text-green-400 shrink-0" />;
  }
}

function formatProgress(progress: NonNullable<PipelineStage["progress"]>): string {
  const secs = Math.round(progress.elapsedMs / 1000);
  const statusLabel = progress.status === "thinking" ? tr("思考中", "Thinking") : progress.status ?? "";
  const chars = progress.totalChars > 0
    ? progress.chineseChars > 0 ? `${progress.totalChars}字` : `${progress.totalChars} chars`
    : "";
  const parts = [statusLabel, `${secs}s`, chars].filter(Boolean);
  return parts.join(" · ");
}

function formatDuration(startedAt: number, completedAt?: number): string {
  const ms = (completedAt ?? Date.now()) - startedAt;
  const secs = Math.round(ms / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function llmCallTone(status: ToolLLMCall["status"]): string {
  if (status === "success") return "text-emerald-600 bg-emerald-500/10";
  if (status === "partial") return "text-amber-700 bg-amber-500/10";
  return "text-destructive bg-destructive/10";
}

function formatLLMCallDuration(durationMs: number): string {
  return `${Math.round(durationMs / 100) / 10}s`;
}

function ToolLLMCallList({ calls }: { readonly calls: ReadonlyArray<ToolLLMCall> }) {
  return (
    <div className="mb-2 space-y-1.5">
      {calls.map((call, index) => {
        const summary = summarizeLLMCallRootCause(call);

        return (
          <div key={`${call.phase}-${call.durationMs}-${index}`} className="rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${llmCallTone(call.status)}`}>
                {call.status}
              </span>
              <span className="text-xs font-medium">{call.phase}</span>
              <span className="text-[11px] text-muted-foreground">{call.service}</span>
              <span className="text-[11px] text-muted-foreground truncate">{call.model}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {formatLLMCallDuration(call.durationMs)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{call.totalTokens.toLocaleString()} tok</span>
              {call.timeoutMs !== undefined && <span>{call.timeoutMs}ms timeout</span>}
              {call.partialContentLength !== undefined && <span>{call.partialContentLength} chars partial</span>}
            </div>
            {summary && (
              <div className="mt-1.5 rounded-md border border-border/30 bg-card/70 px-2 py-1.5 text-[11px] leading-5 text-foreground/85">
                {summary}
              </div>
            )}
            {call.errorMessage && (
              <div className="mt-1.5 text-[11px] leading-5 text-destructive break-words">
                {call.errorMessage}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface ProposedActionDetails {
  readonly kind: "proposed_action";
  readonly execId: string;
  readonly action: ChatRequestedIntent;
  readonly targetSessionKind: ChatSessionKind;
  readonly targetRoute?: "import:chapters" | "import:canon";
  readonly sameSession?: boolean;
  readonly title?: string;
  readonly summary?: string;
  readonly instruction?: string;
  readonly actionPayload?: ChatActionPayload;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function actionPayloadField(record: Record<string, unknown>): ChatActionPayload | undefined {
  const value = record.actionPayload;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ChatActionPayload;
}

function proposedTargetRouteField(record: Record<string, unknown>): ProposedActionDetails["targetRoute"] {
  const value = stringField(record, "targetRoute");
  if (
    value === "import:chapters"
    || value === "import:canon"
  ) {
    return value;
  }
  return undefined;
}

export function getProposedActionDetails(exec: ToolExecution): ProposedActionDetails | null {
  if (exec.tool !== "propose_action") return null;
  if (!exec.details || typeof exec.details !== "object") return null;
  const record = exec.details as Record<string, unknown>;
  if (record.kind !== "proposed_action") return null;
  const action = stringField(record, "action") as ChatRequestedIntent | undefined;
  const targetSessionKind = stringField(record, "targetSessionKind") as ChatSessionKind | undefined;
  const instruction = stringField(record, "instruction");
  if (!action || !targetSessionKind || !instruction) return null;
  return {
    kind: "proposed_action",
    execId: exec.id,
    action,
    targetSessionKind,
    targetRoute: proposedTargetRouteField(record),
    sameSession: booleanField(record, "sameSession"),
    title: stringField(record, "title"),
    summary: stringField(record, "summary"),
    instruction,
    actionPayload: actionPayloadField(record),
  };
}

function ProposedActionPreview({
  exec,
  onProposedAction,
  onRejectProposedAction,
}: {
  exec: ToolExecution;
  onProposedAction?: (details: ProposedActionDetails) => void;
  onRejectProposedAction?: (details: ProposedActionDetails) => void;
}) {
  const resolvedProposals = useChatStore((s) => s.resolvedProposals);
  const isActiveSessionStreaming = useChatStore(chatSelectors.isActiveSessionStreaming);
  if (exec.tool !== "propose_action" || exec.status !== "completed") return null;
  const details = getProposedActionDetails(exec);
  if (!details) return null;
  // A proposed action is one-shot: once confirmed or rejected the card locks so
  // the production action can't be re-fired. While a run is in flight the
  // confirm button reflects "执行中…" instead of silently swallowing the click.
  const resolution = resolvedProposals[details.execId];
  const streaming = isActiveSessionStreaming;
  const locked = resolution !== undefined;
  return (
    <div className="mx-3 mb-3 mt-1 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3.5">
      <div className="text-[17px] leading-6 font-semibold text-foreground">{details.title ?? tr("确认执行", "Confirm action")}</div>
      {details.summary && (
        <div className="mt-1.5 whitespace-pre-wrap break-words text-[15px] leading-7 text-muted-foreground">{details.summary}</div>
      )}
      <div className="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-background/70 px-3 py-2.5 text-[15px] leading-7 text-muted-foreground">
        {details.instruction}
      </div>
      {resolution === "confirmed" ? (
        <div className="mt-3 flex items-center gap-1.5 text-[15px] leading-6 font-medium text-primary">
          <Check size={15} className="shrink-0" />
          {details.targetRoute ? tr("已打开", "Opened") : tr("已执行", "Executed")}
        </div>
      ) : resolution === "rejected" ? (
        <div className="mt-3 text-[15px] leading-6 font-medium text-muted-foreground">{tr("已取消", "Cancelled")}</div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="confirm-action"
            onClick={() => onProposedAction?.(details)}
            disabled={!onProposedAction || streaming || locked}
            className="rounded-lg bg-primary px-3.5 py-2 text-[15px] leading-6 font-medium text-primary-foreground disabled:opacity-50"
          >
            {streaming ? tr("执行中…", "Running…") : details.targetRoute ? tr("打开入口", "Open entry") : tr("继续执行", "Continue")}
          </button>
          <button
            type="button"
            onClick={() => onRejectProposedAction?.(details)}
            disabled={!onRejectProposedAction || streaming || locked}
            className="rounded-lg border border-border/60 bg-background/80 px-3.5 py-2 text-[15px] leading-6 font-medium text-muted-foreground disabled:opacity-50"
          >
            {tr("取消", "Cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

function isPipelineTool(tool: string): boolean {
  return tool === "sub_agent"
    || tool === "llm_call"
    || tool === "context_compression"
    || tool === "propose_action";
}

// -- Live elapsed timer hook --

function useElapsedTimer(startedAt: number, active: boolean): number {
  const [elapsed, setElapsed] = useState(() => active ? Date.now() - startedAt : 0);
  useEffect(() => {
    if (!active) return;
    setElapsed(Date.now() - startedAt);
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt, active]);
  return elapsed;
}

// -- Pipeline operation (sub_agent) --

/**
 * Uncontrolled <details>: `open` only sets the initial state, so manual
 * toggling keeps working (React leaves the DOM alone while the prop value is
 * unchanged). The key remounts the element when the global preference flips,
 * re-applying the new default.
 */
export function PipelineResultDetails({ result, defaultOpen }: { result: string; defaultOpen: boolean }) {
  return (
    <details
      key={defaultOpen ? "result-default-open" : "result-default-collapsed"}
      open={defaultOpen}
      className="mx-3 mb-3 mt-1 rounded-lg border border-border/40 bg-background/60 px-2.5 py-2 text-xs"
    >
      <summary className="cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground">
        {tr("查看操作结果", "View result")}
      </summary>
      <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words leading-5 text-foreground">
        {result}
      </div>
    </details>
  );
}

function PipelineExecution({
  exec,
  onProposedAction,
  onRejectProposedAction,
}: {
  exec: ToolExecution;
  onProposedAction?: (details: ProposedActionDetails) => void;
  onRejectProposedAction?: (details: ProposedActionDetails) => void;
}) {
  const isActive = exec.status === "running" || exec.status === "processing";
  const [open, setOpen] = useState(isActive);
  const elapsedMs = useElapsedTimer(exec.startedAt, isActive);
  const toolDetailsDefaultOpen = usePreferencesStore((s) => s.toolDetailsDefaultOpen);

  useEffect(() => {
    if (exec.status === "running") setOpen(true);
    if (exec.status === "completed") {
      const timer = setTimeout(() => setOpen(false), 500);
      return () => clearTimeout(timer);
    }
  }, [exec.status]);

  const bookId = exec.args?.bookId as string | undefined;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border border-border/40 bg-card/60">
      <CollapsibleTrigger className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl hover:bg-card/80 transition-colors cursor-pointer">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[16px] leading-6 font-medium text-foreground truncate">
            {exec.label}
            {bookId && <span className="text-muted-foreground font-normal"> · {bookId}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[12px] text-muted-foreground/60">
            {isActive
              ? formatDuration(exec.startedAt, exec.startedAt + elapsedMs)
              : exec.completedAt ? formatDuration(exec.startedAt, exec.completedAt) : ""}
          </span>
          <ExecStatusBadge status={exec.status} />
          <ChevronDown size={16} className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </CollapsibleTrigger>
      <ProposedActionPreview
        exec={exec}
        onProposedAction={onProposedAction}
        onRejectProposedAction={onRejectProposedAction}
      />
      {typeof exec.result === "string" && exec.result.trim() && (
        <PipelineResultDetails result={exec.result} defaultOpen={toolDetailsDefaultOpen} />
      )}
      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1">
          {exec.llmCalls && exec.llmCalls.length > 0 && (
            <ToolLLMCallList calls={exec.llmCalls} />
          )}
          {exec.stages && exec.stages.length > 0 && (
            <ol className="mb-2 space-y-1.5">
              {exec.stages.map((stage) => (
                <li
                  key={stage.label}
                  className={[
                    "flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs",
                    stage.status === "active" ? "bg-primary/5 text-foreground" : "text-muted-foreground",
                  ].join(" ")}
                >
                  <StageIcon status={stage.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{stage.label}</div>
                    {stage.progress && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground/70">
                        {formatProgress(stage.progress)}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {/* Real-time execution logs */}
          {exec.logs && exec.logs.length > 0 && (
            <ul className="space-y-0.5">
              {exec.logs.map((log, i) => {
                const isError = log.startsWith("[error]") || /error/i.test(log);
                const isWarn = log.startsWith("[warning]") || /warning|警告/i.test(log);
                return (
                  <li key={i} className={`text-xs font-mono break-words ${isError ? "text-destructive" : isWarn ? "text-yellow-600 dark:text-yellow-400" : "text-muted-foreground"}`}>
                    {log}
                  </li>
                );
              })}
            </ul>
          )}
          {exec.status === "error" && exec.error && (
            <div className="mt-2 text-xs text-destructive bg-destructive/5 rounded-lg px-2.5 py-2">
              {exec.error}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Utility tools (read/edit/grep/ls) grouped --

function UtilityExecStatusIcon({ status }: { status: ToolExecution["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 size={10} className="text-green-600 dark:text-green-400 shrink-0" />;
    case "error":
      return <XCircle size={10} className="text-destructive shrink-0" />;
    case "running":
    case "processing":
      return <Loader2 size={10} className="animate-spin text-primary shrink-0" />;
  }
}

export function UtilityExecutionRow({ exec }: { exec: ToolExecution }) {
  const title = `${exec.tool} ${String(exec.args?.path ?? exec.args?.pattern ?? "")}`;
  const hasResult = typeof exec.result === "string" && exec.result.trim().length > 0;

  if (!hasResult) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono truncate">{title}</span>
        <UtilityExecStatusIcon status={exec.status} />
      </div>
    );
  }

  // Uncontrolled <details>, always collapsed by default: utility results are
  // reference material, expanding them all would flood the transcript.
  return (
    <details className="group">
      <summary className="flex cursor-pointer select-none items-center gap-2 list-none [&::-webkit-details-marker]:hidden hover:text-foreground transition-colors">
        <span className="font-mono truncate">{title}</span>
        <UtilityExecStatusIcon status={exec.status} />
        <ChevronDown size={10} className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-1 mb-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-background/60 px-2 py-1.5 leading-5">
        {exec.result}
      </div>
    </details>
  );
}

function UtilityToolsGroup({ execs }: { execs: ToolExecution[] }) {
  const [open, setOpen] = useState(false);
  const allDone = execs.every(e => e.status === "completed" || e.status === "error");
  const hasError = execs.some(e => e.status === "error");

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer text-xs text-muted-foreground">
        <Wrench size={12} />
        <span>{tr(`${execs.length} 个文件操作`, `${execs.length} file operation${execs.length === 1 ? "" : "s"}`)}</span>
        {allDone && !hasError && <CheckCircle2 size={10} className="text-green-600 dark:text-green-400" />}
        {hasError && <XCircle size={10} className="text-destructive" />}
        {!allDone && <Loader2 size={10} className="animate-spin text-primary" />}
        <ChevronDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="pl-6 space-y-0.5 py-1">
          {execs.map((exec) => (
            <li key={exec.id} className="text-xs text-muted-foreground">
              <UtilityExecutionRow exec={exec} />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// -- Main component --

export interface ToolExecutionStepsProps {
  executions: ToolExecution[];
  onProposedAction?: (details: ProposedActionDetails) => void;
  onRejectProposedAction?: (details: ProposedActionDetails) => void;
}

/**
 * Group executions chronologically: pipeline ops render individually,
 * consecutive utility tools are merged into a single collapsed group.
 */
type RenderGroup =
  | { type: "pipeline"; exec: ToolExecution }
  | { type: "utilities"; execs: ToolExecution[] };

export function groupToolExecutionsChronologically(executions: ToolExecution[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let utilBuf: ToolExecution[] = [];

  const flushUtils = () => {
    if (utilBuf.length > 0) {
      groups.push({ type: "utilities", execs: utilBuf });
      utilBuf = [];
    }
  };

  for (const exec of executions) {
    if (isPipelineTool(exec.tool)) {
      flushUtils();
      groups.push({ type: "pipeline", exec });
    } else {
      utilBuf.push(exec);
    }
  }
  flushUtils();
  return groups;
}

export const ToolExecutionSteps = memo(function ToolExecutionSteps({ executions, onProposedAction, onRejectProposedAction }: ToolExecutionStepsProps) {
  const groups = useMemo(() => groupToolExecutionsChronologically(executions), [executions]);

  return (
    <div className="space-y-2 mt-2">
      {groups.map((g, i) =>
        g.type === "pipeline"
          ? (
              <PipelineExecution
                key={g.exec.id}
                exec={g.exec}
                onProposedAction={onProposedAction}
                onRejectProposedAction={onRejectProposedAction}
              />
            )
          : <UtilityToolsGroup key={`utils-${i}`} execs={g.execs} />
      )}
    </div>
  );
});

ToolExecutionSteps.displayName = "ToolExecutionSteps";
