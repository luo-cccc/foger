import { useMemo } from "react";
import { Stethoscope, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import type { SSEMessage } from "../hooks/use-sse";
import { tr } from "../lib/app-language";
import { summarizeLLMCallRootCause } from "../lib/error-copy";
import { buildLLMTelemetrySnapshot } from "../lib/llm-telemetry-display";

interface DoctorChecks {
  readonly inkosJson: boolean;
  readonly projectEnv: boolean;
  readonly globalEnv: boolean;
  readonly booksDir: boolean;
  readonly llmConnected: boolean;
  readonly bookCount: number;
}

interface Nav {
  toDashboard: () => void;
  toDoctor: (operationId?: string) => void;
}

function telemetryTone(status: "success" | "timeout" | "error" | "partial"): string {
  if (status === "success") return "text-emerald-600 bg-emerald-500/10";
  if (status === "partial") return "text-amber-600 bg-amber-500/10";
  return "text-destructive bg-destructive/10";
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border/30 py-3 last:border-0">
      {ok ? (
        <CheckCircle2 size={18} className="shrink-0 text-emerald-500" />
      ) : (
        <XCircle size={18} className="shrink-0 text-destructive" />
      )}
      <span className="flex-1 text-sm font-medium">{label}</span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-card/40 px-3 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

export function DoctorView(
  { nav, operationId, theme, t, sse }: { nav: Nav; operationId?: string; theme: Theme; t: TFunction; sse: { readonly messages: ReadonlyArray<SSEMessage> } },
) {
  const c = useColors(theme);
  const { data, refetch } = useApi<DoctorChecks>("/doctor");
  const telemetry = useMemo(
    () => buildLLMTelemetrySnapshot(sse.messages, { limit: 8, ...(operationId ? { operationId } : {}) }),
    [operationId, sse.messages],
  );
  const highlightedCall = useMemo(
    () => telemetry.recentCalls.find((call) => summarizeLLMCallRootCause(call)) ?? null,
    [telemetry.recentCalls],
  );
  const highlightedSummary = telemetry.primaryRootCause?.summary
    ?? (highlightedCall ? summarizeLLMCallRootCause(highlightedCall) : null);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.doctor")}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-3 font-serif text-3xl">
          <Stethoscope size={28} className="text-primary" />
          {t("doctor.title")}
        </h1>
        <button onClick={() => refetch()} className={`rounded-lg px-4 py-2 text-sm ${c.btnSecondary}`}>
          {t("doctor.recheck")}
        </button>
      </div>

      {!data ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-primary" />
        </div>
      ) : (
        <div className={`rounded-lg border p-5 ${c.cardStatic}`}>
          <CheckRow label={t("doctor.inkosJson")} ok={data.inkosJson} />
          <CheckRow label={t("doctor.projectEnv")} ok={data.projectEnv} />
          <CheckRow label={t("doctor.globalEnv")} ok={data.globalEnv} />
          <CheckRow label={t("doctor.booksDir")} ok={data.booksDir} detail={`${data.bookCount} book(s)`} />
          <CheckRow label={t("doctor.llmApi")} ok={data.llmConnected} detail={data.llmConnected ? t("doctor.connected") : t("doctor.failed")} />
        </div>
      )}

      {data && (
        <div className={`rounded-lg px-4 py-3 text-sm font-medium ${
          data.inkosJson && (data.projectEnv || data.globalEnv) && data.llmConnected
            ? "bg-emerald-500/10 text-emerald-600"
            : "bg-amber-500/10 text-amber-600"
        }`}>
          {data.inkosJson && (data.projectEnv || data.globalEnv) && data.llmConnected
            ? t("doctor.allPassed")
            : t("doctor.someFailed")
          }
        </div>
      )}

      <div className={`rounded-lg border p-5 ${c.cardStatic} space-y-5`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{tr("实时 LLM 遥测", "Live LLM Telemetry")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {tr(
                "这里会显示最近几次 Studio 会话中的模型调用耗时、失败、超时和 token 消耗。",
                "This shows recent Studio call latency, failures, timeouts, and token usage.",
              )}
            </p>
          </div>
          <div
            data-testid={operationId ? "operation-telemetry-call-count" : undefined}
            className="text-xs text-muted-foreground"
          >
            {telemetry.totalCalls > 0 ? `${telemetry.totalCalls} recent call(s)` : tr("还没有最近调用", "No recent calls yet")}
          </div>
        </div>

        {operationId && (
          <div data-testid="operation-trace-filter" className="flex flex-wrap items-center gap-3 rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
            <span className="font-medium text-foreground">{tr("操作追溯", "Operation trace")}</span>
            <code className="min-w-0 flex-1 break-all font-mono text-muted-foreground">{operationId}</code>
            <button onClick={() => nav.toDoctor()} className="text-primary hover:underline">
              {tr("清除筛选", "Clear filter")}
            </button>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Metric label={tr("调用", "Calls")} value={String(telemetry.totalCalls)} />
          <Metric label={tr("失败", "Failures")} value={String(telemetry.failedCalls)} />
          <Metric label={tr("部分返回", "Partials")} value={String(telemetry.partialCalls)} />
          <Metric label={tr("超时", "Timeouts")} value={String(telemetry.timeoutCalls)} />
          <Metric label={tr("慢调用", "Slow Calls")} value={String(telemetry.slowCalls)} />
          <Metric label="Tokens" value={telemetry.totalTokens.toLocaleString()} />
        </div>

        {telemetry.topRootCauses.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {tr("主要问题类型", "Top issue types")}
            </div>
            <div className="flex flex-wrap gap-2">
              {telemetry.topRootCauses.map((cause) => (
                <span
                  key={cause.kind}
                  className="rounded-full border border-border/40 bg-background/70 px-3 py-1 text-xs text-foreground/85"
                >
                  {cause.label} · {cause.count}
                </span>
              ))}
            </div>
          </div>
        )}

        {highlightedSummary && (
          <div className="rounded-lg border border-border/40 bg-card/40 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {telemetry.primaryRootCause?.label ?? tr("需要关注", "Needs attention")}
            </div>
            <div className="mt-1 text-sm leading-6 text-foreground/85">
              {highlightedSummary}
            </div>
          </div>
        )}

        {telemetry.totalCalls > 0 ? (
          <div className="space-y-3">
            {telemetry.recentCalls.map((call, index) => {
              const summary = summarizeLLMCallRootCause(call);

              return (
                <div key={`${call.timestamp}-${index}`} className="rounded-lg border border-border/40 bg-card/30 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase ${telemetryTone(call.status)}`}>
                      {call.status}
                    </span>
                    <span className="font-medium">{call.agent}</span>
                    <span className="text-muted-foreground">/ {call.phase}</span>
                    {call.bookId && (
                      <span className="rounded-full border border-border/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                        {call.bookId}
                      </span>
                    )}
                    {call.operationId && (
                      <span className="rounded-full border border-border/50 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
                        {call.operationId}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {Math.round(call.durationMs / 100) / 10}s
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{call.service}</span>
                    <span>{call.model}</span>
                    <span>{call.totalTokens.toLocaleString()} tokens</span>
                    {call.timeoutMs !== undefined && <span>timeout {call.timeoutMs}ms</span>}
                    {call.partialContentLength !== undefined && <span>partial {call.partialContentLength} chars</span>}
                  </div>
                  {summary && (
                    <div className="mt-2 rounded-md border border-border/30 bg-card/70 px-2.5 py-2 text-xs leading-5 text-foreground/85">
                      {summary}
                    </div>
                  )}
                  {call.errorMessage && (
                    <div className="mt-2 break-words text-xs text-destructive">
                      {call.errorMessage}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="text-xs text-muted-foreground">
              {tr("最近最长调用", "Longest recent call")}: {Math.round(telemetry.longestCallMs / 100) / 10}s
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-sm text-muted-foreground">
            {tr(
              "还没有捕获到实时调用记录。开始一次写作、修订或会话后，这里会出现最近的 LLM 诊断。",
              "No live telemetry yet. Start a writing or editing run and recent LLM diagnostics will appear here.",
            )}
          </div>
        )}
      </div>
    </div>
  );
}
