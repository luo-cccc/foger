import type { LLMClient, LLMMessage, LLMResponse, OnStreamProgress, OnCallTelemetry } from "../llm/provider.js";
import { chatCompletion } from "../llm/provider.js";
import type { Logger } from "../utils/logger.js";

export interface AgentContext {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  /** P0: telemetry callback for all LLM calls made by this agent. */
  readonly onCallTelemetry?: OnCallTelemetry;
  /** P0: per-call LLM timeout in milliseconds. */
  readonly defaultTimeoutMs?: number;
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
      /** P0: phase label for telemetry (e.g. "write", "settle", "audit", "plan"). */
      readonly callPhase?: string;
    },
  ): Promise<LLMResponse> {
    return chatCompletion(this.ctx.client, this.ctx.model, messages, {
      ...options,
      agentName: this.name,
      callPhase: options?.callPhase ?? "chat",
      onStreamProgress: this.ctx.onStreamProgress,
      onCallTelemetry: this.ctx.onCallTelemetry,
      timeoutMs: this.ctx.defaultTimeoutMs,
    });
  }

  protected async withPromptPackGuidance(basePrompt: string, promptId: string): Promise<string> {
    return basePrompt;
  }

  /**
   * Chat with web search enabled.
   * OpenAI: uses native web_search_options / web_search_preview.
   * Other providers: searches via Tavily API (TAVILY_API_KEY), injects results into prompt.
   */
  abstract get name(): string;
}
