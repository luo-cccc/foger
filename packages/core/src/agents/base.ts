import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
  OnStreamProgress,
  OnCallTelemetry,
  LLMPromptSourceInput,
} from "../llm/provider.js";
import { chatCompletion, isProviderContentPolicyError } from "../llm/provider.js";
import type { Logger } from "../utils/logger.js";
import type { OnPipelineDiagnostic, PipelineDiagnostic } from "../pipeline/diagnostics.js";

export interface AgentContext {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  /** P0: telemetry callback for all LLM calls made by this agent. */
  readonly onCallTelemetry?: OnCallTelemetry;
  /** Structured pipeline retries and fallback paths for reports and diagnostics. */
  readonly onPipelineDiagnostic?: OnPipelineDiagnostic;
  /** P0: per-call LLM timeout in milliseconds. */
  readonly defaultTimeoutMs?: number;
  /** Reject an assembled prompt before transport when it exceeds this budget. */
  readonly maxPromptEstimatedTokens?: number;
  /** Cooperative cancellation for the active pipeline operation. */
  readonly signal?: AbortSignal;
  /** Explicit one-shot cross-provider route for content-policy rejections. */
  readonly contentPolicyFallback?: {
    readonly client: LLMClient;
    readonly model: string;
  };
}

export interface AgentChatOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Provider-specific request fields for this call only. */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Override the project stream mode for atomic structured calls. */
  readonly stream?: boolean;
  /** P0: phase label for telemetry (e.g. "write", "settle", "audit", "plan"). */
  readonly callPhase?: string;
  readonly promptSources?: ReadonlyArray<LLMPromptSourceInput>;
}

export abstract class BaseAgent {
  protected readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  protected get log() {
    return this.ctx.logger;
  }

  protected async chat(
    messages: ReadonlyArray<LLMMessage>,
    options?: AgentChatOptions,
  ): Promise<LLMResponse> {
    return this.chatWithContext(this.ctx, this.name, messages, options);
  }

  protected async chatWithContext(
    context: AgentContext,
    agentName: string,
    messages: ReadonlyArray<LLMMessage>,
    options?: AgentChatOptions,
  ): Promise<LLMResponse> {
    const callOptions = {
      ...options,
      agentName,
      callPhase: options?.callPhase ?? "chat",
      onStreamProgress: context.onStreamProgress,
      onCallTelemetry: context.onCallTelemetry,
      timeoutMs: context.defaultTimeoutMs,
      maxPromptEstimatedTokens: context.maxPromptEstimatedTokens,
      signal: context.signal,
      promptSources: options?.promptSources,
    } as const;

    try {
      return await chatCompletion(context.client, context.model, messages, callOptions);
    } catch (error) {
      const fallback = context.contentPolicyFallback;
      if (!fallback || !isProviderContentPolicyError(error)) throw error;

      const primaryService = context.client.service ?? "unknown";
      const fallbackService = fallback.client.service ?? "unknown";
      context.onPipelineDiagnostic?.({
        kind: "content-policy-fallback",
        severity: "warning",
        agent: agentName,
        phase: options?.callPhase ?? "chat",
        ...(context.bookId ? { bookId: context.bookId } : {}),
        message: `Provider content policy rejected ${primaryService}/${context.model}; invoking the configured fallback once.`,
        details: {
          failureKind: "provider-content-policy",
          primaryService,
          primaryModel: context.model,
          fallbackService,
          fallbackModel: fallback.model,
          maxFallbackAttempts: 1,
        },
        timestamp: new Date().toISOString(),
      });

      return chatCompletion(fallback.client, fallback.model, messages, {
        ...callOptions,
        retry: false,
        fallbackRoute: {
          route: "content-policy-fallback",
          fromService: primaryService,
          fromModel: context.model,
        },
      });
    }
  }

  protected async withPromptPackGuidance(basePrompt: string, promptId: string): Promise<string> {
    return basePrompt;
  }

  protected emitDiagnostic(
    diagnostic: Omit<PipelineDiagnostic, "agent" | "bookId" | "timestamp">,
  ): void {
    this.ctx.onPipelineDiagnostic?.({
      ...diagnostic,
      agent: this.name,
      ...(this.ctx.bookId ? { bookId: this.ctx.bookId } : {}),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Chat with web search enabled.
   * OpenAI: uses native web_search_options / web_search_preview.
   * Other providers: searches via Tavily API (TAVILY_API_KEY), injects results into prompt.
   */
  abstract get name(): string;
}
