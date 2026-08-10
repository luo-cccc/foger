import type { SSEMessage } from "../../hooks/use-sse";
import { buildLLMTelemetrySnapshot, type LLMCallStatus } from "../../lib/llm-telemetry-display";
import { tr } from "../../lib/app-language";
import { summarizeLLMCallRootCause } from "../../lib/error-copy";
import { SidebarCard } from "./SidebarCard";

interface LLMTelemetrySectionProps {
  readonly bookId: string;
  readonly sse: { readonly messages: ReadonlyArray<SSEMessage> };
}

function statusTone(status: LLMCallStatus): string {
  if (status === "success") return "text-emerald-600 bg-emerald-500/10";
  if (status === "partial") return "text-amber-600 bg-amber-500/10";
  return "text-destructive bg-destructive/10";
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </div>
  );
}

export function LLMTelemetrySection({ bookId, sse }: LLMTelemetrySectionProps) {
  const snapshot = buildLLMTelemetrySnapshot(sse.messages, { bookId, limit: 5 });
  if (snapshot.totalCalls === 0) return null;

  const highlightedSummary = snapshot.primaryRootCause?.summary ?? null;

  return (
    <SidebarCard title={tr("LLM 遥测", "LLM Telemetry")} defaultOpen={false}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Metric label={tr("调用", "Calls")} value={String(snapshot.totalCalls)} />
          <Metric label={tr("失败", "Failed")} value={String(snapshot.failedCalls)} />
          <Metric label={tr("超时", "Timeouts")} value={String(snapshot.timeoutCalls)} />
          <Metric label={tr("Tokens", "Tokens")} value={snapshot.totalTokens.toLocaleString()} />
        </div>

        {snapshot.topRootCauses.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {snapshot.topRootCauses.map((cause) => (
              <span
                key={cause.kind}
                className="rounded-full border border-border/40 bg-background/60 px-2 py-1 text-[10px] text-foreground/85"
              >
                {cause.label} · {cause.count}
              </span>
            ))}
          </div>
        )}

        {highlightedSummary && (
          <div className="rounded-lg border border-border/40 bg-card/40 px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {snapshot.primaryRootCause?.label ?? tr("需要关注", "Needs attention")}
            </div>
            <div className="mt-1 text-[11px] leading-5 text-foreground/85">
              {highlightedSummary}
            </div>
          </div>
        )}

        <div className="space-y-2">
          {snapshot.recentCalls.map((call, index) => {
            const summary = summarizeLLMCallRootCause(call);

            return (
              <div key={`${call.timestamp}-${index}`} className="rounded-lg border border-border/40 bg-background/40 px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusTone(call.status)}`}>
                    {call.status}
                  </span>
                  <span className="truncate text-xs font-medium">{call.agent}</span>
                  <span className="truncate text-[11px] text-muted-foreground">/ {call.phase}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {Math.round(call.durationMs / 100) / 10}s
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{call.service}</span>
                  <span>{call.totalTokens.toLocaleString()} tok</span>
                  {call.timeoutMs !== undefined ? <span>{call.timeoutMs}ms</span> : null}
                  {call.partialContentLength !== undefined ? <span>{call.partialContentLength} ch</span> : null}
                </div>
                {summary ? (
                  <div className="mt-1.5 rounded-md border border-border/30 bg-card/70 px-2 py-1.5 text-[11px] leading-5 text-foreground/85">
                    {summary}
                  </div>
                ) : null}
                {call.errorMessage ? (
                  <div className="mt-1.5 break-words text-[11px] leading-5 text-destructive">
                    {call.errorMessage}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="text-[11px] text-muted-foreground">
          {tr("最近最长调用", "Longest recent call")}: {Math.round(snapshot.longestCallMs / 100) / 10}s
        </div>
      </div>
    </SidebarCard>
  );
}
