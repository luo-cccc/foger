import type {
  LLMClient,
  LLMMessage,
  LLMResponse,
  OnStreamProgress,
  OnCallTelemetry,
  LLMPromptSourceInput,
} from "../llm/provider.js";
import { chatCompletion } from "../llm/provider.js";
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
    options?: {
      readonly temperature?: number;
      readonly maxTokens?: number;
      /** Override the project stream mode for atomic structured calls. */
      readonly stream?: boolean;
      /** P0: phase label for telemetry (e.g. "write", "settle", "audit", "plan"). */
      readonly callPhase?: string;
      readonly promptSources?: ReadonlyArray<LLMPromptSourceInput>;
    },
  ): Promise<LLMResponse> {
    return chatCompletion(this.ctx.client, this.ctx.model, messages, {
      ...options,
      agentName: this.name,
      callPhase: options?.callPhase ?? "chat",
      onStreamProgress: this.ctx.onStreamProgress,
      onCallTelemetry: this.ctx.onCallTelemetry,
      timeoutMs: this.ctx.defaultTimeoutMs,
      maxPromptEstimatedTokens: this.ctx.maxPromptEstimatedTokens,
      signal: this.ctx.signal,
      promptSources: options?.promptSources,
    });
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
