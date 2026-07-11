import { getAppLanguage } from "./app-language";
import type { ToolLLMCall } from "../store/chat/types";

const KNOWN_RUNTIME_REPLACEMENTS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    pattern: /Latest chapter (\d+) is state-degraded\. Repair state or rewrite that chapter before continuing\./g,
    replacement: "最新第 $1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。",
  },
  {
    pattern: /Chapter (\d+) is not state-degraded\./g,
    replacement: "第 $1 章并不是状态降级（state-degraded），无需按状态修复。",
  },
  {
    pattern: /Only the latest state-degraded chapter can be repaired safely \(latest is (\d+)\)\./g,
    replacement: "只能安全修复最新的状态降级章节；当前最新章节是第 $1 章。",
  },
  {
    pattern: /State repair still failed for chapter (\d+)\./g,
    replacement: "第 $1 章状态修复仍然失败。",
  },
  {
    pattern: /Studio LLM API key not set\. Open Studio services and save an API key for the selected service\./g,
    replacement: "Studio 模型 API Key 尚未设置。请打开“模型配置”，为当前服务保存 API Key。",
  },
  {
    pattern: /INKOS_LLM_API_KEY not set\. Run 'inkos config set-global' or add it to project \.env file\./g,
    replacement: "INKOS_LLM_API_KEY 尚未设置。请运行 `inkos config set-global`，或将它写入项目的 .env 文件。",
  },
];

export type LLMRootCauseKind =
  | "timeout"
  | "partial"
  | "reasoning_content"
  | "malformed_function_call"
  | "empty_response"
  | "context_limit"
  | "content_policy"
  | "provider_unavailable"
  | "rate_limit"
  | "auth"
  | "slow_success";

export interface LLMRootCauseSummary {
  readonly kind: LLMRootCauseKind;
  readonly label: string;
  readonly summary: string;
}

function localizedCopy(en: string, zh: string): string {
  return getAppLanguage() === "en" ? en : zh;
}

export function localizeKnownRuntimeMessage(message: string): string {
  if (getAppLanguage() === "en") return message;
  let localized = message;
  for (const entry of KNOWN_RUNTIME_REPLACEMENTS) {
    localized = localized.replace(entry.pattern, entry.replacement);
  }
  return localized;
}

export function labelLLMRootCauseKind(kind: LLMRootCauseKind): string {
  switch (kind) {
    case "timeout":
      return localizedCopy("Timeouts", "超时");
    case "partial":
      return localizedCopy("Partial streams", "流中断");
    case "reasoning_content":
      return localizedCopy("Thinking-mode mismatch", "思维模式不兼容");
    case "malformed_function_call":
      return localizedCopy("Tool-call formatting", "工具调用格式错误");
    case "empty_response":
      return localizedCopy("Empty responses", "空响应");
    case "context_limit":
      return localizedCopy("Context limits", "上下文超限");
    case "content_policy":
      return localizedCopy("Content policy", "内容策略拦截");
    case "provider_unavailable":
      return localizedCopy("Upstream instability", "上游不稳定");
    case "rate_limit":
      return localizedCopy("Rate limits", "限流/额度");
    case "auth":
      return localizedCopy("Authentication", "鉴权/权限");
    case "slow_success":
      return localizedCopy("Slow successes", "成功但过慢");
  }
}

function createRootCause(kind: LLMRootCauseKind, en: string, zh: string): LLMRootCauseSummary {
  return {
    kind,
    label: labelLLMRootCauseKind(kind),
    summary: localizedCopy(en, zh),
  };
}

