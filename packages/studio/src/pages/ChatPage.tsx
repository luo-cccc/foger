import { memo, useRef, useEffect, useMemo, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import type { SSEMessage } from "../hooks/use-sse";
import { fetchJson } from "../hooks/use-api";
import type { ChatAttachmentPayload, MessagePart } from "../store/chat/types";
import { chatSelectors, useChatStore } from "../store/chat";
import type { ChatSessionKind } from "../store/chat";
import { useServiceStore } from "../store/service";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../components/ui/dropdown-menu";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "../components/ai-elements/reasoning";
import { ChatMessage } from "../components/chat/ChatMessage";
import { QuickActions } from "../components/chat/QuickActions";
import { ToolExecutionSteps, type ProposedActionDetails } from "../components/chat/ToolExecutionSteps";
import {
  BotMessageSquare,
  ArrowUp,
  ChevronDown,
  Check,
  X,
  Paperclip,
  Square,
} from "lucide-react";
import { Shimmer } from "../components/ai-elements/shimmer";
import {
  Message,
  MessageContent,
} from "../components/ai-elements/message";
import {
  type ChatPageModelPreference,
  filterModelGroups,
  getChatScrollBehavior,
  getBookCreateSessionId,
  getProjectChatSessionId,
  pickProjectChatSessionId,
  pickModelSelection,
  setBookCreateSessionId,
  setProjectChatSessionId,
  isChatScrollNearBottom,
} from "./chat-page-state";
import { summarizeLLMCallRootCause } from "../lib/error-copy";
import { buildLLMTelemetrySnapshot, type LLMCallStatus } from "../lib/llm-telemetry-display";

// -- Types --

interface Nav {
  toDashboard: () => void;
  toBook: (id: string) => void;
  toServices: () => void;
  toImport: (tab?: "chapters" | "canon") => void;
}

export interface ChatPageProps {
  readonly activeBookId?: string;
  readonly mode?: "book" | "book-create" | "project-chat";
  readonly nav: Nav;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}

interface ServiceConfigPayload {
  readonly service?: string | null;
  readonly defaultModel?: string | null;
}

const MAX_CHAT_ATTACHMENTS = 8;
const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const CHAT_ATTACHMENT_ACCEPT = [
  "image/*",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".log",
  ".pdf",
].join(",");

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

async function serializeChatAttachments(files: ReadonlyArray<File>): Promise<ChatAttachmentPayload[]> {
  return Promise.all(files.map(async (file) => ({
    id: `${file.name}-${file.size}-${file.lastModified}`,
    filename: file.name,
    mediaType: file.type || "application/octet-stream",
    size: file.size,
    dataUrl: await fileToDataUrl(file),
  })));
}

function formatFileSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${size} B`;
}

type ScrollFrameId = number | ReturnType<typeof setTimeout>;

function requestScrollFrame(callback: () => void): ScrollFrameId {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, 16);
}

function cancelScrollFrame(id: ScrollFrameId): void {
  if (typeof id === "number" && typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(id);
    return;
  }
  globalThis.clearTimeout(id);
}

type AssistantRenderItem =
  | { kind: "thinking"; pi: number; part: Extract<MessagePart, { type: "thinking" }> }
  | { kind: "text"; pi: number; part: Extract<MessagePart, { type: "text" }> }
  | { kind: "tools"; parts: Array<Extract<MessagePart, { type: "tool" }>>; startIdx: number };

function groupAssistantParts(parts: ReadonlyArray<MessagePart>): AssistantRenderItem[] {
  const items: AssistantRenderItem[] = [];
  for (let pi = 0; pi < parts.length; pi += 1) {
    const part = parts[pi];
    if (part.type === "thinking") {
      items.push({ kind: "thinking", pi, part });
    } else if (part.type === "text") {
      items.push({ kind: "text", pi, part });
    } else if (part.type === "tool") {
      const last = items[items.length - 1];
      if (last?.kind === "tools") {
        last.parts.push(part);
      } else {
        items.push({ kind: "tools", parts: [part], startIdx: pi });
      }
    }
  }
  return items;
}

const AssistantMessageParts = memo(function AssistantMessageParts({
  parts,
  timestamp,
  theme,
  onProposedAction,
  onRejectProposedAction,
}: {
  readonly parts: ReadonlyArray<MessagePart>;
  readonly timestamp: number;
  readonly theme: Theme;
  readonly onProposedAction?: (details: ProposedActionDetails) => void;
  readonly onRejectProposedAction?: (details: ProposedActionDetails) => void;
}) {
  const items = useMemo(() => groupAssistantParts(parts), [parts]);

  return (
    <>
      {items.map((item) => {
        if (item.kind === "thinking") {
          return (
            <div key={`t-${item.pi}`} className="mb-2">
              <Reasoning isStreaming={item.part.streaming}>
                <ReasoningTrigger />
                <ReasoningContent>{item.part.content}</ReasoningContent>
              </Reasoning>
            </div>
          );
        }
        if (item.kind === "tools") {
          return (
            <ToolExecutionSteps
              key={`x-${item.startIdx}`}
              executions={item.parts.map((part) => part.execution)}
              onProposedAction={onProposedAction}
              onRejectProposedAction={onRejectProposedAction}
            />
          );
        }
        if (item.kind === "text" && item.part.content) {
          return (
            <ChatMessage
              key={`c-${item.pi}`}
              role="assistant"
              content={item.part.content}
              timestamp={timestamp}
              theme={theme}
            />
          );
        }
        return null;
      })}
    </>
  );
});

// -- Component --

export function ChatPage({ activeBookId, mode = activeBookId ? "book" : "book-create", nav, theme, t, sse }: ChatPageProps) {
  // -- Store selectors --
  const messages = useChatStore(chatSelectors.activeMessages);
  const activeSession = useChatStore(chatSelectors.activeSession);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const input = useChatStore((s) => s.input);
  const loading = useChatStore(chatSelectors.isActiveSessionStreaming);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedService = useChatStore((s) => s.selectedService);
  // -- Store actions --
  const setInput = useChatStore((s) => s.setInput);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abortSession = useChatStore((s) => s.abortSession);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const createSession = useChatStore((s) => s.createSession);
  const markProposalResolved = useChatStore((s) => s.markProposalResolved);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<ScrollFrameId | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoScrollPinnedRef = useRef(true);

  const isZh = t("nav.connected") === "\u5DF2\u8FDE\u63A5";
  const hasBook = Boolean(activeBookId);
  const currentSessionKind: ChatSessionKind = activeSession?.sessionKind
    ?? (mode === "book-create" ? "book-create"
      : activeBookId ? "book" : "chat");
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const sessionTelemetry = useMemo(
    () => buildLLMTelemetrySnapshot(sse.messages, { sessionId: activeSessionId ?? undefined, limit: 3 }),
    [activeSessionId, sse.messages],
  );
  const highlightedSessionTelemetry = useMemo(
    () => sessionTelemetry.recentCalls.find((call) => summarizeLLMCallRootCause(call)) ?? null,
    [sessionTelemetry.recentCalls],
  );
  const highlightedSessionSummary = sessionTelemetry.primaryRootCause?.summary
    ?? (highlightedSessionTelemetry ? summarizeLLMCallRootCause(highlightedSessionTelemetry) : null);

  // Derived: is the assistant currently streaming/thinking/executing tools?
  const isStreaming = useMemo(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return false;
    return last.thinkingStreaming === true
      || !last.content
      || (last.toolExecutions?.some(t => t.status === "running" || t.status === "processing") ?? false);
  }, [messages]);

  // -- Model picker: read raw state, derive with useMemo (stable refs) --
  const services = useServiceStore((s) => s.services);
  const servicesLoading = useServiceStore((s) => s.servicesLoading);
  const bankModelsLoading = useServiceStore((s) => s.bankModelsLoading);
  const customModelsLoading = useServiceStore((s) => s.customModelsLoading);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchBankModels = useServiceStore((s) => s.fetchBankModels);
  const fetchCustomModels = useServiceStore((s) => s.fetchCustomModels);
  const [configuredModelSelection, setConfiguredModelSelection] = useState<ChatPageModelPreference | null>(null);
  const [serviceConfigLoaded, setServiceConfigLoaded] = useState(false);

  useEffect(() => { void fetchServices(); }, [fetchServices]);
  useEffect(() => {
    void fetchBankModels();
    void fetchCustomModels();
  }, [fetchBankModels, fetchCustomModels]);
  useEffect(() => {
    let cancelled = false;

    void fetchJson<ServiceConfigPayload>("/services/config")
      .then((payload) => {
        if (cancelled) return;
        setConfiguredModelSelection({
          service: payload.service ?? null,
          model: payload.defaultModel ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) setConfiguredModelSelection(null);
      })
      .finally(() => {
        if (!cancelled) setServiceConfigLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const modelPickerStatus = useMemo(() => {
    if (servicesLoading || services.length === 0) return "loading" as const;
    const connected = services.filter((s) => s.connected);
    if (connected.length === 0) return "no-models" as const;
    if (bankModelsLoading) return "loading" as const;
    if (connected.some((s) => (modelsByService[s.service]?.length ?? 0) > 0)) return "ready" as const;
    const hasConnectedBank = connected.some((s) => !s.service.startsWith("custom"));
    const hasConnectedCustom = connected.some((s) => s.service.startsWith("custom"));
    if (!hasConnectedBank && hasConnectedCustom && customModelsLoading) return "loading" as const;
    return "no-models" as const;
  }, [services, servicesLoading, bankModelsLoading, customModelsLoading, modelsByService]);

  const groupedModels = useMemo(() => {
    return services
      .filter((s) => s.connected && (modelsByService[s.service]?.length ?? 0) > 0)
      .map((s) => ({ service: s.service, label: s.label, models: modelsByService[s.service]! }));
  }, [services, modelsByService]);

  const selectedModelLabel = useMemo(() => {
    if (!selectedModel) return isZh ? "选择模型" : "Select model";
    const group = groupedModels.find((item) => item.service === selectedService);
    const model = group?.models.find((item) => item.id === selectedModel);
    const modelLabel = model?.name ?? selectedModel;
    return group ? `${group.label} · ${modelLabel}` : modelLabel;
  }, [groupedModels, selectedModel, selectedService, isZh]);

  // Auto-select from saved service config first, then fall back to the first available model.
  useEffect(() => {
    if (!serviceConfigLoaded) return;
    const nextSelection = pickModelSelection(
      groupedModels,
      selectedModel,
      selectedService,
      configuredModelSelection,
    );
    if (nextSelection) {
      setSelectedModel(nextSelection.model, nextSelection.service);
    }
  }, [configuredModelSelection, groupedModels, selectedModel, selectedService, serviceConfigLoaded, setSelectedModel]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Auto-scroll only while the reader is already near the bottom. Streaming
  // updates use instant scroll to avoid piling up smooth-scroll animations.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    if (!autoScrollPinnedRef.current) return undefined;

    if (scrollFrameRef.current !== null) {
      cancelScrollFrame(scrollFrameRef.current);
    }

    scrollFrameRef.current = requestScrollFrame(() => {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: getChatScrollBehavior(loading || isStreaming),
      });
      scrollFrameRef.current = null;
    });

    return () => {
      if (scrollFrameRef.current !== null) {
        cancelScrollFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [messages, loading, isStreaming]);

  useEffect(() => {
    autoScrollPinnedRef.current = true;
  }, [activeSessionId]);

  // Entering a book loads its latest session; book-create mode persists its orphan session in localStorage.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!activeBookId && mode === "project-chat") {
        const state = useChatStore.getState();
        const currentSession = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
        if (currentSession?.bookId === null && currentSession.isDraft) {
          return;
        }
      }

      if (activeBookId) {
        await loadSessionList(activeBookId);
        if (cancelled) return;

        const state = useChatStore.getState();
        const currentSession = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
        if (currentSession?.bookId === activeBookId) {
          await loadSessionDetail(currentSession.sessionId);
          return;
        }
        const ids = state.sessionIdsByBook[activeBookId] ?? [];
        if (ids.length > 0) {
          activateSession(ids[0]);
          await loadSessionDetail(ids[0]);
          return;
        }

        await createSession(activeBookId, "book");
        return;
      }

      const existingId = mode === "project-chat"
        ? getProjectChatSessionId()
        : getBookCreateSessionId();
      if (existingId) {
        await loadSessionDetail(existingId);
        if (cancelled) return;

        const state = useChatStore.getState();
        const session = state.sessions[existingId];
        if (session && session.bookId === null && (mode !== "project-chat" || session.messages.length > 0)) {
          activateSession(existingId);
          return;
        }
      }

      if (mode === "project-chat") {
        const projectSessions = await loadSessionList(null);
        if (cancelled) return;

        const reusableSessionId = pickProjectChatSessionId(projectSessions);
        if (reusableSessionId) {
          activateSession(reusableSessionId);
          await loadSessionDetail(reusableSessionId);
          if (!cancelled) setProjectChatSessionId(reusableSessionId);
          return;
        }
      }

      const newSessionId = await createSession(null, mode === "book-create" ? "book-create" : "chat");
      if (!cancelled) {
        if (mode === "project-chat") {
          setProjectChatSessionId(newSessionId);
        } else {
          setBookCreateSessionId(newSessionId);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeBookId, activateSession, createSession, loadSessionDetail, loadSessionList, mode]);

  const addAttachedFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files);
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of incoming) {
      if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
        rejected.push(`${file.name} > ${formatFileSize(MAX_CHAT_ATTACHMENT_BYTES)}`);
        continue;
      }
      accepted.push(file);
    }
    setAttachedFiles((prev) => [...prev, ...accepted].slice(0, MAX_CHAT_ATTACHMENTS));
    setAttachmentError(rejected.length > 0
      ? (isZh ? `以下文件过大，未添加：${rejected.join("、")}` : `Some files were too large: ${rejected.join(", ")}`)
      : null);
  };

  const onSend = async (text: string) => {
    if (!activeSessionId) return;
    const hasPendingMessage = Boolean(text.trim()) || attachedFiles.length > 0;
    if (!hasPendingMessage) {
      if (loading) await abortSession(activeSessionId);
      return;
    }
    autoScrollPinnedRef.current = true;
    const attachments = await serializeChatAttachments(attachedFiles);
    if (loading) {
      await abortSession(activeSessionId);
    }
    await sendMessage(activeSessionId, text, {
      activeBookId,
      sessionKind: currentSessionKind,
      actionSource: "free-text",
      attachments,
    });
    setAttachedFiles([]);
    setAttachmentError(null);
  };

  const handleQuickAction = (command: string, requestedIntent?: "write_next") => {
    if (!activeSessionId) return;
    autoScrollPinnedRef.current = true;
    void sendMessage(activeSessionId, command, {
      activeBookId,
      sessionKind: currentSessionKind,
      actionSource: "quick-action",
      requestedIntent,
    });
  };

  const handleProposedAction = async (details: ProposedActionDetails) => {
    // Lock the proposal card so the production action can't be re-fired.
    markProposalResolved(details.execId, "confirmed");
    if (details.targetRoute) {
      if (details.targetRoute === "import:chapters") nav.toImport("chapters");
      else if (details.targetRoute === "import:canon") nav.toImport("canon");
      return;
    }
    if (details.sameSession && activeSessionId) {
      autoScrollPinnedRef.current = true;
      await sendMessage(activeSessionId, details.instruction ?? "", {
        activeBookId,
        sessionKind: details.targetSessionKind,
        actionSource: "button",
        requestedIntent: details.action,
        actionPayload: details.actionPayload,
      });
      return;
    }
    const targetSessionId = await createSession(null, details.targetSessionKind);
    autoScrollPinnedRef.current = true;
    await sendMessage(targetSessionId, details.instruction ?? "", {
      sessionKind: details.targetSessionKind,
      actionSource: "button",
      requestedIntent: details.action,
      actionPayload: details.actionPayload,
    });
  };

  const handleRejectProposedAction = async (details: ProposedActionDetails) => {
    markProposalResolved(details.execId, "rejected");
    if (!activeSessionId) return;
    autoScrollPinnedRef.current = true;
    const rejectionText = isZh
      ? `取消这次操作：${details.title ?? details.instruction}`
      : `Cancel this action: ${details.title ?? details.instruction}`;
    await sendMessage(activeSessionId, rejectionText, {
      activeBookId,
      sessionKind: currentSessionKind,
      actionSource: "button",
    });
  };

  const emptyGuidance = (() => {
    return isZh
      ? "\u544A\u8BC9\u6211\u4F60\u60F3\u5199\u4EC0\u4E48\u2014\u2014\u9898\u6750\u3001\u4E16\u754C\u89C2\u3001\u4E3B\u89D2\u3001\u6838\u5FC3\u51B2\u7A81"
      : "Tell me what you want to write \u2014 genre, world, protagonist, core conflict";
  })();

  return (
    <div className="flex flex-col h-full flex-1 min-w-0 relative">
      {/* Message scroll area */}
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          autoScrollPinnedRef.current = isChatScrollNearBottom({
            scrollTop: target.scrollTop,
            clientHeight: target.clientHeight,
            scrollHeight: target.scrollHeight,
          });
        }}
        className="chat-message-scroll flex-1 overflow-y-auto [scrollbar-gutter:stable] px-4 py-6"
      >
        {messages.length === 0 && !loading ? (
          <div className="h-full flex flex-col items-center justify-center text-center select-none">
            <div className="w-14 h-14 rounded-2xl border border-dashed border-border flex items-center justify-center mb-4 bg-secondary/30 opacity-40">
              <BotMessageSquare size={24} className="text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground/70 max-w-md leading-7">
              {emptyGuidance}
            </p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-4">
            {sessionTelemetry.totalCalls > 0 && (
              <div className="rounded-2xl border border-primary/15 bg-primary/[0.04] px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-primary uppercase tracking-wide">
                    {isZh ? "本会话 LLM 遥测" : "Session LLM Telemetry"}
                  </span>
                  <span className="rounded-full bg-background/70 px-2 py-1 text-muted-foreground">
                    {sessionTelemetry.totalCalls} {isZh ? "次调用" : "calls"}
                  </span>
                  <span className="rounded-full bg-background/70 px-2 py-1 text-muted-foreground">
                    {sessionTelemetry.totalTokens.toLocaleString()} tok
                  </span>
                  {sessionTelemetry.failedCalls > 0 && (
                    <span className="rounded-full bg-destructive/10 px-2 py-1 text-destructive">
                      {sessionTelemetry.failedCalls} {isZh ? "失败" : "failed"}
                    </span>
                  )}
                  {sessionTelemetry.partialCalls > 0 && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-1 text-amber-700">
                      {sessionTelemetry.partialCalls} partial
                    </span>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    {isZh ? "最长" : "longest"} {Math.round(sessionTelemetry.longestCallMs / 100) / 10}s
                  </span>
                </div>
                <div className="mt-3 space-y-2">
                  {highlightedSessionSummary && (
                    <div className="rounded-xl border border-border/30 bg-background/65 px-3 py-2 text-[11px] leading-5 text-foreground/85">
                      <div className="font-medium text-foreground/90">
                        {sessionTelemetry.primaryRootCause?.label ?? (isZh ? "需要关注" : "Needs attention")}
                      </div>
                      <div className="mt-1">
                        {highlightedSessionSummary}
                      </div>
                    </div>
                  )}
                  {sessionTelemetry.topRootCauses.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {sessionTelemetry.topRootCauses.map((cause) => (
                        <span
                          key={cause.kind}
                          className="rounded-full border border-border/30 bg-background/65 px-2 py-1 text-[10px] text-foreground/80"
                        >
                          {cause.label} · {cause.count}
                        </span>
                      ))}
                    </div>
                  )}
                  {sessionTelemetry.recentCalls.map((call, index) => (
                    <div key={`${call.timestamp}-${index}`} className="rounded-xl border border-border/40 bg-background/60 px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className={`rounded-full px-2 py-0.5 font-semibold uppercase ${telemetryTone(call.status)}`}>
                          {call.status}
                        </span>
                        <span className="font-medium">{call.agent}</span>
                        <span className="text-muted-foreground">/ {call.phase}</span>
                        <span className="text-muted-foreground">{call.service}</span>
                        <span className="text-muted-foreground">{call.model}</span>
                        <span className="ml-auto text-muted-foreground">
                          {Math.round(call.durationMs / 100) / 10}s
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span>{call.totalTokens.toLocaleString()} tok</span>
                        {call.timeoutMs !== undefined && <span>{call.timeoutMs}ms timeout</span>}
                        {call.partialContentLength !== undefined && <span>{call.partialContentLength} chars partial</span>}
                      </div>
                      {summarizeLLMCallRootCause(call) && (
                        <div className="mt-1.5 rounded-md border border-border/30 bg-card/70 px-2 py-1.5 text-[11px] leading-5 text-foreground/85">
                          {summarizeLLMCallRootCause(call)}
                        </div>
                      )}
                      {call.errorMessage && (
                        <div className="mt-1.5 text-[11px] leading-5 text-destructive break-words">
                          {call.errorMessage}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={`${msg.timestamp}-${i}`}>
                {msg.role === "user" ? (
                  /* User message */
                  <ChatMessage role="user" content={msg.content} timestamp={msg.timestamp} theme={theme} />
                ) : msg.parts && msg.parts.length > 0 ? (
                  /* Assistant message — parts-based rendering (chronological) */
                  /* Merge consecutive utility tool parts into one group */
                  <>
                    {(() => {
                      type RenderItem =
                        | { kind: "thinking"; pi: number; part: Extract<typeof msg.parts[0], { type: "thinking" }> }
                        | { kind: "text"; pi: number; part: Extract<typeof msg.parts[0], { type: "text" }> }
                        | { kind: "tools"; parts: Array<Extract<typeof msg.parts[0], { type: "tool" }>>; startIdx: number };

                      const items: RenderItem[] = [];
                      for (let pi = 0; pi < msg.parts!.length; pi++) {
                        const part = msg.parts![pi];
                        if (part.type === "thinking") {
                          items.push({ kind: "thinking", pi, part });
                        } else if (part.type === "text") {
                          items.push({ kind: "text", pi, part });
                        } else if (part.type === "tool") {
                          // Merge consecutive tool parts into one group
                          const last = items[items.length - 1];
                          if (last?.kind === "tools") {
                            last.parts.push(part);
                          } else {
                            items.push({ kind: "tools", parts: [part], startIdx: pi });
                          }
                        }
                      }

                      return items.map((item) => {
                        if (item.kind === "thinking") {
                          return (
                            <div key={`t-${item.pi}`} className="mb-2">
                              <Reasoning isStreaming={item.part.streaming}>
                                <ReasoningTrigger />
                                <ReasoningContent>{item.part.content}</ReasoningContent>
                              </Reasoning>
                            </div>
                          );
                        }
                        if (item.kind === "tools") {
                          return (
                            <ToolExecutionSteps
                              key={`x-${item.startIdx}`}
                              executions={item.parts.map(p => p.execution)}
                              onProposedAction={handleProposedAction}
                              onRejectProposedAction={handleRejectProposedAction}
                            />
                          );
                        }
                        if (item.kind === "text" && item.part.content) {
                          return (
                            <ChatMessage
                              key={`c-${item.pi}`}
                              role="assistant"
                              content={item.part.content}
                              timestamp={msg.timestamp}
                              theme={theme}
                            />
                          );
                        }
                        return null;
                      });
                    })()}
                  </>
                ) : (
                  /* Assistant message — fallback (no parts, e.g. error messages) */
                  <ChatMessage
                    role={msg.role}
                    content={msg.content}
                    timestamp={msg.timestamp}
                    theme={theme}
                  />
                )}
              </div>
            ))}

            {/* Loading indicator — only when loading and no streaming activity */}
            {loading && !isStreaming && (
              <Message from="assistant">
                <MessageContent>
                  <Shimmer className="text-sm" duration={1.5}>
                    {isZh ? "思考中..." : "Thinking..."}
                  </Shimmer>
                </MessageContent>
              </Message>
            )}

          </div>
        )}
      </div>

      {/* Quick actions (only when a book is active) */}
      {hasBook && (
        <div className="shrink-0">
          <div className="max-w-3xl mx-auto w-full px-4">
            <QuickActions
              onAction={handleQuickAction}
              disabled={loading || !activeSessionId}
              isZh={isZh}
            />
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-border/40 px-4 py-3">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-start gap-2">
            <div className="relative flex-1 rounded-xl bg-secondary/30 transition-all">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={CHAT_ATTACHMENT_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  if (event.currentTarget.files) addAttachedFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              {attachedFiles.length > 0 || attachmentError ? (
                <div className="border-b border-border/20 px-3 py-2">
                  {attachedFiles.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {attachedFiles.map((file) => (
                        <span
                          key={`${file.name}-${file.size}-${file.lastModified}`}
                          className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-border/50 bg-secondary/60 px-2.5 py-1 text-xs text-muted-foreground"
                          title={`${file.name} · ${file.type || "application/octet-stream"} · ${formatFileSize(file.size)}`}
                        >
                          <Paperclip size={12} />
                          <span className="truncate">{file.name}</span>
                          <button
                            type="button"
                            onClick={() => setAttachedFiles((prev) => prev.filter((item) => item !== file))}
                            className="rounded-full p-0.5 hover:bg-muted"
                            aria-label={isZh ? `移除 ${file.name}` : `Remove ${file.name}`}
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {attachmentError ? (
                    <div className="mt-1 text-xs leading-5 text-destructive">{attachmentError}</div>
                  ) : null}
                </div>
              ) : null}
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!activeSessionId}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/50 text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-30"
                  title={isZh ? "上传图片或资料" : "Attach files"}
                  aria-label={isZh ? "上传图片或资料" : "Attach files"}
                >
                  <Paperclip size={16} strokeWidth={2.3} />
                </button>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onSend(input); } }}
                  placeholder={isZh ? "输入指令..." : "Enter command..."}
                  disabled={!activeSessionId}
                  rows={1}
                  className="flex-1 bg-transparent text-base leading-7 placeholder:text-muted-foreground/50 outline-none! border-none! ring-0! shadow-none focus:outline-none! focus:ring-0! focus:border-none! resize-none disabled:opacity-50 max-h-[200px] overflow-y-auto"
                />
                <button
                  type="button"
                  onClick={() => void onSend(input)}
                  disabled={(!input.trim() && attachedFiles.length === 0 && !loading) || !activeSessionId}
                  className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shrink-0 hover:scale-105 active:scale-95 transition-all disabled:opacity-20 disabled:scale-100 shadow-sm shadow-primary/20"
                  title={loading && !input.trim() && attachedFiles.length === 0 ? (isZh ? "停止当前回复" : "Stop") : undefined}
                >
                  {loading && !input.trim() && attachedFiles.length === 0
                    ? <Square size={13} fill="currentColor" />
                    : <ArrowUp size={14} strokeWidth={2.5} />}
                </button>
              </div>
              <div className="flex items-center gap-2 px-3 pb-2 border-t border-border/20 pt-1.5">
                {modelPickerStatus === "loading" ? (
                  <span className="text-[15px] text-muted-foreground/40 animate-pulse">{isZh ? "加载模型..." : "Loading models..."}</span>
                ) : modelPickerStatus === "ready" ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger className="flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-muted text-[16px] transition-colors cursor-pointer">
                      <span className="font-medium truncate max-w-[260px]">
                        {selectedModelLabel}
                      </span>
                      <ChevronDown size={17} className="text-muted-foreground" />
                    </DropdownMenuTrigger>
                    <ModelPickerContent
                      groupedModels={groupedModels}
                      selectedModel={selectedModel}
                      selectedService={selectedService}
                      onSelect={setSelectedModel}
                      onManage={() => nav.toServices()}
                    />
                  </DropdownMenu>
                ) : (
                  <button
                    onClick={() => nav.toServices()}
                    className="text-[15px] text-muted-foreground/50 hover:text-primary transition-colors"
                  >
                    {isZh ? "配置模型 →" : "Set up models →"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function telemetryTone(status: LLMCallStatus): string {
  if (status === "success") return "text-emerald-600 bg-emerald-500/10";
  if (status === "partial") return "text-amber-700 bg-amber-500/10";
  return "text-destructive bg-destructive/10";
}

function ModelPickerContent({
  groupedModels,
  selectedModel,
  selectedService,
  onSelect,
  onManage,
}: {
  groupedModels: ReadonlyArray<{ service: string; label: string; models: ReadonlyArray<{ id: string; name?: string }> }>;
  selectedModel: string | null;
  selectedService: string | null;
  onSelect: (model: string, service: string) => void;
  onManage: () => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => filterModelGroups(groupedModels, search), [groupedModels, search]);

  return (
    <DropdownMenuContent side="top" align="start" className="w-64 max-h-80 flex flex-col">
      <div className="px-2 py-1.5 border-b border-border/30">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索模型..."
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/40"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="overflow-y-auto flex-1">
        {filtered.map((group) => (
          <div key={group.service}>
            <div className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              {group.label}
            </div>
            {group.models.map((m) => {
              const isSelected = selectedModel === m.id && selectedService === group.service;
              return (
                <DropdownMenuItem
                  key={`${group.service}:${m.id}`}
                  onClick={() => onSelect(m.id, group.service)}
                  className={isSelected ? "bg-muted/50" : ""}
                >
                  <div className="flex flex-1 items-center justify-between">
                    <span className="text-sm">{m.name ?? m.id}</span>
                    {isSelected && <Check size={14} className="text-primary shrink-0" />}
                  </div>
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground/50 text-center italic">
            无匹配模型
          </div>
        )}
      </div>
      <div className="border-t border-border/30">
        <DropdownMenuItem onClick={onManage} className="text-primary">
          管理服务商
        </DropdownMenuItem>
      </div>
    </DropdownMenuContent>
  );
}