export function classifyLLMCallRootCause(call: ToolLLMCall): LLMRootCauseSummary | null {
  const rawMessage = call.errorMessage ?? "";
  const message = rawMessage.toLowerCase();

  if (call.status === "timeout") {
    return createRootCause(
      "timeout",
      "This call timed out. It is more likely an upstream latency or timeout-threshold issue than a problem with your manuscript content.",
      "这次调用超时了。它更像是上游模型延迟或超时阈值问题，不像是当前内容本身出错。",
    );
  }

  if (call.status === "partial") {
    return createRootCause(
      "partial",
      "The model returned part of the output and then stopped. This usually points to an interrupted upstream stream or gateway instability.",
      "模型返回了一部分输出后中断，通常更像是上游流式连接被打断，或网关本身不稳定。",
    );
  }

  if (/reasoning_content/.test(message)) {
    return createRootCause(
      "reasoning_content",
      "The upstream expects reasoning_content to be echoed back. This is usually a provider thinking-mode compatibility issue.",
      "上游要求回传 reasoning_content，这通常是服务商思维模式协议兼容问题，不是内容本身的问题。",
    );
  }

  if (/malformed_function_call|function_call_filter/.test(message)) {
    return createRootCause(
      "malformed_function_call",
      "The provider returned a malformed tool/function call. This is usually a model or gateway formatting failure.",
      "上游返回了损坏的工具调用结构，这通常是模型或网关的函数调用格式问题。",
    );
  }

  if (/empty response/.test(message)) {
    return createRootCause(
      "empty_response",
      "The model returned an empty response. This is often an upstream compatibility or gateway failure rather than a writing-content issue.",
      "模型返回了空响应，这往往更像是上游兼容或网关故障，而不是写作内容本身的问题。",
    );
  }

  if (/context length|maximum context|prompt (?:is )?too long|too many tokens|max(?:imum)? tokens/.test(message)) {
    return createRootCause(
      "context_limit",
      "The prompt likely exceeded the model's context or token budget. Shortening the input or switching to a larger-context model should help.",
      "这次请求很可能超出了模型的上下文或 token 限制。精简输入，或换用更大上下文窗口的模型，通常会更有效。",
    );
  }

  if (/content[_ ]policy|content filter|safety system|moderation|responsible ai|jailbreak/.test(message)) {
    return createRootCause(
      "content_policy",
      "The request looks blocked by an upstream safety or content-policy filter. Adjusting the prompt or switching the task framing may be required.",
      "这次请求更像是被上游的安全或内容策略拦住了。可能需要调整提示方式，或重新表述这个任务。",
    );
  }

  if (/overloaded|service unavailable|bad gateway|gateway timeout|econnreset|socket hang up|connection reset|upstream connect|connect timeout/.test(message)) {
    return createRootCause(
      "provider_unavailable",
      "The provider or gateway looks overloaded or unstable. This is more likely an upstream service issue than a problem with your content.",
      "上游模型服务或网关很像是过载或不稳定。这更像是服务本身的问题，而不是当前内容造成的。",
    );
  }

  if (/rate limit|quota|too many requests/.test(message)) {
    return createRootCause(
      "rate_limit",
      "The request likely hit an upstream quota or rate limit. Retrying later or switching models/services should help.",
      "这次请求大概率撞到了上游额度或限流。稍后重试，或切换模型/服务，通常会更有效。",
    );
  }

  if (/unauthorized|forbidden|api key|authentication|401|403/.test(message)) {
    return createRootCause(
      "auth",
      "The call looks blocked by authentication or API-key permissions. Check the selected service credentials first.",
      "这次调用更像是被鉴权或 API Key 权限拦住了，优先检查当前服务的密钥和权限配置。",
    );
  }

  if (call.status === "success" && call.durationMs >= 15_000) {
    return createRootCause(
      "slow_success",
      "This call succeeded but was unusually slow. Keep an eye on upstream latency and consider a faster model for this step.",
      "这次调用虽然成功了，但明显偏慢。建议关注上游延迟，或为这一步换成更快的模型。",
    );
  }

  return null;
}

export function summarizeLLMCallRootCause(call: ToolLLMCall): string | null {
  return classifyLLMCallRootCause(call)?.summary ?? null;
}
