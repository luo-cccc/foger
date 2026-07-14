import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import type { BookSummary } from "../shared/contracts.js";
import {
  StateManager,
  SessionIdSchema,
  mutateProjectConfig,
  PipelineRunner,
  ChapterMutationChapterNotFoundError,
  CoreMutationBookNotFoundError,
  CoreMutationValidationError,
  executeCoreMutation,
  assertSafeTruthFileName,
  createLLMClient,
  createLogger,
  createInteractionToolsFromDeps,
  computeAnalytics,
  loadProjectConfig,
  loadProjectSession,
  processProjectInteractionRequest,
  resolveSessionActiveBook,
  listBookSessions,
  loadBookSession,
  appendManualSessionMessages,
  createAndPersistBookSession,
  renameBookSession,
  deleteBookSession,
  migrateBookSession,
  SessionAlreadyMigratedError,
  abortAgentSession,
  runAgentSession,
  resolveServicePreset,
  resolveServiceProviderFamily,
  resolveServiceModelsBaseUrl,
  guessServiceFromBaseUrl,
  resolveServiceModel,
  loadSecrets,
  saveSecrets,
  listModelsForService,
  isApiKeyOptionalForEndpoint,
  getAllEndpoints,
  probeModelsFromUpstream,
  fetchWithProxy,
  chatCompletion,
  buildExportArtifact,
  evaluateBookQuality,
  ConsolidatorAgent,
  DetectionConfigSchema,
  KNOWN_MODEL_ROUTING_AGENTS,
  PHASE7_MODEL_ROUTING_AGENTS,
  loadLLMEnvLayers,
  resolveLLMTimeoutMs,
  resolveEffectiveLLMConfig,
  ReviseModeSchema,
  InputGovernanceModeSchema,
  GLOBAL_ENV_PATH,
  Scheduler,
  SessionKindSchema,
  isExplicitWriteChapterCommand,
  isWriteNextInstruction,
  normalizeActionSource as normalizeCoreActionSource,
  normalizeActionPayload as normalizeCoreActionPayload,
  normalizeRequestedIntent as normalizeCoreRequestedIntent,

  inferLanguage,
  deriveBookIdFromTitle,
  isBookFoundationComplete,
  toPosixPath,
  type ActionPayload,
  type ActionSource,
  createSubAgentTool,
  type ResolvedModel,
  type PipelineConfig,
  type ProjectConfig,
  type LogSink,
  type LogEntry,
  type RequestedIntent,
  type SessionKind,
  type AgentSessionAttachment,
} from "@actalk/inkos-core";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isSafeBookId } from "./safety.js";
import { ApiError } from "./errors.js";
import { buildStudioBookConfig } from "./book-create.js";

// -- Studio server language (read per request from the project config's `language`) --

type StudioLanguage = "zh" | "en";

function normalizeStudioLanguage(value: unknown): StudioLanguage {
  return value === "en" ? "en" : "zh";
}

function pick(lang: StudioLanguage, zh: string, en: string): string {
  return lang === "en" ? en : zh;
}

// -- Pipeline stage definitions per agent type --

interface BilingualLabel {
  readonly zh: string;
  readonly en: string;
}

const PIPELINE_STAGES: Record<string, ReadonlyArray<BilingualLabel>> = {
  writer: [
    { zh: "准备章节输入", en: "Prepare chapter input" },
    { zh: "撰写章节草稿", en: "Write chapter draft" },
    { zh: "落盘最终章节", en: "Save final chapter" },
    { zh: "生成最终真相文件", en: "Generate final truth files" },
    { zh: "校验真相文件变更", en: "Validate truth file changes" },
    { zh: "同步记忆索引", en: "Sync memory index" },
    { zh: "更新章节索引与快照", en: "Update chapter index and snapshot" },
  ],
  architect: [
    { zh: "生成基础设定", en: "Generate foundation" },
    { zh: "保存书籍配置", en: "Save book config" },
    { zh: "写入基础设定文件", en: "Write foundation files" },
    { zh: "初始化控制文档", en: "Initialize control documents" },
    { zh: "创建初始快照", en: "Create initial snapshot" },
  ],
  reviser: [
    { zh: "加载修订上下文", en: "Load revision context" },
    { zh: "修订章节", en: "Revise chapter" },
    { zh: "落盘修订结果", en: "Save revision result" },
    { zh: "更新索引与快照", en: "Update index and snapshot" },
  ],
  auditor: [{ zh: "审计章节", en: "Audit chapter" }],
};

function pipelineStages(agent: string, lang: StudioLanguage = "zh"): string[] | undefined {
  return PIPELINE_STAGES[agent]?.map((stage) => pick(lang, stage.zh, stage.en));
}

function attachmentDisposition(fileName: string): string {
  const safeAscii = fileName.replace(/[^A-Za-z0-9._-]+/g, "_") || "download";
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

const AGENT_LABELS: Record<string, BilingualLabel> = {
  architect: { zh: "建书", en: "Book setup" },
  writer: { zh: "写作", en: "Writing" },
  auditor: { zh: "审计", en: "Audit" },
  reviser: { zh: "修订", en: "Revision" },
  exporter: { zh: "导出", en: "Export" },
};
const TOOL_LABELS: Record<string, BilingualLabel> = {
  read: { zh: "读取文件", en: "Read file" },
  edit: { zh: "编辑文件", en: "Edit file" },
  grep: { zh: "搜索", en: "Search" },
  ls: { zh: "列目录", en: "List directory" },
  propose_action: { zh: "确认动作", en: "Confirm action" },
};

function resolveToolLabel(tool: string, agent?: string, lang: StudioLanguage = "zh"): string {
  if (tool === "sub_agent" && agent) {
    const label = AGENT_LABELS[agent];
    return label ? pick(lang, label.zh, label.en) : agent;
  }
  const label = TOOL_LABELS[tool];
  return label ? pick(lang, label.zh, label.en) : tool;
}

function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 2000);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content.slice(0, 2000);
    if (typeof r.text === "string") return r.text.slice(0, 2000);
  }
  return String(result).slice(0, 2000);
}

function compareServiceListItems(
  left: { readonly service: string },
  right: { readonly service: string },
): number {
  const priority = ["kkaiapi", "openrouter", "newapi", "siliconcloud"];
  const leftPriority = priority.indexOf(left.service);
  const rightPriority = priority.indexOf(right.service);
  if (leftPriority !== -1 || rightPriority !== -1) {
    return (leftPriority === -1 ? 999 : leftPriority) - (rightPriority === -1 ? 999 : rightPriority);
  }
  return 0;
}

async function buildTarArchive(sourceDir: string, packageRootName: string): Promise<Buffer> {
  const files = await listArchiveFiles(sourceDir);
  const chunks: Buffer[] = [];
  for (const file of files) {
    const payload = await readFile(join(sourceDir, file));
    const archiveName = normalizeArchivePath(join(packageRootName, file));
    chunks.push(createTarHeader(archiveName, payload.byteLength));
    chunks.push(payload);
    const padding = (512 - (payload.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function listArchiveFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listArchiveFiles(fullPath, relativePath));
    } else if (entry.isFile()) {
      files.push(normalizeArchivePath(relativePath));
    } else {
      const info = await stat(fullPath).catch(() => null);
      if (info?.isFile()) files.push(normalizeArchivePath(relativePath));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function normalizeArchivePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/g, "");
}

function createTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarOctal(header, 148, 8, checksum);
  return header;
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value);
  if (encoded.byteLength > length) {
    throw new Error(`Archive path is too long for tar header: ${value}`);
  }
  encoded.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function isHeaderSafeApiKey(value: string): boolean {
  if (!value) return true;
  return /^[\x21-\x7E]+$/.test(value);
}

const NON_TEXT_MODEL_ID_PARTS = [
  "image",
  "embedding",
  "embed",
  "rerank",
  "tts",
  "speech",
  "audio",
  "moderation",
] as const;

const SERVICE_MODELS_PROBE_TIMEOUT_MS = 4_000;
const SERVICE_CHAT_PROBE_TIMEOUT_MS = 8_000;
// Hard ceiling for the whole /doctor connectivity probe (models + chat fallback
// loop) so the diagnostics page never spins on a slow/rate-limited upstream.
const DOCTOR_LLM_PROBE_BUDGET_MS = 9_000;
const MAX_DISCOVERED_MODELS_TO_PING = 2;
const MAX_GENERIC_FALLBACK_MODELS_TO_PING = 2;

function isTextChatModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  return !NON_TEXT_MODEL_ID_PARTS.some((part) => normalized.includes(part));
}

function filterTextChatModels<T extends { readonly id: string }>(models: ReadonlyArray<T>): T[] {
  return models.filter((model) => isTextChatModelId(model.id));
}

function normalizeApiBookId(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_BOOK_ID", `${fieldName} must be a string`);
  }
  const bookId = value.trim();
  if (!bookId) {
    throw new ApiError(400, "INVALID_BOOK_ID", `${fieldName} cannot be blank`);
  }
  if (!isSafeBookId(bookId)) {
    throw new ApiError(400, "INVALID_BOOK_ID", `Invalid ${fieldName}: "${bookId}"`);
  }
  return bookId;
}

function nonTextModelMessage(modelId: string, lang: StudioLanguage = "zh"): string {
  return pick(
    lang,
    `模型 ${modelId} 不适合文本聊天/写作。请在模型选择器中改用文本模型，例如 gemini-2.5-flash、gemini-2.5-pro 或对应服务的 chat 模型。`,
    `Model ${modelId} is not suitable for text chat/writing. Pick a text model in the model selector, e.g. gemini-2.5-flash, gemini-2.5-pro, or the service's chat model.`,
  );
}

function extractToolError(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 500);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content.slice(0, 500);
    if (r.content && Array.isArray(r.content)) {
      const textPart = r.content.find((c: any) => c.type === "text");
      if (textPart) return (textPart as any).text?.slice(0, 500) ?? "";
    }
  }
  return String(result).slice(0, 500);
}

function isLikelyFailedToolResult(exec: CollectedToolExec): boolean {
  if (exec.status === "error") return true;
  const text = `${exec.error ?? ""}\n${exec.result ?? ""}`.toLowerCase();
  return /\bfailed\b|\berror\b|失败|异常|出错/.test(text);
}

function hasSuccessfulSubAgentExec(
  execs: ReadonlyArray<CollectedToolExec>,
  agent: string,
): boolean {
  return execs.some((exec) =>
    exec.tool === "sub_agent"
    && exec.agent === agent
    && exec.status === "completed"
    && !isLikelyFailedToolResult(exec)
  );
}

function hasSuccessfulToolExec(
  execs: ReadonlyArray<CollectedToolExec>,
  tool: string,
): boolean {
  return execs.some((exec) =>
    exec.tool === tool
    && exec.status === "completed"
    && !isLikelyFailedToolResult(exec)
  );
}

function hasSuccessfulToolResult(execs: ReadonlyArray<CollectedToolExec>): boolean {
  return execs.some((exec) => exec.status === "completed" && !isLikelyFailedToolResult(exec));
}

function normalizeStudioSessionKind(value: unknown, fallback: SessionKind): SessionKind {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = SessionKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_SESSION_KIND", `Invalid sessionKind: ${String(value)}`);
  }
  return parsed.data;
}

function normalizeStudioActionSource(value: unknown): ActionSource {
  try {
    return normalizeCoreActionSource(value);
  } catch {
    throw new ApiError(400, "INVALID_ACTION_SOURCE", `Invalid actionSource: ${String(value)}`);
  }
}

function normalizeStudioRequestedIntent(value: unknown): RequestedIntent | undefined {
  try {
    return normalizeCoreRequestedIntent(value);
  } catch {
    throw new ApiError(400, "INVALID_REQUESTED_INTENT", `Invalid requestedIntent: ${String(value)}`);
  }
}

function normalizeStudioActionPayload(value: unknown): ActionPayload | undefined {
  try {
    return normalizeCoreActionPayload(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(400, "INVALID_ACTION_PAYLOAD", `Invalid actionPayload: ${message}`);
  }
}

type StudioAgentAttachmentPayload = {
  readonly id?: string;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly size?: number;
  readonly dataUrl?: string;
};

const MAX_AGENT_ATTACHMENTS = 8;
const MAX_AGENT_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_AGENT_ATTACHMENT_TEXT_CHARS = 120_000;

function safeUploadFileName(value: string): string {
  const trimmed = value.trim().replace(/[/\\\0]/g, "_").replace(/\s+/g, " ");
  const safe = trimmed.replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 120).trim();
  return safe || "upload";
}

function isTextAttachment(filename: string, mimeType: string): boolean {
  const lower = filename.toLowerCase();
  return mimeType.startsWith("text/")
    || [
      ".txt",
      ".md",
      ".markdown",
      ".json",
      ".csv",
      ".tsv",
      ".yaml",
      ".yml",
      ".log",
    ].some((suffix) => lower.endsWith(suffix));
}

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new ApiError(400, "INVALID_ATTACHMENT_DATA_URL", "Attachment must be a base64 data URL");
  }
  const mimeType = match[1]?.trim() || "application/octet-stream";
  return { mimeType, buffer: Buffer.from(match[2] ?? "", "base64") };
}

async function normalizeAgentAttachments(
  root: string,
  sessionId: string,
  value: unknown,
): Promise<AgentSessionAttachment[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(400, "INVALID_ATTACHMENTS", "attachments must be an array");
  }
  if (value.length > MAX_AGENT_ATTACHMENTS) {
    throw new ApiError(413, "TOO_MANY_ATTACHMENTS", `At most ${MAX_AGENT_ATTACHMENTS} files can be attached to one message`);
  }

  const uploadDir = join(root, ".inkos", "uploads", safeUploadFileName(sessionId));
  const out: AgentSessionAttachment[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "INVALID_ATTACHMENT", "Each attachment must be an object");
    }
    const payload = raw as StudioAgentAttachmentPayload;
    const filename = safeUploadFileName(payload.filename || `upload-${index + 1}`);
    if (!payload.dataUrl) {
      throw new ApiError(400, "INVALID_ATTACHMENT", `Attachment ${filename} is missing dataUrl`);
    }
    const parsed = parseDataUrl(payload.dataUrl);
    const mimeType = payload.mediaType?.trim() || parsed.mimeType;
    if (parsed.buffer.byteLength > MAX_AGENT_ATTACHMENT_BYTES) {
      throw new ApiError(413, "ATTACHMENT_TOO_LARGE", `${filename} exceeds ${MAX_AGENT_ATTACHMENT_BYTES} bytes`);
    }
    await mkdir(uploadDir, { recursive: true });
    const storedName = `${Date.now()}-${index + 1}-${filename}`;
    const storedPath = join(uploadDir, storedName);
    await writeFile(storedPath, parsed.buffer);
    const relPath = relative(root, storedPath);

    if (mimeType.startsWith("image/")) {
      out.push({
        id: payload.id || `${Date.now()}-${index}`,
        filename,
        mimeType,
        size: parsed.buffer.byteLength,
        storedPath: relPath,
        image: {
          data: parsed.buffer.toString("base64"),
          mimeType,
        },
      });
      continue;
    }

    if (isTextAttachment(filename, mimeType)) {
      const text = parsed.buffer.toString("utf-8");
      if (text.length > MAX_AGENT_ATTACHMENT_TEXT_CHARS) {
        throw new ApiError(413, "ATTACHMENT_TEXT_TOO_LARGE", `${filename} is too large to inject without semantic compaction`);
      }
      out.push({
        id: payload.id || `${Date.now()}-${index}`,
        filename,
        mimeType,
        size: parsed.buffer.byteLength,
        storedPath: relPath,
        text,
      });
      continue;
    }

    out.push({
      id: payload.id || `${Date.now()}-${index}`,
      filename,
      mimeType,
      size: parsed.buffer.byteLength,
      storedPath: relPath,
    });
  }
  return out;
}

function shouldRunDirectWriteNext(args: {
  readonly instruction: string;
  readonly agentBookId: string | null | undefined;
  readonly sessionKind: SessionKind;
  readonly actionSource: ActionSource;
  readonly requestedIntent?: RequestedIntent;
}): boolean {
  if (!args.agentBookId || args.sessionKind !== "book") return false;
  if (args.requestedIntent === "write_next") return true;
  if (args.actionSource === "free-text") return isExplicitWriteChapterCommand(args.instruction);
  return isWriteNextInstruction(args.instruction);
}

type ExternalChatEditResult = {
  readonly responseText: string;
  readonly activeBookId?: string;
};

const CHAT_EDIT_TEXT_EXTENSIONS = /\.(md|txt|json|ya?ml)$/i;
const CHAT_EDIT_ALLOWED_ROOTS = new Set(["books", "genres"]);

function parseReplacementInstruction(instruction: string): { oldText: string; newText: string } | null {
  const inFileQuoted = instruction.match(/(?:里|里的|中|中的|里面)\s*[「“"]([\s\S]+?)[」”"]\s*(?:改成|替换成|换成)\s*[「“"]([\s\S]+?)[」”"]/);
  if (inFileQuoted?.[1] && inFileQuoted[2] !== undefined) {
    return { oldText: inFileQuoted[1], newText: inFileQuoted[2] };
  }
  const quoted = instruction.match(/(?:把|将)\s*[「“"]([\s\S]+?)[」”"]\s*(?:改成|替换成|换成)\s*[「“"]([\s\S]+?)[」”"]/);
  if (quoted?.[1] && quoted[2] !== undefined) {
    return { oldText: quoted[1], newText: quoted[2] };
  }
  const plain = instruction.match(/(?:把|将)\s+([^\s，。；;]+)\s*(?:改成|替换成|换成)\s+([^\n，。；;]+)/);
  if (plain?.[1] && plain[2] !== undefined) {
    return { oldText: plain[1], newText: plain[2].trim() };
  }
  return null;
}

function isExplicitExternalChatEditInstruction(instruction: string): boolean {
  const trimmed = instruction.trim();
  if (!trimmed) return false;
  if (/[?？]\s*$/.test(trimmed)) return false;
  if (/^(?:请问|能否|能不能|可以|可不可以|是否|是不是|怎么|怎样|为什么|如果|假如|要不要|建议|讨论)\b/u.test(trimmed)) {
    return false;
  }

  const imperative = trimmed.replace(/^(?:请|麻烦|帮我|直接|现在)\s*/u, "");
  return /^(?:第\s*\d{1,4}\s*章\s*)?(?:把|将)\s*/u.test(imperative);
}

function parseChapterNumberForEdit(instruction: string): number | null {
  const match = instruction.match(/第\s*(\d{1,4})\s*章/);
  if (!match?.[1]) return null;
  const chapterNumber = Number.parseInt(match[1], 10);
  return Number.isInteger(chapterNumber) && chapterNumber > 0 ? chapterNumber : null;
}

function parseExplicitEditPath(instruction: string): string | null {
  const match = instruction.match(/(?:把|将)\s+([^「“"\s，。；;]+?\.[A-Za-z0-9]+)\s*(?:里|里的|中|中的|里面)/);
  return match?.[1]?.trim() ?? null;
}

function resolveExternalChatEditPath(root: string, requestedPath: string): { path: string; rel: string } {
  if (isAbsolute(requestedPath)) {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits only support project-relative content paths.");
  }
  const projectRoot = resolve(root);
  const resolved = resolve(projectRoot, requestedPath);
  const rel = relative(projectRoot, resolved).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === "..") {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edit path escapes the project root.");
  }
  const first = rel.split("/")[0] ?? "";
  if (!CHAT_EDIT_ALLOWED_ROOTS.has(first)) {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits cannot modify source code, config, or arbitrary project files.");
  }
  if (rel.includes("/.inkos/") || rel.endsWith("/.inkos") || rel.includes("/secrets") || rel.endsWith(".env")) {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits cannot modify secrets or runtime internals.");
  }
  if (
    /^books\/[^/]+\/(?:book\.json|\.chapter-persistence\.json|\.write\.lock)$/i.test(rel)
    || /^books\/[^/]+\/chapters\/index\.json$/i.test(rel)
    || /^books\/[^/]+\/story\/(?:runtime|state|snapshots|canon)(?:\/|$)/i.test(rel)
  ) {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits cannot modify controlled book state files.");
  }
  if (!CHAT_EDIT_TEXT_EXTENSIONS.test(rel)) {
    throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits only support text content files.");
  }
  return { path: resolved, rel };
}

async function findChapterFile(root: string, bookId: string, chapterNumber: number): Promise<string | null> {
  const chaptersDir = join(root, "books", bookId, "chapters");
  const padded = String(chapterNumber).padStart(4, "0");
  const files = await readdir(chaptersDir).catch(() => []);
  const match = files.find((file) => file.startsWith(`${padded}_`) && file.endsWith(".md"));
  return match ? join(chaptersDir, match) : null;
}

function parseBookChapterFromRelativePath(rel: string): { bookId: string; chapterNumber: number } | null {
  const match = rel.match(/^books\/([^/]+)\/chapters\/(\d{4})_[^/]+\.md$/);
  if (!match?.[1] || !match[2]) return null;
  const chapterNumber = Number.parseInt(match[2], 10);
  return Number.isInteger(chapterNumber) ? { bookId: match[1], chapterNumber } : null;
}

function parseBookTruthFromRelativePath(rel: string): { bookId: string; fileName: string } | null {
  const match = rel.match(/^books\/([^/]+)\/story\/(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  try {
    return { bookId: match[1], fileName: assertSafeTruthFileName(match[2]) };
  } catch {
    return null;
  }
}

async function tryHandleExternalChatEdit(params: {
  readonly root: string;
  readonly state: StateManager;
  readonly instruction: string;
  readonly activeBookId: string | null;
}): Promise<ExternalChatEditResult | null> {
  const replacement = parseReplacementInstruction(params.instruction);
  if (!replacement) return null;
  if (!isExplicitExternalChatEditInstruction(params.instruction)) return null;

  const explicitPath = parseExplicitEditPath(params.instruction);
  if (explicitPath) {
    const target = resolveExternalChatEditPath(params.root, explicitPath);
    const content = await readFile(target.path, "utf-8").catch((error) => {
      throw new ApiError(404, "CHAT_EDIT_TARGET_NOT_FOUND", error instanceof Error ? error.message : String(error));
    });
    const first = content.indexOf(replacement.oldText);
    if (first === -1) {
      throw new ApiError(400, "EDIT_TARGET_NOT_FOUND", "要替换的原文没有在目标文件中找到。");
    }
    if (content.indexOf(replacement.oldText, first + replacement.oldText.length) !== -1) {
      throw new ApiError(400, "EDIT_TARGET_AMBIGUOUS", "要替换的原文出现多次，请给出更具体的一段。");
    }
    const updated = content.slice(0, first) + replacement.newText + content.slice(first + replacement.oldText.length);

    const chapterTarget = parseBookChapterFromRelativePath(target.rel);
    if (!chapterTarget && /^books\/[^/]+\/chapters\//.test(target.rel)) {
      throw new ApiError(400, "UNSUPPORTED_CHAT_EDIT_TARGET", "Chat external edits must use a recognized chapter file path.");
    }
    if (chapterTarget) {
      await executeCoreMutation({ state: params.state }, {
        kind: "save-chapter",
        bookId: chapterTarget.bookId,
        chapterNumber: chapterTarget.chapterNumber,
        content: updated,
      });
    } else {
      const truthTarget = parseBookTruthFromRelativePath(target.rel);
      if (truthTarget) {
        await executeCoreMutation({ state: params.state }, {
          kind: "edit-truth",
          bookId: truthTarget.bookId,
          fileName: truthTarget.fileName,
          content: updated,
        });
      } else {
        await writeFile(target.path, updated, "utf-8");
      }
    }

    return {
      activeBookId: chapterTarget?.bookId ?? params.activeBookId ?? undefined,
      responseText: `已直接编辑 ${target.rel}${chapterTarget ? "，并标记为需要复核" : ""}。`,
    };
  }

  if (!params.activeBookId) return null;
  const chapterNumber = parseChapterNumberForEdit(params.instruction);
  if (!replacement || !chapterNumber) return null;

  const chapterPath = await findChapterFile(params.root, params.activeBookId, chapterNumber);
  if (!chapterPath) {
    throw new ApiError(404, "CHAPTER_NOT_FOUND", `Chapter ${chapterNumber} not found in ${params.activeBookId}`);
  }
  if (!CHAT_EDIT_TEXT_EXTENSIONS.test(chapterPath)) {
    throw new ApiError(400, "UNSUPPORTED_EDIT_TARGET", "Chat external edits only support text files.");
  }

  const content = await readFile(chapterPath, "utf-8");
  const first = content.indexOf(replacement.oldText);
  if (first === -1) {
    throw new ApiError(400, "EDIT_TARGET_NOT_FOUND", "要替换的原文没有在目标章节中找到。");
  }
  if (content.indexOf(replacement.oldText, first + replacement.oldText.length) !== -1) {
    throw new ApiError(400, "EDIT_TARGET_AMBIGUOUS", "要替换的原文出现多次，请给出更具体的一段。");
  }

  const updated = content.slice(0, first) + replacement.newText + content.slice(first + replacement.oldText.length);
  await executeCoreMutation({ state: params.state }, {
    kind: "save-chapter",
    bookId: params.activeBookId,
    chapterNumber,
    content: updated,
  });

  return {
    activeBookId: params.activeBookId,
    responseText: `已直接编辑 ${params.activeBookId} 第 ${chapterNumber} 章，并标记为需要复核。`,
  };
}

function validateAgentActionExecution(args: {
  readonly instruction: string;
  readonly agentBookId: string | null | undefined;
  readonly requestedIntent?: RequestedIntent;
  readonly collectedToolExecs: ReadonlyArray<CollectedToolExec>;
  readonly language?: StudioLanguage;
}): string | undefined {
  const lang = args.language ?? "zh";
  const failedExec = args.collectedToolExecs.find(isLikelyFailedToolResult);
  if (failedExec) {
    const detail = failedExec.error ?? failedExec.result ?? pick(lang, "未知错误", "unknown error");
    return pick(
      lang,
      `${failedExec.label} 执行失败：${detail}`,
      `${failedExec.label} failed: ${detail}`,
    );
  }

  if (
    args.agentBookId
    && args.requestedIntent === "write_next"
    && !hasSuccessfulSubAgentExec(args.collectedToolExecs, "writer")
  ) {
    return pick(
      lang,
      "模型声称已完成下一章，但没有实际调用写作工具。请重试；如果仍失败，请检查模型是否支持工具调用。",
      "The model claimed the next chapter is done, but it never called the writing tool. Retry; if it keeps failing, check whether the model supports tool calls.",
    );
  }

  if (
    !args.agentBookId
    && args.requestedIntent === "create_book"
    && !hasSuccessfulSubAgentExec(args.collectedToolExecs, "architect")
  ) {
    return pick(
      lang,
      "已确认建书，但模型没有实际调用建书工具。请重试；如果仍失败，请检查模型是否支持工具调用。",
      "Book creation was confirmed, but the model never called the book setup tool. Retry; if it keeps failing, check whether the model supports tool calls.",
    );
  }

  return undefined;
}

type AgentFailureKind = "llm" | "internal" | "unknown";

function classifyAgentFailure(message: string): AgentFailureKind {
  const text = message.trim();
  if (!text) return "unknown";
  if (
    /API\s*返回|上游|upstream|Bad Gateway|temporarily unavailable|rate limit|quota|API Key|unauthorized|forbidden|无法连接到 API|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|LLM returned empty response|Provider finish_reason|reasoning_content/i.test(text)
  ) {
    return "llm";
  }
  if (
    /PlannerParseError|Architect output missing|required sections|missing YAML frontmatter|frontmatter delimiters|parseMemo|Book creation artifact is incomplete|Short-hit draft is incomplete|工具执行失败|执行失败|sub_agent|tool execution|RUNTIME_STATE_DELTA|JSON parse|解析失败/i.test(text)
  ) {
    return "internal";
  }
  return "unknown";
}

function formatAgentFailure(
  message: string,
  lang: StudioLanguage = "zh",
): { readonly code: string; readonly message: string; readonly status: 500 | 502 } {
  const kind = classifyAgentFailure(message);
  if (kind === "llm") {
    return { code: "AGENT_LLM_ERROR", message, status: 502 };
  }
  if (kind === "internal") {
    return {
      code: "AGENT_INTERNAL_ERROR",
      message: pick(lang, `InkOS 内部流程错误：${message}`, `InkOS internal pipeline error: ${message}`),
      status: 500,
    };
  }
  return { code: "AGENT_ERROR", message, status: 500 };
}

interface CollectedToolExec {
  id: string;
  tool: string;
  agent?: string;
  label: string;
  status: "running" | "completed" | "error";
  args?: Record<string, unknown>;
  result?: string;
  details?: unknown;
  error?: string;
  stages?: Array<{ label: string; status: "pending" | "completed" }>;
  startedAt: number;
  completedAt?: number;
}

class ConfirmedActionExecutionError extends Error {
  readonly exec: CollectedToolExec;

  constructor(message: string, exec: CollectedToolExec, cause?: unknown) {
    super(message);
    this.name = "ConfirmedActionExecutionError";
    this.exec = exec;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function suppressManualTextForTool(exec: CollectedToolExec): boolean {
  return false;
}

function manualToolAssistantMessage(
  responseText: string,
  exec: CollectedToolExec,
  provider: string,
  model: string,
): any {
  return {
    role: "assistant",
    content: [{ type: "text", text: suppressManualTextForTool(exec) ? "" : responseText }],
    api: "anthropic-messages",
    provider,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function manualToolAppendOptions(sessionKind: SessionKind, exec: CollectedToolExec): {
  readonly sessionKind: SessionKind;
  readonly legacyDisplay: { readonly toolExecutions: readonly CollectedToolExec[] };
} {
  return {
    sessionKind,
    legacyDisplay: { toolExecutions: [exec] },
  };
}

function isConfirmedProductionAction(args: {
  readonly actionSource: ActionSource;
  readonly requestedIntent?: RequestedIntent;
}): boolean {
  return (args.actionSource === "button" || args.actionSource === "slash")
    && args.requestedIntent === "create_book";
}

function requirePayloadText(value: string | undefined, message: string): string {
  const text = value?.trim();
  if (!text) {
    throw new ApiError(400, "CONFIRMED_ACTION_PAYLOAD_INCOMPLETE", message);
  }
  return text;
}

function toolResultText(result: unknown, lang: StudioLanguage = "zh"): string {
  const text = extractToolError(result).trim();
  return text || pick(lang, "已完成。", "Done.");
}

async function executeConfirmedProductionAction(args: {
  readonly pipeline: PipelineRunner;
  readonly root: string;
  readonly sessionId: string;
  readonly bookId: string | null;
  readonly streamSessionId: string;
  readonly instruction: string;
  readonly requestedIntent: RequestedIntent;
  readonly actionPayload?: ActionPayload;
  readonly language?: StudioLanguage;
}): Promise<CollectedToolExec> {
  const lang = args.language ?? "zh";
  const id = `direct-${args.requestedIntent}-${Date.now().toString(36)}`;
  const actionPayload = args.actionPayload;

  if (args.requestedIntent !== "create_book") {
    throw new ApiError(400, "UNSUPPORTED_CONFIRMED_ACTION", `Unsupported confirmed action: ${args.requestedIntent}`);
  }

  const tool = createSubAgentTool(args.pipeline, null, args.root, { actionPayload });
  const agent = "architect";
  const payload = actionPayload?.createBook;
  const title = requirePayloadText(
    payload?.title,
    pick(lang, "确认建书缺少书名，请重新生成确认卡。", "The book creation confirmation is missing a title. Regenerate the confirmation card."),
  );
  const params = {
    agent,
    instruction: args.instruction,
    title,
    ...(payload?.genre ? { genre: payload.genre } : {}),
    ...(payload?.platform ? { platform: payload.platform } : {}),
    ...(payload?.language ? { language: payload.language } : {}),
    ...(payload?.targetChapters ? { targetChapters: payload.targetChapters } : {}),
    ...(payload?.chapterWordCount ? { chapterWordCount: payload.chapterWordCount } : {}),
  };

  const exec: CollectedToolExec = {
    id,
    tool: tool.name,
    agent,
    label: resolveToolLabel(tool.name, agent, lang),
    status: "running",
    args: params,
    stages: pipelineStages(agent, lang)?.map(label => ({ label, status: "pending" as const })),
    startedAt: Date.now(),
  };

  broadcast("tool:start", {
    sessionId: args.streamSessionId,
    id,
    tool: tool.name,
    args: params,
    stages: exec.stages?.map(stage => stage.label),
  });

  try {
    const result = await tool.execute(
      id,
      params as never,
      undefined,
      (partialResult) => {
        broadcast("tool:update", {
          sessionId: args.streamSessionId,
          tool: tool.name,
          partialResult,
        });
      },
    );
    exec.status = "completed";
    exec.completedAt = Date.now();
    exec.result = toolResultText(result, lang);
    exec.details = (result as { details?: unknown } | undefined)?.details;
    exec.stages = exec.stages?.map(stage => ({ ...stage, status: "completed" as const }));
    broadcast("tool:end", {
      sessionId: args.streamSessionId,
      id,
      tool: tool.name,
      result,
      details: exec.details,
      isError: false,
    });
    return exec;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { content: [{ type: "text", text: message }] };
    exec.status = "error";
    exec.completedAt = Date.now();
    exec.error = message;
    broadcast("tool:end", {
      sessionId: args.streamSessionId,
      id,
      tool: tool.name,
      result,
      isError: true,
    });
    throw new ConfirmedActionExecutionError(message, exec, error);
  }
}

type StudioBookListSummary = BookSummary;

// --- Event bus for SSE ---

type EventHandler = (event: string, data: unknown) => void;
const subscribers = new Set<EventHandler>();
const bookCreateStatus = new Map<string, { status: "creating" | "error"; error?: string }>();

// 内存缓存：service -> 模型列表 + 更新时间戳；避免每次 sidebar 挂载时都打真实 LLM /models
const modelListCache = new Map<string, { models: Array<{ id: string; name: string }>; at: number }>();

interface ServiceConfigEntry {
  service: string;
  name?: string;
  baseUrl?: string;
  temperature?: number;
  apiFormat?: "chat" | "responses";
  stream?: boolean;
}

type LLMConfigSource = "env" | "studio";

interface EnvConfigSummary {
  detected: boolean;
  provider: string | null;
  service?: string | null;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
}

interface EnvConfigValues extends EnvConfigSummary {
  apiKey: string | null;
}

interface EnvConfigStatus {
  project: EnvConfigSummary;
  global: EnvConfigSummary;
  effectiveSource: "project" | "global" | null;
  runtimeUsesEnv: false;
}

interface ServiceProbeResult {
  ok: boolean;
  models: Array<{ id: string; name: string }>;
  selectedModel?: string;
  apiFormat?: "chat" | "responses";
  stream?: boolean;
  baseUrl?: string;
  modelsSource?: "api" | "fallback";
  error?: string;
}

function broadcast(event: string, data: unknown): void {
  for (const handler of subscribers) {
    handler(event, data);
  }
}

async function completeBookExists(bookDir: string): Promise<boolean> {
  return isBookFoundationComplete(bookDir);
}

function resolveArchitectBookIdFromArgs(args?: Record<string, unknown>): string | null {
  if (!args || args.agent !== "architect" || args.revise === true) return null;
  if (typeof args.bookId === "string" && args.bookId.trim()) return args.bookId.trim();
  if (typeof args.title === "string" && args.title.trim()) {
    return deriveBookIdFromTitle(args.title) || null;
  }
  return null;
}

function resolveCreatedBookIdFromToolExecs(execs: ReadonlyArray<CollectedToolExec>): string | null {
  for (let i = execs.length - 1; i >= 0; i -= 1) {
    const exec = execs[i];
    if (exec.tool !== "sub_agent" || exec.agent !== "architect" || exec.status !== "completed") continue;

    const details = exec.details as { kind?: unknown; bookId?: unknown } | undefined;
    if (details?.kind === "book_created" && typeof details.bookId === "string" && details.bookId.trim()) {
      return details.bookId.trim();
    }
  }
  return null;
}

function resolveCreatedBookIdFromDetails(details: Readonly<Record<string, unknown>> | undefined): string | null {
  if (details?.kind === "book_created" && typeof details.bookId === "string" && details.bookId.trim()) {
    return details.bookId.trim();
  }
  return null;
}

async function loadStudioBookListSummary(
  state: StateManager,
  bookId: string,
): Promise<StudioBookListSummary> {
  const book = await state.loadBookConfig(bookId);
  const nextChapter = await state.getNextChapterNumber(bookId);
  return { ...book, chaptersWritten: nextChapter - 1 };
}

function isCustomServiceId(serviceId: string): boolean {
  return serviceId === "custom" || serviceId.startsWith("custom:");
}

function serviceConfigKey(entry: ServiceConfigEntry): string {
  return entry.service === "custom" ? `custom:${entry.name ?? "Custom"}` : entry.service;
}

function normalizeServiceEntry(serviceId: string, value: Record<string, unknown>): ServiceConfigEntry {
  if (serviceId.startsWith("custom:")) {
    return {
      service: "custom",
      name: decodeURIComponent(serviceId.slice("custom:".length)),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  if (serviceId === "custom") {
    return {
      service: "custom",
      ...(typeof value.name === "string" && value.name.length > 0 ? { name: value.name } : {}),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0 ? { baseUrl: value.baseUrl } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  return {
    service: serviceId,
    ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
    ...(value.apiFormat === "chat" || value.apiFormat === "responses" ? { apiFormat: value.apiFormat } : {}),
    ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
  };
}

function normalizeConfigSource(value: unknown): LLMConfigSource {
  return value === "studio" ? "studio" : "env";
}

function normalizeServiceConfig(raw: unknown): ServiceConfigEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        service: typeof entry.service === "string" && entry.service.length > 0 ? entry.service : "custom",
        ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
        ...(typeof entry.baseUrl === "string" && entry.baseUrl.length > 0 ? { baseUrl: entry.baseUrl } : {}),
        ...(typeof entry.temperature === "number" ? { temperature: entry.temperature } : {}),
        ...(entry.apiFormat === "chat" || entry.apiFormat === "responses" ? { apiFormat: entry.apiFormat } : {}),
        ...(typeof entry.stream === "boolean" ? { stream: entry.stream } : {}),
      }));
  }

  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => value && typeof value === "object")
      .map(([serviceId, value]) => normalizeServiceEntry(serviceId, value as Record<string, unknown>));
  }

  return [];
}

function mergeServiceConfig(existing: ServiceConfigEntry[], updates: ServiceConfigEntry[]): ServiceConfigEntry[] {
  const merged = new Map(existing.map((entry) => [serviceConfigKey(entry), entry]));
  for (const update of updates) {
    merged.set(serviceConfigKey(update), update);
  }
  return [...merged.values()];
}

function syncTopLevelLlmMirror(llm: Record<string, unknown>): void {
  const selectedService = typeof llm.service === "string" ? llm.service : undefined;
  if (!selectedService) return;

  const services = normalizeServiceConfig(llm.services);
  const selectedEntry = services.find((entry) => serviceConfigKey(entry) === selectedService)
    ?? (!isCustomServiceId(selectedService) ? { service: selectedService } : undefined);
  if (!selectedEntry) return;

  const preset = resolveServicePreset(selectedEntry.service);
  llm.provider = resolveServiceProviderFamily(selectedEntry.service) ?? "openai";
  llm.baseUrl = selectedEntry.baseUrl ?? preset?.baseUrl ?? "";

  const defaultModel = typeof llm.defaultModel === "string" ? llm.defaultModel.trim() : "";
  if (defaultModel) llm.model = defaultModel;
  if (selectedEntry.temperature !== undefined) llm.temperature = selectedEntry.temperature;
  if (selectedEntry.apiFormat !== undefined) llm.apiFormat = selectedEntry.apiFormat;
  if (selectedEntry.stream !== undefined) llm.stream = selectedEntry.stream;
}

async function loadRawConfig(root: string): Promise<Record<string, unknown>> {
  const configPath = join(root, "inkos.json");
  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

const projectMutationQueues = new Map<string, Promise<void>>();

async function withProjectMutationLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = projectMutationQueues.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  projectMutationQueues.set(root, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (projectMutationQueues.get(root) === queued) {
      projectMutationQueues.delete(root);
    }
  }
}

async function mutateRawConfig<T>(
  root: string,
  mutator: (config: Record<string, unknown>) => Promise<T> | T,
): Promise<T> {
  return await withProjectMutationLock(root, () => mutateProjectConfig(root, mutator));
}

function rethrowApiError(error: unknown): void {
  if (error instanceof ApiError) throw error;
}

function rethrowCoreMutationApiError(error: unknown): void {
  if (error instanceof CoreMutationBookNotFoundError) {
    throw new ApiError(404, error.code, error.message);
  }
  if (error instanceof ChapterMutationChapterNotFoundError) {
    throw new ApiError(404, error.code, error.message);
  }
  if (error instanceof CoreMutationValidationError) {
    throw new ApiError(400, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\blocked\b/i.test(message)) {
    throw new ApiError(409, "BOOK_LOCKED", message);
  }
  rethrowApiError(error);
}

function normalizeApiSessionId(value: unknown, label = "sessionId"): string {
  const parsed = SessionIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_SESSION_ID", `Invalid ${label}`);
  }
  return parsed.data;
}

function normalizePositiveIntegerParam(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "INVALID_NUMBER", `${label} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ApiError(400, "INVALID_NUMBER", `${label} must be a positive integer`);
  }
  return parsed;
}

type ChapterReviewMode = "auto" | "manual";

function normalizeChapterReviewMode(mode: unknown): ChapterReviewMode {
  return mode === "manual" ? "manual" : "auto";
}

function readProjectChapterReviewMode(config: Record<string, unknown>): ChapterReviewMode {
  const writing = config.writing && typeof config.writing === "object" && !Array.isArray(config.writing)
    ? config.writing as Record<string, unknown>
    : {};
  return normalizeChapterReviewMode(writing.reviewMode);
}

function readBookChapterReviewMode(rawBook: Record<string, unknown>): ChapterReviewMode | undefined {
  const writing = rawBook.writing && typeof rawBook.writing === "object" && !Array.isArray(rawBook.writing)
    ? rawBook.writing as Record<string, unknown>
    : undefined;
  if (!writing || writing.reviewMode !== "manual" && writing.reviewMode !== "auto") return undefined;
  return writing.reviewMode;
}

async function loadRawBookConfig(root: string, bookId: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, "books", bookId, "book.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function resolveBookChapterReviewMode(root: string, bookId: string | undefined, projectMode: ChapterReviewMode): Promise<ChapterReviewMode> {
  if (!bookId || !isSafeBookId(bookId)) return projectMode;
  try {
    const rawBook = await loadRawBookConfig(root, bookId);
    return readBookChapterReviewMode(rawBook) ?? projectMode;
  } catch {
    return projectMode;
  }
}

type RevisionGateSetting = "strict" | "lenient" | "always";

function normalizeRevisionGate(gate: unknown): RevisionGateSetting {
  return gate === "lenient" || gate === "always" ? gate : "strict";
}

function readProjectRevisionGate(config: Record<string, unknown>): RevisionGateSetting {
  const writing = config.writing && typeof config.writing === "object" && !Array.isArray(config.writing)
    ? config.writing as Record<string, unknown>
    : {};
  return normalizeRevisionGate(writing.revisionGate);
}

function readBookRevisionGate(rawBook: Record<string, unknown>): RevisionGateSetting | undefined {
  const writing = rawBook.writing && typeof rawBook.writing === "object" && !Array.isArray(rawBook.writing)
    ? rawBook.writing as Record<string, unknown>
    : undefined;
  if (!writing || writing.revisionGate !== "strict" && writing.revisionGate !== "lenient" && writing.revisionGate !== "always") return undefined;
  return writing.revisionGate;
}

async function resolveBookRevisionGate(root: string, bookId: string | undefined, projectGate: RevisionGateSetting): Promise<RevisionGateSetting> {
  if (!bookId || !isSafeBookId(bookId)) return projectGate;
  try {
    const rawBook = await loadRawBookConfig(root, bookId);
    return readBookRevisionGate(rawBook) ?? projectGate;
  } catch {
    return projectGate;
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function toEnvConfigSummary(values: EnvConfigValues): EnvConfigSummary {
  return {
    detected: values.detected,
    provider: values.provider,
    service: values.service ?? null,
    baseUrl: values.baseUrl,
    model: values.model,
    hasApiKey: values.hasApiKey,
  };
}

async function readEnvConfigValues(path: string): Promise<EnvConfigValues> {
  try {
    const raw = await readFile(path, "utf-8");
    const values = new Map<string, string>();

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      values.set(key, unquoteEnvValue(value));
    }

    const provider = values.get("INKOS_LLM_PROVIDER") ?? null;
    const service = values.get("INKOS_LLM_SERVICE") ?? null;
    const baseUrl = values.get("INKOS_LLM_BASE_URL") ?? null;
    const model = values.get("INKOS_LLM_MODEL") ?? null;
    const apiKey = values.get("INKOS_LLM_API_KEY") ?? "";
    const detected = Boolean(provider || service || baseUrl || model || apiKey);

    return {
      detected,
      provider,
      service,
      baseUrl,
      model,
      hasApiKey: apiKey.length > 0,
      apiKey: apiKey.length > 0 ? apiKey : null,
    };
  } catch {
    return {
      detected: false,
      provider: null,
      service: null,
      baseUrl: null,
      model: null,
      hasApiKey: false,
      apiKey: null,
    };
  }
}

async function readEnvConfigStatus(root: string): Promise<EnvConfigStatus> {
  const project = await readEnvConfigValues(join(root, ".env"));
  const global = await readEnvConfigValues(GLOBAL_ENV_PATH);
  return {
    project: toEnvConfigSummary(project),
    global: toEnvConfigSummary(global),
    effectiveSource: project.detected ? "project" : global.detected ? "global" : null,
    runtimeUsesEnv: false,
  };
}

async function readEffectiveEnvConfigValues(root: string): Promise<{ source: "project" | "global"; values: EnvConfigValues } | null> {
  const project = await readEnvConfigValues(join(root, ".env"));
  if (project.detected) return { source: "project", values: project };
  const global = await readEnvConfigValues(GLOBAL_ENV_PATH);
  if (global.detected) return { source: "global", values: global };
  return null;
}

async function resolveConfiguredServiceBaseUrl(root: string, serviceId: string, inlineBaseUrl?: string): Promise<string | undefined> {
  if (inlineBaseUrl?.trim()) return inlineBaseUrl.trim();

  if (!isCustomServiceId(serviceId)) {
    return resolveServicePreset(serviceId)?.baseUrl;
  }

  try {
    const config = await loadRawConfig(root);
    const services = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services);
    const matched = services.find((entry) => serviceConfigKey(entry) === serviceId);
    return matched?.baseUrl;
  } catch {
    return undefined;
  }
}

async function resolveConfiguredServiceEntry(root: string, serviceId: string): Promise<ServiceConfigEntry | undefined> {
  try {
    const config = await loadRawConfig(root);
    const services = normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services);
    return services.find((entry) => serviceConfigKey(entry) === serviceId);
  } catch {
    return undefined;
  }
}

function buildProbePlans(
  preferredApiFormat: "chat" | "responses" | undefined,
  preferredStream: boolean | undefined,
): Array<{ apiFormat: "chat" | "responses"; stream: boolean }> {
  const candidates: Array<{ apiFormat: "chat" | "responses"; stream: boolean }> = [];
  const seen = new Set<string>();
  const push = (apiFormat: "chat" | "responses", stream: boolean) => {
    const key = `${apiFormat}:${stream ? "1" : "0"}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ apiFormat, stream });
  };

  if (preferredApiFormat) {
    push(preferredApiFormat, preferredStream ?? false);
    if (preferredStream) push(preferredApiFormat, false);
    return candidates;
  }

  push("chat", false);
  push("responses", false);
  return candidates;
}

function buildModelCandidates(args: {
  preferredModel?: string;
  configModel?: string;
  envModel?: string | null;
  discoveredModels: Array<{ id: string; name: string }>;
  includeGenericFallbacks?: boolean;
}): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value || value.trim().length === 0) return;
    const id = value.trim();
    if (seen.has(id)) return;
    seen.add(id);
    candidates.push(id);
  };

  push(args.preferredModel);
  push(args.configModel);
  push(args.envModel ?? undefined);
  for (const model of args.discoveredModels.slice(0, MAX_DISCOVERED_MODELS_TO_PING)) push(model.id);
  if (args.includeGenericFallbacks === false) return candidates;
  for (const fallback of [
    "gpt-5.4",
    "gpt-4o",
    "claude-sonnet-4-6",
    "MiniMax-M2.7",
    "kimi-k2.5",
  ].slice(0, MAX_GENERIC_FALLBACK_MODELS_TO_PING)) {
    push(fallback);
  }
  return candidates;
}

function hasExplicitModel(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function fallbackTextModelsForEndpoint(
  endpoint: ReturnType<typeof getAllEndpoints>[number] | undefined,
  preset: ReturnType<typeof resolveServicePreset> | undefined,
): Array<{ id: string; name: string }> {
  const endpointModels = endpoint?.models
    .filter((model) => model.enabled !== false)
    .filter((model) => isTextChatModelId(model.id))
    .map((model) => ({ id: model.id, name: model.id }))
    ?? [];
  if (endpointModels.length > 0) return endpointModels;
  return preset?.knownModels?.map((id) => ({ id, name: id })) ?? [];
}

function shouldTrustStaticModelsWhenLiveListUnavailable(endpoint: ReturnType<typeof getAllEndpoints>[number] | undefined): boolean {
  return endpoint?.group === "aggregator";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, lang: StudioLanguage = "zh"): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(pick(lang, `${label} 超时（${timeoutMs}ms）`, `${label} timed out (${timeoutMs}ms)`))),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function formatServiceProbeError(args: {
  readonly service: string;
  readonly label?: string;
  readonly baseUrl: string;
  readonly model?: string;
  readonly apiFormat?: "chat" | "responses";
  readonly stream?: boolean;
  readonly error: string;
  readonly language?: StudioLanguage;
}): string {
  const lang = args.language ?? "zh";
  const rawDetail = args.error
    .replace(/\n\s*\(baseUrl:[\s\S]*?\)$/m, "")
    .trim();
  const upstreamDetail = rawDetail.includes("上游详情：")
    ? rawDetail
    : "";
  const protocol = args.apiFormat === "responses" ? "Responses" : "Chat / Completions";
  const streamSuffix = typeof args.stream === "boolean"
    ? pick(lang, `，${args.stream ? "流式" : "非流式"}`, `, ${args.stream ? "streaming" : "non-streaming"}`)
    : "";
  const context = [
    pick(lang, `服务商：${args.label ?? args.service}`, `Service: ${args.label ?? args.service}`),
    pick(lang, `测试模型：${args.model ?? "未确定"}`, `Test model: ${args.model ?? "undetermined"}`),
    pick(lang, `协议：${protocol}${streamSuffix}`, `Protocol: ${protocol}${streamSuffix}`),
    pick(lang, `Base URL：${args.baseUrl}`, `Base URL: ${args.baseUrl}`),
  ].join("\n");
  const upstreamPrefix = (detail: string): string =>
    pick(lang, `\n上游返回：${detail}`, `\nUpstream response: ${detail}`);

  if (args.service === "google") {
    return [
      pick(lang, "Google Gemini 测试连接失败。", "Google Gemini connection test failed."),
      context,
      "",
      pick(lang, "请优先检查：", "Check these first:"),
      pick(
        lang,
        "1. API Key 是否来自 Google AI Studio 的 Gemini API key，而不是 OAuth、Vertex AI 或其它 Google 服务凭据。",
        "1. The API Key is a Gemini API key from Google AI Studio, not an OAuth, Vertex AI, or other Google service credential.",
      ),
      pick(
        lang,
        "2. 该 key 所属项目是否已启用 Gemini API，并且没有被限制到其它 API、来源或服务。",
        "2. The key's project has the Gemini API enabled and is not restricted to other APIs, origins, or services.",
      ),
      pick(
        lang,
        "3. 当前地区/账号是否允许访问 Gemini API。",
        "3. Your region/account is allowed to access the Gemini API.",
      ),
      pick(
        lang,
        "4. 如果 key 曾经泄露，请在 AI Studio 重新生成后再保存。",
        "4. If the key was ever leaked, regenerate it in AI Studio before saving.",
      ),
      upstreamDetail ? upstreamPrefix(upstreamDetail) : "",
    ].filter(Boolean).join("\n");
  }

  if (args.service === "moonshot" || args.service === "kimiCodingPlan" || args.service === "kimicode") {
    return [
      pick(lang, `${args.label ?? args.service} 测试连接失败。`, `${args.label ?? args.service} connection test failed.`),
      context,
      "",
      pick(
        lang,
        "请优先检查模型是否可用，以及 kimi-k2.x 这类模型是否需要 temperature=1。",
        "Check first whether the model is available, and whether models like kimi-k2.x require temperature=1.",
      ),
      rawDetail ? upstreamPrefix(rawDetail) : "",
    ].filter(Boolean).join("\n");
  }

  return [
    pick(lang, `${args.label ?? args.service} 测试连接失败。`, `${args.label ?? args.service} connection test failed.`),
    context,
    "",
    pick(
      lang,
      "请检查 API Key、模型可用性、账号额度，以及协议类型是否匹配该服务商。",
      "Check the API Key, model availability, account quota, and whether the protocol type matches this service.",
    ),
    rawDetail ? upstreamPrefix(rawDetail) : "",
  ].filter(Boolean).join("\n");
}

async function fetchModelsFromServiceBaseUrl(
  serviceId: string,
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string,
  lang: StudioLanguage = "zh",
): Promise<{ models: Array<{ id: string; name: string }>; error?: string; authFailed?: boolean }> {
  const endpoint = isCustomServiceId(serviceId)
    ? undefined
    : getAllEndpoints().find((ep) => ep.id === serviceId);
  const modelsBaseUrl = isCustomServiceId(serviceId)
    ? baseUrl
    : endpoint?.modelsBaseUrl ?? (endpoint ? baseUrl : resolveServiceModelsBaseUrl(serviceId) ?? baseUrl);
  const modelsUrl = modelsBaseUrl.replace(/\/$/, "") + "/models";
  try {
    const res = await fetchWithProxy(modelsUrl, {
      headers: buildBearerAuthHeaders(apiKey, lang),
      signal: AbortSignal.timeout(SERVICE_MODELS_PROBE_TIMEOUT_MS),
    }, proxyUrl);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        models: [],
        error: pick(
          lang,
          `服务商返回 ${res.status}: ${body.slice(0, 200)}`,
          `Service returned ${res.status}: ${body.slice(0, 200)}`,
        ),
        authFailed: res.status === 401 || res.status === 403,
      };
    }
    const json = await res.json() as { data?: Array<{ id: string }> };
    return {
      models: (json.data ?? []).map((m) => ({ id: m.id, name: m.id })),
    };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildBearerAuthHeaders(apiKey: string | undefined, lang: StudioLanguage = "zh"): Record<string, string> {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) return {};
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    throw new Error(pick(
      lang,
      "API Key 只能包含英文、数字和常见 ASCII 符号，请检查是否误粘贴了中文说明。",
      "API Key may only contain ASCII letters, digits, and common symbols. Check whether you pasted explanatory text by mistake.",
    ));
  }
  return { Authorization: `Bearer ${trimmed}` };
}

async function probeServiceCapabilities(args: {
  root: string;
  service: string;
  apiKey: string;
  baseUrl: string;
  preferredApiFormat?: "chat" | "responses";
  preferredStream?: boolean;
  preferredModel?: string;
  proxyUrl?: string;
  language?: StudioLanguage;
}): Promise<ServiceProbeResult> {
  const lang = args.language ?? "zh";
  const rawConfig = await loadRawConfig(args.root).catch(() => ({} as Record<string, unknown>));
  const llm = (rawConfig.llm as Record<string, unknown> | undefined) ?? {};
  const envConfig = await readEnvConfigStatus(args.root);
  const envModel = envConfig.effectiveSource === "project"
    ? envConfig.project.model
    : envConfig.effectiveSource === "global"
      ? envConfig.global.model
      : null;

  const baseService = isCustomServiceId(args.service) ? "custom" : args.service;
  const modelsResponse = await fetchModelsFromServiceBaseUrl(baseService, args.baseUrl, args.apiKey, args.proxyUrl, lang);
  if (modelsResponse.authFailed) {
    return {
      ok: false,
      models: [],
      error: modelsResponse.error ?? pick(
        lang,
        "API Key 无效或无权访问模型列表。",
        "API Key is invalid or has no access to the model list.",
      ),
    };
  }
  const discoveredModels = modelsResponse.models;
  const endpoint = getAllEndpoints().find((ep) => ep.id === baseService);
  const preset = resolveServicePreset(baseService);
  const discoveredFirstModel =
    discoveredModels.find((model) => isTextChatModelId(model.id))?.id
    ?? discoveredModels[0]?.id;
  const shouldVerifyExplicitModel = hasExplicitModel(args.preferredModel);
  if (discoveredModels.length > 0 && !shouldVerifyExplicitModel) {
    if (!discoveredFirstModel || !isTextChatModelId(discoveredFirstModel)) {
      return {
        ok: false,
        models: discoveredModels,
        error: pick(
          lang,
          "模型列表可访问，但没有发现可用于文本对话的模型。",
          "The model list is reachable, but no model usable for text chat was found.",
        ),
      };
    }
    return {
      ok: true,
      models: discoveredModels,
      selectedModel: discoveredFirstModel,
      apiFormat: args.preferredApiFormat ?? "chat",
      stream: args.preferredStream ?? false,
      baseUrl: args.baseUrl,
      modelsSource: "api",
    };
  }
  if (shouldTrustStaticModelsWhenLiveListUnavailable(endpoint)) {
    const models = fallbackTextModelsForEndpoint(endpoint, preset);
    const selectedModel =
      endpoint?.checkModel && models.some((model) => model.id === endpoint.checkModel)
        ? endpoint.checkModel
        : models[0]?.id;
    if (selectedModel) {
      return {
        ok: true,
        models,
        selectedModel,
        apiFormat: args.preferredApiFormat ?? "chat",
        stream: args.preferredStream ?? false,
        baseUrl: args.baseUrl,
        modelsSource: "fallback",
      };
    }
  }
  // Prefer live /models results; if unavailable, probe with the service's own check model before global defaults.
  const serviceFirstModel =
    endpoint?.checkModel
    ?? preset?.knownModels?.[0]
    ?? endpoint?.models.find((model) => model.enabled !== false)?.id;
  const useDynamicLocalModels = baseService === "ollama";
  const useEndpointCheckModel = !useDynamicLocalModels
    && !isCustomServiceId(args.service)
    && discoveredModels.length === 0
    && Boolean(endpoint?.checkModel);
  const configService = typeof llm.service === "string" ? llm.service : undefined;
  const configModel = !useEndpointCheckModel && configService === args.service
    ? typeof llm.defaultModel === "string"
      ? llm.defaultModel
      : typeof llm.model === "string"
        ? llm.model
        : undefined
    : undefined;
  const useCustomFallbacks = false;
  const modelCandidates = shouldVerifyExplicitModel
    ? [args.preferredModel!.trim()]
    : buildModelCandidates({
        preferredModel: serviceFirstModel,
        configModel,
        envModel: useCustomFallbacks ? envModel : undefined,
        discoveredModels: useEndpointCheckModel ? [] : discoveredModels,
        includeGenericFallbacks: useCustomFallbacks,
      });

  if (modelCandidates.length === 0) {
    return {
      ok: false,
      models: [],
      error: pick(
        lang,
        "无法自动确定模型，请先填写可用模型或提供支持 /models 的服务端点。",
        "Could not determine a model automatically. Fill in an available model first, or provide a service endpoint that supports /models.",
      ),
    };
  }

  let lastError = modelsResponse.error ?? pick(lang, "自动探测失败", "Automatic probing failed");

  for (const model of modelCandidates) {
    for (const plan of buildProbePlans(args.preferredApiFormat, args.preferredStream)) {
      const client = createLLMClient({
        provider: resolveServiceProviderFamily(baseService) ?? "openai",
        service: baseService,
        configSource: "studio",
        baseUrl: args.baseUrl,
        apiKey: args.apiKey.trim(),
        model,
        temperature: 0.7,
        maxTokens: 16,
        thinkingBudget: 0,
        proxyUrl: args.proxyUrl,
        apiFormat: plan.apiFormat,
        stream: plan.stream,
      } as ProjectConfig["llm"]);

      try {
        const completion = await withTimeout(
          // A connectivity probe wants a fast pass/fail — never the transient
          // retry+backoff, which would multiply the time when the upstream is
          // rate-limiting (and make the diagnostics page hang).
          chatCompletion(client, model, [{ role: "user", content: "Reply with OK only." }], { maxTokens: 16, retry: false }),
          SERVICE_CHAT_PROBE_TIMEOUT_MS,
          "service connection test",
          lang,
        );
        if (!completion.content.trim()) {
          throw new Error(pick(
            lang,
            "聊天接口返回成功但内容为空；请确认该模型支持普通文本输出，或关闭流式后重试。",
            "The chat endpoint succeeded but returned empty content. Confirm the model supports normal text output, or retry with streaming disabled.",
          ));
        }
        const models = discoveredModels.length > 0
          ? discoveredModels
          : fallbackTextModelsForEndpoint(endpoint, preset);
        return {
          ok: true,
          models: models.length > 0 ? models : [{ id: model, name: model }],
          selectedModel: model,
          apiFormat: plan.apiFormat,
          stream: plan.stream,
          baseUrl: args.baseUrl,
          modelsSource: discoveredModels.length > 0 ? "api" : "fallback",
        };
      } catch (error) {
        lastError = formatServiceProbeError({
          service: baseService,
          label: endpoint?.label ?? preset?.label,
          baseUrl: args.baseUrl,
          model,
          apiFormat: plan.apiFormat,
          stream: plan.stream,
          error: error instanceof Error ? error.message : String(error),
          language: lang,
        });
      }
    }
  }

  return {
    ok: false,
    models: discoveredModels,
    error: lastError,
  };
}

// --- Server factory ---

export function createStudioServer(initialConfig: ProjectConfig, root: string) {
  const app = new Hono();
  const state = new StateManager(root);
  let cachedConfig = initialConfig;
  type StudioOperationKind = "write" | "draft" | "rewrite" | "repair-state" | "resync";
  interface ActiveStudioOperation {
    readonly requestId: string;
    readonly bookId: string;
    readonly kind: StudioOperationKind;
    readonly controller: AbortController;
  }
  const activeBookOperations = new Map<string, ActiveStudioOperation>();

  // Structured error handler — ApiError returns typed JSON, others return 500
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("LLM API key not set") || message.includes("INKOS_LLM_API_KEY not set")) {
      return c.json({ error: { code: "LLM_CONFIG_ERROR", message } }, 400);
    }
    console.error("[studio] Unexpected server error", error);
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: "Unexpected server error." } },
      500,
    );
  });

  // BookId validation middleware — blocks path traversal on all book routes
  app.use("/api/v1/books/:id/*", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });
  app.use("/api/v1/books/:id", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });
  app.use("/api/v1/sessions/:sessionId/*", async (c, next) => {
    normalizeApiSessionId(c.req.param("sessionId"));
    await next();
  });
  app.use("/api/v1/sessions/:sessionId", async (c, next) => {
    normalizeApiSessionId(c.req.param("sessionId"));
    await next();
  });

  // Logger sink that broadcasts to SSE
  const sseSink: LogSink = {
    write(entry: LogEntry): void {
      broadcast("log", { level: entry.level, tag: entry.tag, message: entry.message });
    },
  };

  // Logger sink that prints to server terminal
  const consoleSink: LogSink = {
    write(entry: LogEntry): void {
      const prefix = `[${entry.tag}]`;
      if (entry.level === "warn") console.warn(prefix, entry.message);
      else if (entry.level === "error") console.error(prefix, entry.message);
      else console.log(prefix, entry.message);
    },
  };

  async function loadCurrentProjectConfig(
    options?: { readonly requireApiKey?: boolean },
  ): Promise<ProjectConfig> {
    const freshConfig = await loadProjectConfig(root, { ...options, consumer: "studio" });
    cachedConfig = freshConfig;
    return freshConfig;
  }

  // Read the project language fresh from inkos.json on every call, so a language
  // switch takes effect on the next request instead of being frozen at startup.
  // A missing/corrupt inkos.json means "no project language configured" -> zh.
  async function currentProjectLanguage(): Promise<StudioLanguage> {
    const raw = await loadRawConfig(root).catch(() => ({} as Record<string, unknown>));
    return normalizeStudioLanguage(raw.language);
  }

  async function buildPipelineConfig(
    overrides?: Partial<Pick<PipelineConfig, "externalContext" | "client" | "model" | "signal">> & {
      readonly currentConfig?: ProjectConfig;
      readonly sessionIdForSSE?: string;
      readonly bookIdForSettings?: string;
      readonly bookIdForTelemetry?: string;
    },
  ): Promise<PipelineConfig> {
    const currentConfig = overrides?.currentConfig ?? await loadCurrentProjectConfig();
    const envLayers = await loadLLMEnvLayers(root);
    const defaultTimeoutMs = resolveLLMTimeoutMs(envLayers);
    const telemetryBookId = overrides?.bookIdForTelemetry ?? overrides?.bookIdForSettings;
    const projectReviewMode = readProjectChapterReviewMode(currentConfig as unknown as Record<string, unknown>);
    const chapterReviewMode = await resolveBookChapterReviewMode(root, overrides?.bookIdForSettings, projectReviewMode);
    const projectRevisionGate = readProjectRevisionGate(currentConfig as unknown as Record<string, unknown>);
    const revisionGate = await resolveBookRevisionGate(root, overrides?.bookIdForSettings, projectRevisionGate);
    const scopedSseSink: LogSink = overrides?.sessionIdForSSE
      ? {
          write(entry) {
            broadcast("log", {
              sessionId: overrides.sessionIdForSSE,
              level: entry.level,
              tag: entry.tag,
              message: entry.message,
            });
          },
        }
      : sseSink;
    const logger = createLogger({ tag: "studio", sinks: [scopedSseSink, consoleSink] });
    return {
      client: overrides?.client ?? createLLMClient(currentConfig.llm),
      model: overrides?.model ?? currentConfig.llm.model,
      projectRoot: root,
      defaultLLMConfig: currentConfig.llm,
      defaultTimeoutMs,
      signal: overrides?.signal,
      foundationReviewRetries: currentConfig.foundation?.reviewRetries ?? 2,
      writingReviewRetries: currentConfig.writing?.reviewRetries ?? 2,
      chapterReviewMode,
      revisionGate,
      modelOverrides: currentConfig.modelOverrides,
      notifyChannels: currentConfig.notify,
      logger,
      onContextCompression: (event) => {
        broadcast("context:compression", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...event,
        });
      },
      onStreamProgress: (progress) => {
        broadcast("llm:progress", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          status: progress.status,
          elapsedMs: progress.elapsedMs,
          totalChars: progress.totalChars,
          chineseChars: progress.chineseChars,
        });
      },
      onCallTelemetry: (telemetry) => {
        broadcast("llm:telemetry", {
          ...(overrides?.sessionIdForSSE ? { sessionId: overrides.sessionIdForSSE } : {}),
          ...(telemetryBookId ? { bookId: telemetryBookId } : {}),
          ...(telemetry.operationId ? { operationId: telemetry.operationId } : {}),
          agent: telemetry.agent,
          phase: telemetry.phase,
          status: telemetry.status,
          service: telemetry.service,
          model: telemetry.model,
          durationMs: telemetry.durationMs,
          timeoutMs: telemetry.timeoutMs,
          attemptCount: telemetry.attemptCount,
          retryCount: telemetry.retryCount,
          promptTokens: telemetry.usage.promptTokens,
          completionTokens: telemetry.usage.completionTokens,
          totalTokens: telemetry.usage.totalTokens,
          promptEstimatedTokens: telemetry.promptAssembly.estimatedTokens,
          usageEstimated: telemetry.usageEstimated ?? false,
          partialContentLength: telemetry.partialContentLength,
          errorMessage: telemetry.errorMessage,
        });
      },
      externalContext: overrides?.externalContext,
    };
  }

  function beginStudioOperation(bookId: string, kind: StudioOperationKind): ActiveStudioOperation {
    const existing = activeBookOperations.get(bookId);
    if (existing) {
      throw new ApiError(409, "BOOK_OPERATION_ACTIVE", `Book "${bookId}" already has an active ${existing.kind} operation.`);
    }
    const operation: ActiveStudioOperation = {
      requestId: randomUUID(),
      bookId,
      kind,
      controller: new AbortController(),
    };
    activeBookOperations.set(bookId, operation);
    broadcast(`${kind}:start`, { bookId, requestId: operation.requestId });
    return operation;
  }

  function launchStudioOperation<T>(params: {
    readonly operation: ActiveStudioOperation;
    readonly run: () => Promise<T>;
    readonly completeData: (result: T) => Record<string, unknown>;
  }): void {
    void params.run().then(
      (result) => {
        if (params.operation.controller.signal.aborted) {
          broadcast(`${params.operation.kind}:cancelled`, {
            bookId: params.operation.bookId,
            requestId: params.operation.requestId,
          });
          return;
        }
        broadcast(`${params.operation.kind}:complete`, {
          bookId: params.operation.bookId,
          requestId: params.operation.requestId,
          ...params.completeData(result),
        });
      },
      (error) => {
        if (params.operation.controller.signal.aborted) {
          broadcast(`${params.operation.kind}:cancelled`, {
            bookId: params.operation.bookId,
            requestId: params.operation.requestId,
          });
          return;
        }
        broadcast(`${params.operation.kind}:error`, {
          bookId: params.operation.bookId,
          requestId: params.operation.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    ).finally(() => {
      const current = activeBookOperations.get(params.operation.bookId);
      if (current?.requestId === params.operation.requestId) {
        activeBookOperations.delete(params.operation.bookId);
      }
    });
  }

  // --- Books ---

  app.get("/api/v1/books", async (c) => {
    const bookIds = await state.listBooks();
    const books = await Promise.all(bookIds.map((id) => loadStudioBookListSummary(state, id)));
    return c.json({ books });
  });

  app.get("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const book = await state.loadBookConfig(id);
      const chapters = await state.loadChapterIndex(id);
      const nextChapter = await state.getNextChapterNumber(id);
      return c.json({ book, chapters, nextChapter });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // --- Genres ---

  app.get("/api/v1/genres", async (c) => {
    const { listAvailableGenres, readGenreProfile } = await import("@actalk/inkos-core");
    const rawGenres = await listAvailableGenres(root);
    const genres = await Promise.all(
      rawGenres.map(async (g) => {
        try {
          const { profile } = await readGenreProfile(root, g.id);
          return { ...g, language: profile.language ?? "zh" };
        } catch {
          return { ...g, language: "zh" };
        }
      }),
    );
    return c.json({ genres });
  });

  // --- Book Create ---

  app.post("/api/v1/books/create", async (c) => {
    const body = await c.req.json<{
      title: string;
      genre: string;
      language?: string;
      platform?: string;
      chapterWordCount?: number;
      targetChapters?: number;
      blurb?: string;
    }>();

    const now = new Date().toISOString();
    const bookConfig = buildStudioBookConfig(body, now);
    const bookId = bookConfig.id;
    const bookDir = state.bookDir(bookId);

    if (!bookId) {
      return c.json({ error: "Could not derive a valid book id from title" }, 400);
    }
    if (await completeBookExists(bookDir)) {
      return c.json({ error: `Book "${bookId}" already exists` }, 409);
    }

    broadcast("book:creating", { bookId, title: body.title });
    bookCreateStatus.set(bookId, { status: "creating" });

    const pipeline = new PipelineRunner(await buildPipelineConfig());
    const tools = createInteractionToolsFromDeps(pipeline, state);
    processProjectInteractionRequest({
      projectRoot: root,
      request: {
        intent: "create_book",
        title: body.title,
        genre: body.genre,
        language: body.language === "en" ? "en" : body.language === "zh" ? "zh" : undefined,
        platform: body.platform,
        chapterWordCount: body.chapterWordCount,
        targetChapters: body.targetChapters,
        blurb: body.blurb,
      },
      tools,
    }).then(
      async (result: {
        readonly session: { readonly activeBookId?: string };
        readonly details?: Readonly<Record<string, unknown>>;
      }) => {
        const createdBookId = resolveCreatedBookIdFromDetails(result.details);
        if (!createdBookId) {
          const error = "Book creation did not produce a completed book artifact.";
          bookCreateStatus.set(bookId, { status: "error", error });
          broadcast("book:error", { bookId, error });
          return;
        }
        if (!await completeBookExists(join(root, "books", createdBookId))) {
          const error = "Book creation artifact is incomplete on disk.";
          bookCreateStatus.set(createdBookId, { status: "error", error });
          broadcast("book:error", { bookId: createdBookId, error });
          return;
        }
        const book = await loadStudioBookListSummary(state, createdBookId).catch(() => undefined);
        bookCreateStatus.delete(createdBookId);
        broadcast("book:created", { bookId: createdBookId, ...(book ? { book } : {}) });
      },
      (e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        bookCreateStatus.set(bookId, { status: "error", error });
        broadcast("book:error", { bookId, error });
      },
    );

    return c.json({ status: "creating", bookId });
  });

  app.get("/api/v1/books/:id/create-status", async (c) => {
    const id = c.req.param("id");
    const status = bookCreateStatus.get(id);
    if (status) {
      return c.json(status);
    }
    // No in-memory entry. On success the entry is deleted, and a long architect
    // run (or a server restart) can also drop it — so a bare 404 is ambiguous
    // ("done" vs "never existed"). Check disk: if the foundation is fully
    // written, the book really is ready; report that truthfully.
    if (await isBookFoundationComplete(state.bookDir(id))) {
      return c.json({ status: "ready" });
    }
    return c.json({ status: "missing" }, 404);
  });

  // --- Chapters ---

  app.get("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = normalizePositiveIntegerParam(c.req.param("num"), "chapter number");
    const bookDir = state.bookDir(id);
    const chaptersDir = join(bookDir, "chapters");

    try {
      const files = await readdir(chaptersDir);
      const paddedNum = String(num).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);
      const content = await readFile(join(chaptersDir, match), "utf-8");
      return c.json({ chapterNumber: num, filename: match, content });
    } catch {
      return c.json({ error: "Chapter not found" }, 404);
    }
  });

  // --- Chapter Save ---

  app.put("/api/v1/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = normalizePositiveIntegerParam(c.req.param("num"), "chapter number");
    const { content } = await c.req.json<{ content: string }>();

    try {
      const result = await executeCoreMutation({ state }, {
        kind: "save-chapter",
        bookId: id,
        chapterNumber: num,
        content,
      });
      broadcast("chapter:edited", { bookId: id, chapterNumber: num });
      return c.json({
        ok: true,
        chapterNumber: result.chapterNumber,
        status: result.status,
        warning: result.warning,
      });
    } catch (e) {
      rethrowCoreMutationApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth files ---

  // Flat-file whitelist — the pre-Phase-5 story root files plus dev's legacy
  // editor targets (author_intent / current_focus / volume_outline).
  //
  // Phase 5 cleanup #3 moved the authoritative YAML frontmatter + outline prose
  // into story/outline/ and character sheets into story/roles/. `story_bible.md`
  // and `book_rules.md` now exist only as compat pointer shims — we still allow
  // reading them so legacy books keep rendering, but the server-side writer
  // (write_truth_file) no longer accepts them as edit targets.
  const TRUTH_FLAT_FILES = [
    "author_intent.md", "current_focus.md",
    "story_bible.md", "book_rules.md", "volume_outline.md", "current_state.md",
    "particle_ledger.md", "pending_hooks.md", "chapter_summaries.md",
    "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    "parent_canon.md",
  ];

  // Authoritative Phase 5 paths — prose outline + role sheets live under
  // dedicated subdirectories of story/. The full path (relative to story/) is
  // matched literally here. `节奏原则.md` / `rhythm_principles.md` is optional
  // after Phase 5 consolidation (rhythm lives in volume_map's closing paragraph);
  // the entries stay whitelisted for legacy books and manual overrides.
  const TRUTH_OUTLINE_FILES = [
    "outline/story_frame.md",
    "outline/volume_map.md",
    "outline/节奏原则.md",
    "outline/rhythm_principles.md",
  ];

  // Pointer shims that the runtime no longer treats as authoritative. The
  // GET handler tags them with `legacy: true` so the UI can surface that the
  // edits won't land where the user expects.
  const LEGACY_SHIM_FILES = new Set(["story_bible.md", "book_rules.md"]);
  const RUNTIME_DIAGNOSTIC_FILE_RE = /^runtime\/(?:chapter-\d{4}\.(?:intent\.md|plan\.md|context\.json|rule-stack\.yaml|trace\.json|claims\.json|claim-brief\.md)|recovery\.json|tier2_current_arc\.md|volume-contracts\.json|volume-progress\.json|volume-dashboard\.md|volume-\d{3}\.(?:contract\.json|dashboard\.md))$/;

  /**
   * Validate a requested truth-file path:
   *   1. Must be one of the declared flat files, an outline/* allow-listed
   *      entry, a runtime diagnostic file, or a roles/**\/*.md file under
   *      主要角色/ | 次要角色/.
   *   2. Must resolve to a path inside bookDir/story/ (no `..`, no absolute
   *      paths, no traversal via the tier-name segment).
   */
  function resolveTruthFilePath(bookDir: string, file: string): string | null {
    // Reject absolute paths, traversal, null bytes outright.
    if (!file || file.includes("\0") || isAbsolute(file) || file.includes("..")) {
      return null;
    }

    // Phase hotfix 3: accept both Chinese and English locale role dirs so
    // English-layout books (roles/major, roles/minor) are reachable through
    // Studio. The runtime reader (utils/outline-paths.ts:75) already scans
    // both — Studio used to drop English books to read-only.
    const allowed =
      TRUTH_FLAT_FILES.includes(file)
      || TRUTH_OUTLINE_FILES.includes(file)
      || RUNTIME_DIAGNOSTIC_FILE_RE.test(file)
      || /^roles\/(主要角色|次要角色|major|minor)\/[^/]+\.md$/.test(file);

    if (!allowed) return null;

    const storyDir = resolve(bookDir, "story");
    const resolved = resolve(storyDir, file);
    const relativePath = relative(storyDir, resolved);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return null;
    }
    return resolved;
  }

  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  // Use `:file{.+}` wildcard so nested paths (outline/..., roles/.../...) match.
  app.get("/api/v1/books/:id/truth/:file{.+}", async (c) => {
    const file = c.req.param("file");
    const id = c.req.param("id");

    const bookDir = state.bookDir(id);
    const resolved = resolveTruthFilePath(bookDir, file);
    if (!resolved) {
      return c.json({ error: "Invalid truth file" }, 400);
    }

    // Phase 5: new-layout books keep the authoritative prose under outline/.
    // A legacy book may only have story_bible.md / book_rules.md on disk —
    // we still serve those for read-only display, but flag them so the UI
    // can warn users their edits won't reach the runtime.
    // Hotfix: only tag as legacy when the book actually HAS the new layout.
    // Pre-Phase-5 books use story_bible/book_rules as the authoritative source.
    const { isNewLayoutBook, tryParseBookRulesFrontmatter } = await import("@actalk/inkos-core");
    const legacy = LEGACY_SHIM_FILES.has(file) && await isNewLayoutBook(bookDir);

    try {
      const content = await readFile(resolved, "utf-8");
      // Files like outline/story_frame.md carry a YAML frontmatter block of
      // structured fields (protagonist / genreLock / prohibitions / ...). Parse
      // it here so the UI can render those as friendly cards instead of dumping
      // raw YAML at the reader. `content` stays raw so the editor round-trips it
      // unchanged; `body` is the prose with the frontmatter stripped.
      const parsed = tryParseBookRulesFrontmatter(content);
      const structured = parsed ? { frontmatter: parsed.rules, body: parsed.body } : {};
      const runtimeDiagnostic = RUNTIME_DIAGNOSTIC_FILE_RE.test(file);
      return c.json({
        file,
        content,
        ...structured,
        ...(legacy ? { legacy: true } : {}),
        ...(runtimeDiagnostic ? { readonly: true, readonlyReason: "runtime-diagnostic" } : {}),
      });
    } catch {
      const runtimeDiagnostic = RUNTIME_DIAGNOSTIC_FILE_RE.test(file);
      return c.json({
        file,
        content: null,
        ...(legacy ? { legacy: true } : {}),
        ...(runtimeDiagnostic ? { readonly: true, readonlyReason: "runtime-diagnostic" } : {}),
      });
    }
  });

  // --- Analytics ---

  app.get("/api/v1/books/:id/analytics", async (c) => {
    const id = c.req.param("id");
    try {
      const chapters = await state.loadChapterIndex(id);
      return c.json(computeAnalytics(id, chapters));
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });

  // --- Actions ---

  app.post("/api/v1/books/:id/operations/:requestId/cancel", async (c) => {
    const id = c.req.param("id");
    const requestId = c.req.param("requestId");
    const operation = activeBookOperations.get(id);
    if (!operation || operation.requestId !== requestId) {
      return c.json({ error: "Active operation not found." }, 404);
    }
    if (!operation.controller.signal.aborted) {
      operation.controller.abort(new DOMException("Operation cancelled by user", "AbortError"));
      broadcast(`${operation.kind}:cancel-requested`, { bookId: id, requestId });
    }
    return c.json({ status: "cancelling", bookId: id, requestId }, 202);
  });

  app.post("/api/v1/books/:id/write-next", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number }>().catch(() => ({ wordCount: undefined }));
    const operation = beginStudioOperation(id, "write");
    launchStudioOperation({
      operation,
      run: async () => {
        const pipeline = new PipelineRunner(await buildPipelineConfig({
          bookIdForSettings: id,
          bookIdForTelemetry: id,
          signal: operation.controller.signal,
        }));
        return pipeline.writeNextChapter(id, body.wordCount);
      },
      completeData: (result) => ({
        chapterNumber: result.chapterNumber,
        status: result.status,
        title: result.title,
        wordCount: result.wordCount,
        ...(result.operationId ? { operationId: result.operationId } : {}),
        ...(result.recovery ? { recovery: result.recovery } : {}),
      }),
    });

    return c.json({ status: "writing", bookId: id, requestId: operation.requestId }, 202);
  });

  app.post("/api/v1/books/:id/draft", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ wordCount?: number; context?: string }>().catch(() => ({ wordCount: undefined, context: undefined }));

    const operation = beginStudioOperation(id, "draft");
    launchStudioOperation({
      operation,
      run: async () => {
        const pipeline = new PipelineRunner(await buildPipelineConfig({
          bookIdForTelemetry: id,
          signal: operation.controller.signal,
        }));
        return pipeline.writeDraft(id, body.context, body.wordCount);
      },
      completeData: (result) => ({
        chapterNumber: result.chapterNumber,
        title: result.title,
        wordCount: result.wordCount,
        ...(result.operationId ? { operationId: result.operationId } : {}),
        ...(result.recovery ? { recovery: result.recovery } : {}),
      }),
    });

    return c.json({ status: "drafting", bookId: id, requestId: operation.requestId }, 202);
  });

  app.get("/api/v1/books/:id/eval", async (c) => {
    const id = c.req.param("id");
    const chapters = c.req.query("chapters");
    try {
      return c.json(await evaluateBookQuality({ state, bookId: id, chapters }));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/consolidate", async (c) => {
    const id = c.req.param("id");
    try {
      const pipelineConfig = await buildPipelineConfig();
      const consolidator = new ConsolidatorAgent({
        client: pipelineConfig.client,
        model: pipelineConfig.model,
        projectRoot: root,
      });
      const result = await executeCoreMutation({
        state,
        pipeline: {
          consolidateBook: async (bookId) => await consolidator.consolidate(state.bookDir(bookId)),
        },
      }, { kind: "consolidate-book", bookId: id });
      broadcast("consolidate:complete", { bookId: id, ...result });
      return c.json(result);
    } catch (e) {
      rethrowCoreMutationApiError(e);
      broadcast("consolidate:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/plan", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ context?: string }>().catch(() => ({ context: undefined }));
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForTelemetry: id }));
      return c.json(await executeCoreMutation({ state, pipeline }, {
        kind: "plan-chapter",
        bookId: id,
        context: body.context,
      }));
    } catch (e) {
      rethrowCoreMutationApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/compose", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ context?: string }>().catch(() => ({ context: undefined }));
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForTelemetry: id }));
      return c.json(await executeCoreMutation({ state, pipeline }, {
        kind: "compose-chapter",
        bookId: id,
        context: body.context,
      }));
    } catch (e) {
      rethrowCoreMutationApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/repair-state/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = normalizePositiveIntegerParam(c.req.param("chapter"), "chapter number");
    const operation = beginStudioOperation(id, "repair-state");
    launchStudioOperation({
      operation,
      run: async () => {
        const pipeline = new PipelineRunner(await buildPipelineConfig({
          bookIdForTelemetry: id,
          signal: operation.controller.signal,
        }));
        return pipeline.repairChapterState(id, chapterNum);
      },
      completeData: (result) => ({ chapter: chapterNum, status: result.status }),
    });
    return c.json({ status: "repairing", bookId: id, chapter: chapterNum, requestId: operation.requestId }, 202);
  });

  app.post("/api/v1/books/:id/foundation/revise", async (c) => {
    const id = c.req.param("id");
    const { feedback } = await c.req.json<{ feedback?: string }>().catch(() => ({ feedback: undefined }));
    if (!feedback?.trim()) {
      return c.json({ error: "feedback is required" }, 400);
    }
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForTelemetry: id }));
      await executeCoreMutation({ state, pipeline }, {
        kind: "revise-foundation",
        bookId: id,
        feedback: feedback.trim(),
      });
      broadcast("foundation:revised", { bookId: id });
      return c.json({ ok: true });
    } catch (e) {
      rethrowCoreMutationApiError(e);
      broadcast("foundation:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapters/:num/approve", async (c) => {
    const id = c.req.param("id");
    const num = normalizePositiveIntegerParam(c.req.param("num"), "chapter number");

    try {
      const result = await executeCoreMutation({ state }, {
        kind: "approve",
        bookId: id,
        chapterNumber: num,
      });
      return c.json({ ok: true, chapterNumber: result.chapterNumber, status: result.status });
    } catch (e) {
      rethrowCoreMutationApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/books/:id/chapters/:num/reject", async (c) => {
    const id = c.req.param("id");
    const num = normalizePositiveIntegerParam(c.req.param("num"), "chapter number");

    try {
      const result = await executeCoreMutation({ state }, {
        kind: "reject",
        bookId: id,
        chapterNumber: num,
      });
      return c.json({
        ok: true,
        chapterNumber: result.chapterNumber,
        status: result.status,
        rolledBackTo: result.keepSubsequent ? undefined : result.rolledBackTo,
        discarded: result.discarded,
      });
    } catch (e) {
      rethrowCoreMutationApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- SSE ---

  app.get("/api/v1/events", (c) => {
    return streamSSE(c, async (stream) => {
      let writeQueue = Promise.resolve();
      const enqueue = (event: string, data: string): void => {
        writeQueue = writeQueue
          .then(() => stream.writeSSE({ event, data }))
          .catch(() => undefined);
      };
      const handler: EventHandler = (event, data) => {
        enqueue(event, JSON.stringify(data));
      };
      subscribers.add(handler);
      await stream.writeSSE({ event: "ping", data: "" });

      // Keep alive
      const keepAlive = setInterval(() => {
        enqueue("ping", "");
      }, 30000);

      stream.onAbort(() => {
        subscribers.delete(handler);
        clearInterval(keepAlive);
      });

      // Block until aborted
      await new Promise(() => {});
    });
  });

  // --- Model discovery ---

  app.get("/api/v1/services", async (c) => {
    const secrets = await loadSecrets(root);
    const endpoints = getAllEndpoints().filter((ep) => ep.id !== "custom");

    // Fast: only check connection status from secrets, no external API calls.
    const services = endpoints.map((ep) => ({
      service: ep.id,
      label: ep.label,
      group: ep.group,
      connected: Boolean(secrets.services[ep.id]?.apiKey),
    })).sort(compareServiceListItems);

    // Add custom services from inkos.json
    try {
      const config = await loadRawConfig(root);
      for (const svc of normalizeServiceConfig((config.llm as Record<string, unknown> | undefined)?.services)) {
        if (svc.service === "custom") {
          const secretKey = `custom:${svc.name}`;
          services.push({
            service: secretKey,
            label: svc.name ?? "Custom",
            group: undefined,
            connected: Boolean(secrets.services[secretKey]?.apiKey),
          });
        }
      }
    } catch { /* no config file */ }

    return c.json({ services });
  });

  app.get("/api/v1/services/config", async (c) => {
    const config = await loadRawConfig(root);
    const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
    const services = normalizeServiceConfig(llm.services);
    const envConfig = await readEnvConfigStatus(root);
    return c.json({
      services,
      service: typeof llm.service === "string" ? llm.service : null,
      defaultModel: llm.defaultModel ?? null,
      configSource: "studio" satisfies LLMConfigSource,
      storedConfigSource: normalizeConfigSource(llm.configSource),
      envConfig,
    });
  });

  app.post("/api/v1/services/config/import-env", async (c) => {
    const env = await readEffectiveEnvConfigValues(root);
    if (!env || !env.values.apiKey) {
      return c.json({
        error: pick(
          await currentProjectLanguage(),
          "未检测到可导入的 LLM 环境变量配置，或缺少 INKOS_LLM_API_KEY。",
          "No importable LLM environment variable configuration was detected, or INKOS_LLM_API_KEY is missing.",
        ),
      }, 400);
    }
    const importedApiKey = env.values.apiKey;

    const explicitService = env.values.service?.trim();
    const guessedService = env.values.baseUrl ? guessServiceFromBaseUrl(env.values.baseUrl) : null;
    const service = explicitService || guessedService || "custom";

    const entry: ServiceConfigEntry = service === "custom"
      ? {
          service: "custom",
          name: "Env LLM",
          ...(env.values.baseUrl ? { baseUrl: env.values.baseUrl } : {}),
        }
      : { service };
    const serviceKey = serviceConfigKey(entry);
    return await withProjectMutationLock(root, () => mutateProjectConfig(root, async (config) => {
      config.llm = config.llm ?? {};
      const llm = config.llm as Record<string, unknown>;
      const existingServices = normalizeServiceConfig(llm.services);
      llm.services = mergeServiceConfig(existingServices, [entry]);
      llm.service = serviceKey;
      llm.configSource = "studio";
      if (env.values.model) llm.defaultModel = env.values.model;
      syncTopLevelLlmMirror(llm);

      const secrets = await loadSecrets(root);
      secrets.services[serviceKey] = { apiKey: importedApiKey };
      await saveSecrets(root, secrets);

      return c.json({
        ok: true,
        source: env.source,
        service: serviceKey,
        defaultModel: env.values.model ?? null,
      });
    }));
  });

  app.put("/api/v1/services/config", async (c) => {
    const body = await c.req.json<{ services?: unknown; defaultModel?: string; configSource?: LLMConfigSource; service?: string }>();
    if (body.configSource === "env") {
      return c.json({
        error: pick(
          await currentProjectLanguage(),
          "Studio 运行时不支持切换到 env；env 只在 CLI/daemon/部署运行时作为覆盖层使用。",
          "The Studio runtime does not support switching to env; env only acts as an override layer in the CLI/daemon/deployment runtimes.",
        ),
      }, 400);
    }
    await mutateRawConfig(root, (config) => {
      config.llm = config.llm ?? {};
      const llm = config.llm as Record<string, unknown>;
      if (body.services !== undefined) {
        llm.services = mergeServiceConfig(normalizeServiceConfig(llm.services), normalizeServiceConfig(body.services));
      }
      if (body.defaultModel !== undefined) llm.defaultModel = body.defaultModel;
      if (body.configSource !== undefined) llm.configSource = normalizeConfigSource(body.configSource);
      if (body.service !== undefined) llm.service = body.service;
      syncTopLevelLlmMirror(llm);
    });
    return c.json({ ok: true });
  });

  app.delete("/api/v1/services/:service", async (c) => {
    const service = c.req.param("service");
    await withProjectMutationLock(root, () => mutateProjectConfig(root, async (config) => {
      const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
      const nextServices = normalizeServiceConfig(llm.services)
        .filter((entry) => serviceConfigKey(entry) !== service);

      if (!config.llm) config.llm = {};
      const nextLlm = config.llm as Record<string, unknown>;
      nextLlm.services = nextServices;
      if (nextLlm.service === service) {
        delete nextLlm.service;
        delete nextLlm.defaultModel;
      }
      const secrets = await loadSecrets(root);
      delete secrets.services[service];
      await saveSecrets(root, secrets);
    }));
    modelListCache.clear();
    return c.json({ ok: true, service });
  });

  app.post("/api/v1/services/:service/test", async (c) => {
    const service = c.req.param("service");
    const { apiKey, baseUrl, apiFormat, stream, model } = await c.req.json<{
      apiKey: string;
      baseUrl?: string;
      apiFormat?: "chat" | "responses";
      stream?: boolean;
      model?: string;
    }>();

    const language = await currentProjectLanguage();
    const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service, baseUrl);
    if (!resolvedBaseUrl) {
      return c.json({
        ok: false,
        error: pick(language, `未知服务商: ${service}`, `Unknown service: ${service}`),
      }, 400);
    }

    const storedSecrets = await loadSecrets(root);
    const effectiveApiKey = apiKey?.trim() || storedSecrets.services[service]?.apiKey || "";
    const baseService = isCustomServiceId(service) ? "custom" : service;
    const apiKeyOptional = isApiKeyOptionalForEndpoint({
      provider: resolveServiceProviderFamily(baseService) ?? "openai",
      baseUrl: resolvedBaseUrl,
    });
    if (!effectiveApiKey && !apiKeyOptional) {
      return c.json({
        ok: false,
        error: pick(language, "API Key 不能为空", "API Key must not be empty"),
      }, 400);
    }

    const rawConfig = await loadRawConfig(root).catch(() => ({} as Record<string, unknown>));
    const llm = (rawConfig.llm as Record<string, unknown> | undefined) ?? {};
    const probe = await probeServiceCapabilities({
      root,
      service,
      apiKey: effectiveApiKey,
      baseUrl: resolvedBaseUrl,
      preferredApiFormat: apiFormat,
      preferredStream: stream,
      preferredModel: typeof model === "string" ? model.trim() : undefined,
      proxyUrl: typeof llm.proxyUrl === "string" ? llm.proxyUrl : undefined,
      language,
    });

    // B12: 升级响应 shape 为 { probe, chat, ... }，同时保留老字段供 UI 过渡期兼容
    const connectionFailed = pick(language, "连接失败", "Connection failed");
    const probeStatus = {
      ok: probe.ok,
      models: probe.models?.length ?? 0,
      ...(probe.ok ? {} : { error: probe.error ?? connectionFailed }),
    };

    if (!probe.ok) {
      return c.json({
        ok: false,
        error: probe.error ?? connectionFailed,
        probe: probeStatus,
        chat: null,
      }, 400);
    }

    return c.json({
      ok: true,
      modelCount: probe.models.length,
      models: probe.models,
      selectedModel: probe.selectedModel,
      detected: {
        apiFormat: probe.apiFormat,
        stream: probe.stream,
        baseUrl: probe.baseUrl,
        modelsSource: probe.modelsSource,
      },
      // B12 新字段：两步验证状态
      probe: probeStatus,
      chat: null,  // probeServiceCapabilities 本身只做 probe，chat hello 在 Studio 的 follow-up 调用里单独触发
    });
  });

  app.put("/api/v1/services/:service/secret", async (c) => {
    const service = c.req.param("service");
    const { apiKey, clear } = await c.req.json<{ apiKey?: string; clear?: boolean }>();
    const trimmedKey = apiKey?.trim() ?? "";
    if (trimmedKey) {
      if (!isHeaderSafeApiKey(trimmedKey)) {
        return c.json({
          ok: false,
          error: pick(
            await currentProjectLanguage(),
            "API Key 只能包含可放进 HTTP Authorization header 的非空白 ASCII 字符；请不要粘贴连接失败提示或诊断文本。",
            "API Key may only contain non-whitespace ASCII characters that fit in an HTTP Authorization header; do not paste connection failure hints or diagnostic text.",
          ),
        }, 400);
      }
    }
    await withProjectMutationLock(root, async () => {
      const secrets = await loadSecrets(root);
      if (trimmedKey) secrets.services[service] = { apiKey: trimmedKey };
      else if (clear === true) delete secrets.services[service];
      await saveSecrets(root, secrets);
    });
    return c.json({ ok: true, configured: trimmedKey ? true : undefined, cleared: clear === true });
  });

  app.get("/api/v1/services/:service/secret", async (c) => {
    const service = c.req.param("service");
    const secrets = await loadSecrets(root);
    return c.json({
      apiKey: "",
      configured: Boolean(secrets.services[service]?.apiKey),
    });
  });

  app.get("/api/v1/services/models", async (c) => {
    const secrets = await loadSecrets(root);
    const endpoints = getAllEndpoints()
      .filter((ep) => ep.id !== "custom" && Boolean(secrets.services[ep.id]?.apiKey));

    const groups = endpoints.map((ep) => ({
      service: ep.id,
      label: ep.label,
      models: ep.models
        .filter((m) => m.enabled !== false)
        .filter((m) => isTextChatModelId(m.id))
        .map((m) => ({
          id: m.id,
          name: m.id,
          ...(typeof m.maxOutput === "number" ? { maxOutput: m.maxOutput } : {}),
          ...(m.contextWindowTokens > 0 ? { contextWindow: m.contextWindowTokens } : {}),
        })),
    }));

    return c.json({ groups });
  });

  app.get("/api/v1/services/models/custom", async (c) => {
    const secrets = await loadSecrets(root);
    let config: Record<string, unknown> = {};
    try {
      config = await loadRawConfig(root);
    } catch {
      // no config file
    }

    const llm = (config.llm as Record<string, unknown> | undefined) ?? {};
    const selectedService = typeof llm.service === "string" ? llm.service : "";
    const defaultModel = typeof llm.defaultModel === "string" && llm.defaultModel.trim()
      ? llm.defaultModel.trim()
      : typeof llm.model === "string" && llm.model.trim()
        ? llm.model.trim()
        : "";
    const customs = normalizeServiceConfig(llm.services)
      .filter((s) => s.service === "custom")
      .map((s) => ({
        id: `custom:${s.name ?? "Custom"}`,
        baseUrl: s.baseUrl ?? "",
        label: s.name ?? "Custom",
      }))
      .filter((s) => s.baseUrl && Boolean(secrets.services[s.id]?.apiKey));

    const groups = await Promise.all(customs.map(async (s) => {
      const liveModels = filterTextChatModels(
        await probeModelsFromUpstream(s.baseUrl, secrets.services[s.id].apiKey, 10_000),
      );
      const models = liveModels.length > 0
        ? liveModels
        : selectedService === s.id && defaultModel
          ? [{ id: defaultModel, name: defaultModel, contextWindow: 0 }]
          : [];
      return {
        service: s.id,
        label: s.label,
        models,
      };
    }));

    return c.json({ groups });
  });

  app.get("/api/v1/services/:service/models", async (c) => {
    const service = c.req.param("service");
    const refresh = c.req.query("refresh") === "1";
    const secrets = await loadSecrets(root);
    const apiKey = c.req.query("apiKey") || secrets.services[service]?.apiKey || "";

    const resolvedBaseUrl = await resolveConfiguredServiceBaseUrl(root, service);
    const baseService = isCustomServiceId(service) ? "custom" : service;
    const apiKeyOptional = isApiKeyOptionalForEndpoint({
      provider: resolveServiceProviderFamily(baseService) ?? "openai",
      baseUrl: resolvedBaseUrl,
    });

    // No key = no models, except local/self-hosted endpoints such as Ollama.
    if (!apiKey && !apiKeyOptional) return c.json({ models: [] });

    // Cache by service + resolved baseUrl + apiKey fingerprint; valid for 10 min unless ?refresh=1
    const cacheKey = `${service}::${resolvedBaseUrl ?? ""}::${apiKey.slice(-8)}`;
    if (!refresh) {
      const cached = modelListCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
        return c.json({ models: cached.models });
      }
    }

    // B13: 走 listModelsForService 走 live probe + bank 交叉，返回带元数据的 models
    const enriched = await listModelsForService(
      isCustomServiceId(service) ? "custom" : service,
      apiKey,
      isCustomServiceId(service) ? resolvedBaseUrl ?? undefined : undefined,
    );
    const models = filterTextChatModels(enriched).map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.maxOutput !== undefined ? { maxOutput: m.maxOutput } : {}),
      ...(m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
    }));
    modelListCache.set(cacheKey, { models, at: Date.now() });
    return c.json({ models });
  });

  // --- Project info ---

  app.get("/api/v1/project", async (c) => {
    let currentConfig: ProjectConfig;
    let raw: Record<string, unknown>;
    try {
      currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
      // Check if language was explicitly set in inkos.json (not just the schema default)
      raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, unknown>;
    } catch (error) {
      throw new ApiError(
        500,
        "PROJECT_CONFIG_INVALID",
        `Failed to load inkos.json: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const languageExplicit = "language" in raw && raw.language !== "";

    return c.json({
      name: currentConfig.name,
      language: currentConfig.language,
      languageExplicit,
      model: currentConfig.llm.model,
      provider: currentConfig.llm.provider,
      baseUrl: currentConfig.llm.baseUrl,
      stream: currentConfig.llm.stream,
      temperature: currentConfig.llm.temperature,
    });
  });

  // --- Config editing ---

  app.put("/api/v1/project", async (c) => {
    const updates = await c.req.json<Record<string, unknown>>();
    try {
      await mutateRawConfig(root, (existing) => {
        existing.llm = existing.llm && typeof existing.llm === "object" && !Array.isArray(existing.llm)
          ? existing.llm
          : {};
        const llm = existing.llm as Record<string, unknown>;
        if (updates.temperature !== undefined) llm.temperature = updates.temperature;
        if (updates.stream !== undefined) llm.stream = updates.stream;
        if (updates.language === "zh" || updates.language === "en") existing.language = updates.language;
      });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.get("/api/v1/project/input-governance-mode", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ mode: raw.inputGovernanceMode === "legacy" ? "legacy" : "v2" });
  });

  app.put("/api/v1/project/input-governance-mode", async (c) => {
    const { mode } = await c.req.json<{ mode?: unknown }>();
    const parsed = InputGovernanceModeSchema.safeParse(mode);
    if (!parsed.success) {
      return c.json({ error: "mode must be legacy or v2" }, 400);
    }
    await mutateRawConfig(root, (raw) => {
      raw.inputGovernanceMode = parsed.data;
    });
    return c.json({ ok: true, mode: parsed.data });
  });

  app.get("/api/v1/project/detection", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ detection: raw.detection ?? null });
  });

  app.put("/api/v1/project/detection", async (c) => {
    const { detection } = await c.req.json<{ detection?: unknown }>();
    if (detection !== null) {
      const parsed = DetectionConfigSchema.safeParse(detection);
      if (!parsed.success) return c.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, 400);
    }
    const savedDetection = await mutateRawConfig(root, (raw) => {
      if (detection === null) delete raw.detection;
      else raw.detection = DetectionConfigSchema.parse(detection);
      return raw.detection ?? null;
    });
    return c.json({ ok: true, detection: savedDetection });
  });

  // --- Truth files browser ---

  app.get("/api/v1/books/:id/truth", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);
    const storyDir = join(bookDir, "story");

    async function listDir(subdir: string): Promise<string[]> {
      try {
        const entries = await readdir(join(storyDir, subdir));
        return entries.filter((f) => f.endsWith(".md") || f.endsWith(".json") || f.endsWith(".yaml"));
      } catch {
        return [];
      }
    }

    // Hotfix: only tag shim files as legacy when the book has the new layout.
    const { isNewLayoutBook } = await import("@actalk/inkos-core");
    const newLayout = await isNewLayoutBook(bookDir);

    async function describe(relPath: string): Promise<{ readonly name: string; readonly size: number; readonly preview: string; readonly legacy?: true; readonly readonly?: true; readonly readonlyReason?: string } | null> {
      try {
        const content = await readFile(join(storyDir, relPath), "utf-8");
        const isShim = LEGACY_SHIM_FILES.has(relPath) && newLayout;
        const isRuntimeDiagnostic = RUNTIME_DIAGNOSTIC_FILE_RE.test(relPath);
        const entry: { readonly name: string; readonly size: number; readonly preview: string; readonly legacy?: true; readonly readonly?: true; readonly readonlyReason?: string } =
          isShim
            ? { name: relPath, size: content.length, preview: content.slice(0, 200), legacy: true }
            : isRuntimeDiagnostic
              ? { name: relPath, size: content.length, preview: content.slice(0, 200), readonly: true, readonlyReason: "runtime-diagnostic" }
              : { name: relPath, size: content.length, preview: content.slice(0, 200) };
        return entry;
      } catch {
        return null;
      }
    }

    try {
      // Flat story/ files (legacy + runtime logs)
      const flatFiles = (await listDir(".")).filter((f) => !f.startsWith("outline") && !f.startsWith("roles"));
      // Phase 5 outline/ files
      const outlineFiles = (await listDir("outline")).map((f) => `outline/${f}`);
      // Phase 5 roles/主要角色 + roles/次要角色, plus Phase hotfix 3
      // English-locale equivalents so en-language books are visible.
      const majorRolesZh = (await listDir("roles/主要角色")).map((f) => `roles/主要角色/${f}`);
      const minorRolesZh = (await listDir("roles/次要角色")).map((f) => `roles/次要角色/${f}`);
      const majorRolesEn = (await listDir("roles/major")).map((f) => `roles/major/${f}`);
      const minorRolesEn = (await listDir("roles/minor")).map((f) => `roles/minor/${f}`);
      const runtimeFiles = (await listDir("runtime"))
        .map((f) => `runtime/${f}`)
        .filter((f) => RUNTIME_DIAGNOSTIC_FILE_RE.test(f));

      const all = [
        ...flatFiles,
        ...outlineFiles,
        ...majorRolesZh,
        ...minorRolesZh,
        ...majorRolesEn,
        ...minorRolesEn,
        ...runtimeFiles,
      ];
      const described = await Promise.all(all.map(describe));
      const result = described.filter((x): x is NonNullable<typeof x> => x !== null);
      return c.json({ files: result });
    } catch {
      return c.json({ files: [] });
    }
  });

  // --- Daemon control ---

  let schedulerInstance: Scheduler | null = null;

  app.get("/api/v1/daemon", (c) => {
    return c.json({
      running: schedulerInstance?.isRunning ?? false,
    });
  });

  app.post("/api/v1/daemon/start", async (c) => {
    if (schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon already running" }, 400);
    }
    try {
      const currentConfig = await loadCurrentProjectConfig();
      const scheduler = new Scheduler({
        ...(await buildPipelineConfig()),
        writeCron: currentConfig.daemon.schedule.writeCron,
        maxConcurrentBooks: currentConfig.daemon.maxConcurrentBooks,
        chaptersPerCycle: currentConfig.daemon.chaptersPerCycle,
        retryDelayMs: currentConfig.daemon.retryDelayMs,
        cooldownAfterChapterMs: currentConfig.daemon.cooldownAfterChapterMs,
        maxChaptersPerDay: currentConfig.daemon.maxChaptersPerDay,
        onChapterComplete: (bookId, chapter, status) => {
          broadcast("daemon:chapter", { bookId, chapter, status });
        },
        onError: (bookId, error) => {
          broadcast("daemon:error", { bookId, error: error.message });
        },
      });
      schedulerInstance = scheduler;
      broadcast("daemon:started", {});
      void scheduler.start().catch((e) => {
        const error = e instanceof Error ? e : new Error(String(e));
        if (schedulerInstance === scheduler) {
          scheduler.stop();
          schedulerInstance = null;
          broadcast("daemon:stopped", {});
        }
        broadcast("daemon:error", { bookId: "scheduler", error: error.message });
      });
      return c.json({ ok: true, running: true });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  app.post("/api/v1/daemon/stop", (c) => {
    if (!schedulerInstance?.isRunning) {
      return c.json({ error: "Daemon not running" }, 400);
    }
    schedulerInstance.stop();
    schedulerInstance = null;
    broadcast("daemon:stopped", {});
    return c.json({ ok: true, running: false });
  });

  // --- Logs ---

  app.get("/api/v1/logs", async (c) => {
    const logPath = join(root, "inkos.log");
    try {
      const content = await readFile(logPath, "utf-8");
      const lines = content.trim().split("\n").slice(-100);
      const entries = lines.map((line) => {
        try { return JSON.parse(line); } catch { return { message: line }; }
      });
      return c.json({ entries });
    } catch {
      return c.json({ entries: [] });
    }
  });

  // --- Agent chat ---

  app.get("/api/v1/interaction/session", async (c) => {
    const session = await loadProjectSession(root);
    const activeBookId = await resolveSessionActiveBook(root, session);
    return c.json({
      session: activeBookId && session.activeBookId !== activeBookId
        ? { ...session, activeBookId }
        : session,
      activeBookId,
    });
  });

  // -- Per-book session endpoints --

  app.get("/api/v1/sessions", async (c) => {
    const bookId = c.req.query("bookId");
    const sessions = await listBookSessions(root, bookId === undefined ? null : bookId === "null" ? null : bookId);
    return c.json({ sessions });
  });

  app.get("/api/v1/sessions/:sessionId", async (c) => {
    const session = await loadBookSession(root, c.req.param("sessionId"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ session });
  });

  app.post("/api/v1/sessions", async (c) => {
    const body = await c.req.json<{ bookId?: string | null; sessionId?: string; sessionKind?: string }>().catch(() => ({}));
    const bookId = normalizeApiBookId((body as { bookId?: unknown }).bookId, "bookId");
    const sessionKind = normalizeStudioSessionKind(
      (body as { sessionKind?: unknown }).sessionKind,
      bookId ? "book" : "chat",
    );
    const sessionId = (body as { sessionId?: string }).sessionId;
    // sessionId 只允许 timestamp-random 格式；防止注入任意文件名
    const safeSessionId = sessionId === undefined ? undefined : normalizeApiSessionId(sessionId);
    const session = await createAndPersistBookSession(
      root,
      bookId,
      safeSessionId,
      sessionKind,
    );
    return c.json({ session });
  });

  app.put("/api/v1/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const body = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
    const title = body.title?.trim();
    if (!title) {
      throw new ApiError(400, "INVALID_SESSION_TITLE", "Session title is required");
    }

    const session = await renameBookSession(root, sessionId, title);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ session });
  });

  app.delete("/api/v1/sessions/:sessionId", async (c) => {
    await deleteBookSession(root, c.req.param("sessionId"));
    return c.json({ ok: true });
  });

  app.post("/api/v1/sessions/:sessionId/abort", async (c) => {
    const sessionId = c.req.param("sessionId");
    const aborted = abortAgentSession(root, sessionId);
    broadcast("agent:aborted", { sessionId, aborted });
    return c.json({ ok: true, aborted });
  });

  app.post("/api/v1/agent", async (c) => {
    const {
      instruction,
      activeBookId,
      sessionId: reqSessionId,
      sessionKind: reqSessionKind,
      actionSource: reqActionSource,
      requestedIntent: reqRequestedIntent,
      actionPayload: reqActionPayload,
      attachments: reqAttachments,
      model: reqModel,
      service: reqService,
    } = await c.req.json<{
      instruction: string;
      activeBookId?: string;
      sessionId?: string;
      sessionKind?: string;
      actionSource?: string;
      requestedIntent?: string;
      actionPayload?: unknown;
      attachments?: unknown;
      model?: string;
      service?: string;
    }>();
    if (!instruction?.trim()) {
      return c.json({ error: "No instruction provided" }, 400);
    }
    if (!reqSessionId?.trim()) {
      throw new ApiError(400, "SESSION_ID_REQUIRED", "sessionId is required");
    }
    const sessionId = normalizeApiSessionId(reqSessionId);
    const language = await currentProjectLanguage();
    if (reqModel && !isTextChatModelId(reqModel)) {
      const message = nonTextModelMessage(reqModel, language);
      return c.json({ error: message, response: message }, 400);
    }

    const actionSource = normalizeStudioActionSource(reqActionSource);
    const requestedIntent = normalizeStudioRequestedIntent(reqRequestedIntent);
    const actionPayload = normalizeStudioActionPayload(reqActionPayload);
    const attachments = await normalizeAgentAttachments(root, sessionId, reqAttachments);

    broadcast("agent:start", { instruction, activeBookId, sessionId, actionSource, requestedIntent, attachments: attachments.length });

    try {
      // Load config + create LLM client (pipeline created after model resolution)
      const config = await loadCurrentProjectConfig({ requireApiKey: false });
      const client = createLLMClient(config.llm);

      const loadedBookSession = await loadBookSession(root, sessionId);
      if (!loadedBookSession) {
        throw new ApiError(404, "SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
      }
      let bookSession = loadedBookSession;
      const requestedActiveBookId = normalizeApiBookId(activeBookId, "activeBookId");
      const persistedBookId = normalizeApiBookId(bookSession.bookId, "session.bookId");
      if (
        requestedActiveBookId
        && persistedBookId
        && persistedBookId !== requestedActiveBookId
      ) {
        throw new ApiError(
          409,
          "SESSION_BOOK_MISMATCH",
          `Session ${bookSession.sessionId} is bound to ${persistedBookId}, not ${requestedActiveBookId}`,
        );
      }
      const agentBookId = requestedActiveBookId ?? persistedBookId;
      const sessionKind = normalizeStudioSessionKind(
        reqSessionKind,
        bookSession.sessionKind ?? (agentBookId ? "book" : "chat"),
      );
      if (bookSession.sessionKind !== sessionKind) {
        const updatedSession = await createAndPersistBookSession(
          root,
          bookSession.bookId,
          bookSession.sessionId,
          sessionKind,
        );
        bookSession = updatedSession;
      }
      let activeBookConfig: { readonly language?: string } | null = null;
      if (agentBookId) {
        try {
          activeBookConfig = await state.loadBookConfig(agentBookId);
        } catch {
          throw new ApiError(404, "BOOK_NOT_FOUND", `Book not found: ${agentBookId}`);
        }
      }
      const streamSessionId = loadedBookSession.sessionId;
      const titleBeforeRun = bookSession.title;
      let sessionTitleBroadcasted = false;
      const refreshBookSessionFromTranscript = async (): Promise<void> => {
        const refreshed = await loadBookSession(root, bookSession.sessionId);
        if (refreshed) {
          bookSession = refreshed;
        }
        if (!sessionTitleBroadcasted && titleBeforeRun === null && bookSession.title) {
          broadcast("session:title", { sessionId: bookSession.sessionId, title: bookSession.title });
          sessionTitleBroadcasted = true;
        }
      };

      const externalEdit = requestedIntent === "edit_artifact" || sessionKind === "edit"
        ? await tryHandleExternalChatEdit({
            root,
            state,
            instruction,
            activeBookId: agentBookId,
          })
        : null;
      if (externalEdit) {
        await appendManualSessionMessages(root, bookSession.sessionId, [{
          role: "assistant",
          content: [{ type: "text", text: externalEdit.responseText }],
          api: "anthropic-messages",
          provider: config.llm.provider,
          model: config.llm.model,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        }], instruction, { sessionKind });
        await refreshBookSessionFromTranscript();
        broadcast("agent:complete", { instruction, activeBookId: externalEdit.activeBookId, sessionId: bookSession.sessionId, sessionKind });
        return c.json({
          response: externalEdit.responseText,
          session: {
            sessionId: bookSession.sessionId,
            sessionKind,
            ...(externalEdit.activeBookId ? { activeBookId: externalEdit.activeBookId } : {}),
          },
        });
      }

      // Resolve model — multi-service resolution
      let resolvedModel: ResolvedModel["model"] | undefined;
      let resolvedApiKey: string | undefined;

      if (reqService && reqModel) {
        // 1. Frontend explicitly selected a service+model — fail loudly if no key
        try {
          const configuredEntry = await resolveConfiguredServiceEntry(root, reqService);
          const resolved = await resolveServiceModel(
            reqService,
            reqModel,
            root,
            await resolveConfiguredServiceBaseUrl(root, reqService),
            configuredEntry?.apiFormat,
          );
          resolvedModel = resolved.model;
          resolvedApiKey = resolved.apiKey;
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (/API key/i.test(msg)) {
            return c.json({
              error: pick(language, `请先为 ${reqService} 配置 API Key`, `Configure an API Key for ${reqService} first`),
              response: pick(
                language,
                `请先在模型配置中为 ${reqService} 填写 API Key，然后再试。`,
                `Fill in an API Key for ${reqService} in the model settings, then try again.`,
              ),
            }, 400);
          }
          throw e;
        }
      }

      if (!resolvedModel) {
        // 2. Try defaultModel from new config format
        const rawConfig = config.llm as unknown as Record<string, unknown>;
        const defaultModel = rawConfig.defaultModel as string | undefined;
        const servicesArr = normalizeServiceConfig(rawConfig.services);
        const firstService = servicesArr[0];
        if (firstService?.service && defaultModel && isTextChatModelId(defaultModel)) {
          try {
            const resolved = await resolveServiceModel(
              serviceConfigKey(firstService),
              defaultModel,
              root,
              firstService.baseUrl,
              firstService.apiFormat,
            );
            resolvedModel = resolved.model;
            resolvedApiKey = resolved.apiKey;
          } catch { /* fall through */ }
        }
      }

      if (!resolvedModel) {
        // 3. Try first connected service from secrets
        const secrets = await loadSecrets(root);
        for (const [svcName, svcData] of Object.entries(secrets.services)) {
          if (svcData?.apiKey) {
            try {
              const models = await listModelsForService(svcName, svcData.apiKey);
              const textModels = filterTextChatModels(models);
              if (textModels.length > 0) {
                const configuredEntry = await resolveConfiguredServiceEntry(root, svcName);
                const resolved = await resolveServiceModel(
                  svcName,
                  textModels[0].id,
                  root,
                  await resolveConfiguredServiceBaseUrl(root, svcName),
                  configuredEntry?.apiFormat,
                );
                resolvedModel = resolved.model;
                resolvedApiKey = resolved.apiKey;
                break;
              }
            } catch { /* try next */ }
          }
        }
      }

      if (!resolvedModel) {
        // 4. Legacy fallback: use createLLMClient
        resolvedModel = client._piModel
          ? client._piModel
          : { provider: config.llm.provider ?? "anthropic", modelId: config.llm.model } as any;
        resolvedApiKey = client._apiKey;
      }

      const model = resolvedModel!;
      const agentApiKey = resolvedApiKey;
      const configuredEntry = reqService ? await resolveConfiguredServiceEntry(root, reqService) : undefined;

      // Create pipeline with resolved model (so sub_agent tools use the frontend-selected model)
      // Don't spread config.llm — its baseUrl/provider belong to the old service.
      // Let createLLMClient resolve baseUrl from the service preset.
      const pipelineClient = (reqService && reqModel && resolvedModel)
        ? createLLMClient({
            ...config.llm,
            service: configuredEntry?.service ?? reqService,
            model: reqModel,
            apiKey: resolvedApiKey ?? "",
            ...(configuredEntry?.apiFormat ? { apiFormat: configuredEntry.apiFormat } : {}),
            ...(configuredEntry?.stream !== undefined ? { stream: configuredEntry.stream } : {}),
            baseUrl: configuredEntry?.baseUrl ?? "",
          } as any)
        : client;
      const pipeline = new PipelineRunner(await buildPipelineConfig({
        client: pipelineClient,
        model: reqModel ?? config.llm.model,
        currentConfig: config,
        sessionIdForSSE: bookSession.sessionId,
        bookIdForSettings: activeBookId ?? undefined,
        bookIdForTelemetry: activeBookId ?? undefined,
      }));

      if (requestedIntent && isConfirmedProductionAction({ actionSource, requestedIntent })) {
        const pendingBookId = requestedIntent === "create_book" && actionPayload?.createBook?.title
          ? deriveBookIdFromTitle(actionPayload.createBook.title)
          : null;
        if (pendingBookId) {
          bookCreateStatus.set(pendingBookId, { status: "creating" });
          broadcast("book:creating", {
            bookId: pendingBookId,
            title: actionPayload?.createBook?.title ?? pendingBookId,
            sessionId: streamSessionId,
          });
        }

        try {
          const exec = await executeConfirmedProductionAction({
            pipeline,
            root,
            sessionId: bookSession.sessionId,
            bookId: agentBookId,
            streamSessionId,
            instruction,
            requestedIntent,
            actionPayload,
          });

          let createdBookId: string | null = null;
          if (exec.tool === "sub_agent" && exec.agent === "architect" && exec.status === "completed") {
            createdBookId = resolveCreatedBookIdFromToolExecs([exec]);
            if (createdBookId) {
              try {
                const migratedSession = await migrateBookSession(root, bookSession.sessionId, createdBookId);
                if (migratedSession) {
                  bookSession = migratedSession;
                }
              } catch (e) {
                if (!(e instanceof SessionAlreadyMigratedError)) {
                  throw e;
                }
              }
              const book = await loadStudioBookListSummary(state, createdBookId).catch(() => undefined);
              bookCreateStatus.delete(createdBookId);
              broadcast("book:created", {
                bookId: createdBookId,
                sessionId: bookSession.sessionId,
                ...(book ? { book } : {}),
              });
            }
          }

          const responseText = exec.result ?? pick(language, "已完成。", "Done.");
          const responseForUser = suppressManualTextForTool(exec) ? "" : responseText;
          await appendManualSessionMessages(root, bookSession.sessionId, [
            manualToolAssistantMessage(
              responseText,
              exec,
              configuredEntry?.service ?? reqService ?? config.llm.provider,
              reqModel ?? config.llm.model,
            ),
          ], instruction, manualToolAppendOptions(sessionKind, exec));
          await refreshBookSessionFromTranscript();
          broadcast("agent:complete", { instruction, activeBookId: createdBookId ?? agentBookId, sessionId: bookSession.sessionId, sessionKind });
          return c.json({
            response: responseForUser,
            details: { toolExecutions: [exec] },
            session: {
              sessionId: bookSession.sessionId,
              sessionKind,
              ...(createdBookId ?? agentBookId ? { activeBookId: createdBookId ?? agentBookId } : {}),
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (pendingBookId) {
            bookCreateStatus.set(pendingBookId, { status: "error", error: message });
            broadcast("book:error", { bookId: pendingBookId, sessionId: streamSessionId, error: message });
          }
          if (error instanceof ConfirmedActionExecutionError) {
            await appendManualSessionMessages(root, bookSession.sessionId, [
              manualToolAssistantMessage(
                message,
                error.exec,
                configuredEntry?.service ?? reqService ?? config.llm.provider,
                reqModel ?? config.llm.model,
              ),
            ], instruction, manualToolAppendOptions(sessionKind, error.exec)).catch(() => undefined);
            await refreshBookSessionFromTranscript().catch(() => undefined);
          }
          broadcast("agent:error", { instruction, activeBookId: agentBookId, sessionId: bookSession.sessionId, sessionKind, error: message });
          return c.json({
            error: { code: "AGENT_ACTION_FAILED", message },
            response: message,
          }, 502);
        }
      }

      if (shouldRunDirectWriteNext({ instruction, agentBookId, sessionKind, actionSource, requestedIntent })) {
        const directWriteBookId = agentBookId;
        if (!directWriteBookId) {
          throw new ApiError(400, "BOOK_ID_REQUIRED", "write_next requires an active book");
        }
        const toolCallId = `direct-writer-${Date.now().toString(36)}`;
        const toolArgs = { agent: "writer", bookId: directWriteBookId };
        broadcast("tool:start", {
          sessionId: streamSessionId,
          id: toolCallId,
          tool: "sub_agent",
          args: toolArgs,
          stages: pipelineStages("writer", language),
        });

        try {
          const writeResult = await pipeline.writeNextChapter(directWriteBookId);
          const writeNeedsReview = Boolean(writeResult.status && writeResult.status !== "ready-for-review");
          const zhResponseText = writeNeedsReview
            ? [
                `已为 ${directWriteBookId} 写出第 ${writeResult.chapterNumber} 章`,
                writeResult.title ? `《${writeResult.title}》` : "",
                `，字数 ${writeResult.wordCount}，但审稿未通过，状态 ${writeResult.status}，需要复核后再继续。`,
              ].join("")
            : [
                `已为 ${directWriteBookId} 完成第 ${writeResult.chapterNumber} 章`,
                writeResult.title ? `《${writeResult.title}》` : "",
                `，字数 ${writeResult.wordCount}，状态 ${writeResult.status}。`,
              ].join("");
          const enChapterRef = writeResult.title
            ? `chapter ${writeResult.chapterNumber} "${writeResult.title}"`
            : `chapter ${writeResult.chapterNumber}`;
          const enResponseText = writeNeedsReview
            ? `Wrote ${enChapterRef} for ${directWriteBookId}: ${writeResult.wordCount} words, but the review did not pass (status: ${writeResult.status}). Manual review is required before continuing.`
            : `Completed ${enChapterRef} for ${directWriteBookId}: ${writeResult.wordCount} words, status ${writeResult.status}.`;
          const responseText = pick(language, zhResponseText, enResponseText);
          const toolResult = {
            content: [{ type: "text", text: responseText }],
            details: {
              kind: "chapter_written",
              bookId: directWriteBookId,
              chapterNumber: writeResult.chapterNumber,
              title: writeResult.title,
              wordCount: writeResult.wordCount,
              status: writeResult.status,
            },
          };
          broadcast("tool:end", {
            sessionId: streamSessionId,
            id: toolCallId,
            tool: "sub_agent",
            result: toolResult,
            details: toolResult.details,
            isError: writeNeedsReview,
          });
          const exec: CollectedToolExec = {
            id: toolCallId,
            tool: "sub_agent",
            agent: "writer",
            label: resolveToolLabel("sub_agent", "writer", language),
            status: writeNeedsReview ? "error" : "completed",
            args: toolArgs,
            result: responseText,
            details: toolResult.details,
            startedAt: Date.now(),
            completedAt: Date.now(),
          };
          await appendManualSessionMessages(root, bookSession.sessionId, [
            manualToolAssistantMessage(
              responseText,
              exec,
              configuredEntry?.service ?? reqService ?? config.llm.provider,
              reqModel ?? config.llm.model,
            ),
          ], instruction, manualToolAppendOptions(sessionKind, exec));
          await refreshBookSessionFromTranscript();
          broadcast("agent:complete", { instruction, activeBookId: directWriteBookId, sessionId: bookSession.sessionId, sessionKind });
          return c.json({
            response: responseText,
            session: {
              sessionId: bookSession.sessionId,
              sessionKind,
              activeBookId: directWriteBookId,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const toolResult = { content: [{ type: "text", text: message }] };
          const exec: CollectedToolExec = {
            id: toolCallId,
            tool: "sub_agent",
            agent: "writer",
            label: resolveToolLabel("sub_agent", "writer", language),
            status: "error",
            args: toolArgs,
            error: message,
            startedAt: Date.now(),
            completedAt: Date.now(),
          };
          broadcast("tool:end", {
            sessionId: streamSessionId,
            id: toolCallId,
            tool: "sub_agent",
            result: toolResult,
            isError: true,
          });
          await appendManualSessionMessages(root, bookSession.sessionId, [
            manualToolAssistantMessage(
              message,
              exec,
              configuredEntry?.service ?? reqService ?? config.llm.provider,
              reqModel ?? config.llm.model,
            ),
          ], instruction, manualToolAppendOptions(sessionKind, exec)).catch(() => undefined);
          await refreshBookSessionFromTranscript().catch(() => undefined);
          broadcast("agent:error", { instruction, activeBookId: agentBookId, sessionId: bookSession.sessionId, sessionKind, error: message });
          return c.json({
            error: { code: "AGENT_ACTION_FAILED", message },
            response: message,
          }, 502);
        }
      }

      // The surface agent should speak the user's language, not just the project default.
      // Pre-commitment surfaces (chat / book-create, no book yet) infer it from the
      // instruction; committed book/edit sessions keep the configured language.
      const configLanguage = config.language === "en" ? "en" : "zh";
      const bookLanguage = activeBookConfig?.language === "en" ? "en" : activeBookConfig?.language === "zh" ? "zh" : undefined;
      const surfaceLanguage = agentBookId ? (bookLanguage ?? configLanguage) : inferLanguage(instruction);

      // Run pi-agent session
      const collectedToolExecs: CollectedToolExec[] = [];
      const result = await runAgentSession(
        {
          model,
          apiKey: agentApiKey,
          pipeline,
          projectRoot: root,
          bookId: agentBookId,
          sessionKind,
          actionSource,
          requestedIntent,
          actionPayload,
          attachments,
          sessionId: bookSession.sessionId,
          language: surfaceLanguage,
          onContextCompression: (event) => {
            broadcast("context:compression", {
              sessionId: streamSessionId,
              ...event,
            });
          },
          onEvent: (event) => {
            if (event.type === "message_update") {
              const ame = event.assistantMessageEvent;
              if (ame.type === "text_delta") {
                broadcast("draft:delta", { sessionId: streamSessionId, text: ame.delta });
              } else if (ame.type === "thinking_delta") {
                broadcast("thinking:delta", { sessionId: streamSessionId, text: (ame as any).delta });
              } else if (ame.type === "thinking_start") {
                broadcast("thinking:start", { sessionId: streamSessionId });
              } else if (ame.type === "thinking_end") {
                broadcast("thinking:end", { sessionId: streamSessionId });
              }
            }
            if (event.type === "tool_execution_start") {
              const args = event.args as Record<string, unknown> | undefined;
              const agent = event.toolName === "sub_agent" ? (args?.agent as string | undefined) : undefined;
              const stages = agent ? (pipelineStages(agent, language) ?? []) : [];

              collectedToolExecs.push({
                id: event.toolCallId,
                tool: event.toolName,
                agent,
                label: resolveToolLabel(event.toolName, agent, language),
                status: "running",
                args,
                stages: stages.length > 0
                  ? stages.map(l => ({ label: l, status: "pending" as const }))
                  : undefined,
                startedAt: Date.now(),
              });

              if (!agentBookId && event.toolName === "sub_agent" && agent === "architect") {
                const bookId = resolveArchitectBookIdFromArgs(args);
                if (bookId) {
                  const title = typeof args?.title === "string" && args.title.trim()
                    ? args.title.trim()
                    : bookId;
                  bookCreateStatus.set(bookId, { status: "creating" });
                  broadcast("book:creating", { bookId, title, sessionId: streamSessionId });
                }
              }

              broadcast("tool:start", {
                sessionId: streamSessionId,
                id: event.toolCallId,
                tool: event.toolName,
                args,
                stages,
              });
            }
            if (event.type === "tool_execution_update") {
              broadcast("tool:update", {
                sessionId: streamSessionId,
                tool: event.toolName,
                partialResult: event.partialResult,
              });
            }
            if (event.type === "tool_execution_end") {
              const exec = collectedToolExecs.find(t => t.id === event.toolCallId);
              if (exec) {
                exec.status = event.isError ? "error" : "completed";
                exec.completedAt = Date.now();
                exec.stages = exec.stages?.map(s => ({ ...s, status: "completed" as const }));
                if (event.isError) exec.error = extractToolError(event.result);
                else exec.result = summarizeResult(event.result);
                exec.details = (event.result as { details?: unknown } | undefined)?.details;
                if (
                  event.isError &&
                  !agentBookId &&
                  exec.tool === "sub_agent" &&
                  exec.agent === "architect"
                ) {
                  const bookId = resolveArchitectBookIdFromArgs(exec.args);
                  if (bookId) {
                    const error = exec.error ?? "Book creation failed";
                    bookCreateStatus.set(bookId, { status: "error", error });
                    broadcast("book:error", { bookId, sessionId: streamSessionId, error });
                  }
                }
              }
              broadcast("tool:end", {
                sessionId: streamSessionId,
                id: event.toolCallId,
                tool: event.toolName,
                result: event.result,
                details: exec?.details,
                isError: event.isError,
              });
            }
          },
        },
        instruction,
      );

      if (result.responseText) {
        const actionExecutionError = validateAgentActionExecution({
          instruction,
          agentBookId,
          requestedIntent,
          collectedToolExecs,
          language,
        });
        if (actionExecutionError) {
          return c.json({
            error: { code: "AGENT_ACTION_NOT_EXECUTED", message: actionExecutionError },
            response: actionExecutionError,
          }, 502);
        }
      }

      let broadcastedCreatedBookId: string | null = null;
      const finalizeCreatedBook = async (): Promise<string | null> => {
        if (agentBookId) return null;
        const createdBookId = resolveCreatedBookIdFromToolExecs(collectedToolExecs);
        if (!createdBookId) return null;
        if (broadcastedCreatedBookId === createdBookId) return createdBookId;
        if (!await completeBookExists(join(root, "books", createdBookId))) {
          const error = "Book creation artifact is incomplete on disk.";
          bookCreateStatus.set(createdBookId, { status: "error", error });
          broadcast("book:error", { bookId: createdBookId, sessionId: bookSession.sessionId, error });
          return null;
        }

        try {
          const migratedSession = await migrateBookSession(root, bookSession.sessionId, createdBookId);
          if (migratedSession) {
            bookSession = migratedSession;
          }
        } catch (e) {
          if (!(e instanceof SessionAlreadyMigratedError)) {
            throw e;
          }
        }

        const book = await loadStudioBookListSummary(state, createdBookId).catch(() => undefined);
        bookCreateStatus.delete(createdBookId);
        broadcast("book:created", {
          bookId: createdBookId,
          sessionId: bookSession.sessionId,
          ...(book ? { book } : {}),
        });
        broadcastedCreatedBookId = createdBookId;
        return createdBookId;
      };

      if (!result.responseText) {
        if (hasSuccessfulToolExec(collectedToolExecs, "propose_action")) {
          await refreshBookSessionFromTranscript();
          broadcast("agent:complete", { instruction, activeBookId, sessionId: bookSession.sessionId, sessionKind });
          return c.json({
            response: "",
            session: {
              sessionId: bookSession.sessionId,
              sessionKind,
              ...(bookSession.bookId ? { activeBookId: bookSession.bookId } : {}),
            },
            details: { toolExecutions: collectedToolExecs },
          });
        }

        if (result.errorMessage) {
          if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
            await finalizeCreatedBook();
          }
          const failure = formatAgentFailure(result.errorMessage, language);
          return c.json({
            error: { code: failure.code, message: failure.message },
            response: failure.message,
          }, failure.status);
        }

        const actionExecutionError = validateAgentActionExecution({
          instruction,
          agentBookId,
          requestedIntent,
          collectedToolExecs,
          language,
        });
        if (actionExecutionError) {
          return c.json({
            error: { code: "AGENT_ACTION_NOT_EXECUTED", message: actionExecutionError },
            response: actionExecutionError,
          }, 502);
        }

        await refreshBookSessionFromTranscript();
        const createdBookId = await finalizeCreatedBook();
        if (requestedIntent || createdBookId || hasSuccessfulToolResult(collectedToolExecs)) {
          const responseSessionKind = bookSession.sessionKind ?? sessionKind;
          broadcast("agent:complete", { instruction, activeBookId, sessionId: bookSession.sessionId, sessionKind: responseSessionKind });
          return c.json({
            response: "",
            session: {
              sessionId: bookSession.sessionId,
              sessionKind: responseSessionKind,
              ...(createdBookId ?? bookSession.bookId ? { activeBookId: createdBookId ?? bookSession.bookId } : {}),
            },
          });
        }

        const emptyMessage = pick(
          language,
          "模型未返回文本内容。请检查协议类型（chat/responses）、流式开关或上游服务兼容性。",
          "The model returned no text content. Check the protocol type (chat/responses), the streaming switch, or upstream service compatibility.",
        );
        if (resolveCreatedBookIdFromToolExecs(collectedToolExecs)) {
          await finalizeCreatedBook();
        }
        return c.json({
          error: { code: "AGENT_EMPTY_RESPONSE", message: emptyMessage },
          response: emptyMessage,
        }, 502);
      }
      await refreshBookSessionFromTranscript();
      await finalizeCreatedBook();

      const responseSessionKind = bookSession.sessionKind ?? sessionKind;
      broadcast("agent:complete", { instruction, activeBookId, sessionId: bookSession.sessionId, sessionKind: responseSessionKind });

      return c.json({
        response: result.responseText,
        session: {
          sessionId: bookSession.sessionId,
          sessionKind: responseSessionKind,
          ...(bookSession.bookId ? { activeBookId: bookSession.bookId } : {}),
        },
      });
    } catch (e) {
      if (e instanceof ApiError) {
        throw e;
      }
      if (e instanceof SessionAlreadyMigratedError) {
        const migratedMessage = e instanceof Error ? e.message : String(e);
        throw new ApiError(409, "SESSION_ALREADY_MIGRATED", migratedMessage);
      }
      const msg = e instanceof Error ? e.message : String(e);
      broadcast("agent:error", { instruction, activeBookId, sessionId, sessionKind: reqSessionKind, error: msg });

      // Agent busy — return 429 with user-friendly message
      if (/already processing|prompt.*queue/i.test(msg)) {
        return c.json({
          error: {
            code: "AGENT_BUSY",
            message: pick(language, "正在处理中，请等待当前操作完成", "Still processing. Wait for the current operation to finish"),
          },
          response: pick(
            language,
            "正在处理中，请等待当前操作完成后再发送。",
            "Still processing. Wait for the current operation to finish before sending again.",
          ),
        }, 429);
      }

      const failure = formatAgentFailure(msg, language);
      return c.json(
        { error: { code: failure.code, message: failure.message } },
        failure.status,
      );
    }
  });

  // --- Language setup ---

  app.post("/api/v1/project/language", async (c) => {
    const { language } = await c.req.json<{ language: "zh" | "en" }>();
    if (language !== "zh" && language !== "en") {
      return c.json({ error: "language must be zh or en" }, 400);
    }
    try {
      await mutateRawConfig(root, (existing) => {
        existing.language = language;
      });
      return c.json({ ok: true, language });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Audit ---

  app.post("/api/v1/books/:id/audit/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = normalizePositiveIntegerParam(c.req.param("chapter"), "chapter number");

    broadcast("audit:start", { bookId: id, chapter: chapterNum });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForTelemetry: id }));
      const result = await executeCoreMutation({ state, pipeline }, {
        kind: "audit-chapter",
        bookId: id,
        chapterNumber: chapterNum,
      });
      broadcast("audit:complete", { bookId: id, chapter: chapterNum, passed: result.passed });
      return c.json(result);
    } catch (e) {
      rethrowCoreMutationApiError(e);
      broadcast("audit:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Revise ---

  app.post("/api/v1/books/:id/revise/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = normalizePositiveIntegerParam(c.req.param("chapter"), "chapter number");
    const bookDir = state.bookDir(id);
    const body = await c.req
      .json<{ mode?: string; brief?: string }>()
      .catch(() => ({ mode: "spot-fix", brief: undefined }));

    broadcast("revise:start", { bookId: id, chapter: chapterNum });
    try {
      const book = await state.loadBookConfig(id);
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const pipeline = new PipelineRunner(await buildPipelineConfig({
        externalContext: body.brief,
        bookIdForSettings: id,
        bookIdForTelemetry: id,
      }));
      const normalizedMode = ReviseModeSchema.safeParse(body.mode ?? "spot-fix");
      if (!normalizedMode.success) {
        throw new ApiError(400, "INVALID_REVISE_MODE", normalizedMode.error.issues[0]?.message ?? "Invalid revise mode");
      }
      const result = await pipeline.reviseDraft(
        id,
        chapterNum,
        normalizedMode.data,
      );
      broadcast("revise:complete", { bookId: id, chapter: chapterNum });
      return c.json(result);
    } catch (e) {
      rethrowApiError(e);
      broadcast("revise:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Export ---

  app.get("/api/v1/books/:id/export", async (c) => {
    const id = c.req.param("id");
    const format = (c.req.query("format") ?? "txt") as string;
    const approvedOnly = c.req.query("approvedOnly") === "true";

    try {
      const artifact = await buildExportArtifact(state, id, {
        format: format as "txt" | "md" | "epub",
        approvedOnly,
      });
      const responseBody = typeof artifact.payload === "string"
        ? artifact.payload
        : new Uint8Array(artifact.payload);
      return new Response(responseBody, {
        headers: {
          "Content-Type": artifact.contentType,
          "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        },
      });
    } catch {
      return c.json({ error: "Export failed" }, 500);
    }
  });

  // --- Export to file (save to project dir) ---

  app.post("/api/v1/books/:id/export-save", async (c) => {
    const id = c.req.param("id");
    const { format, approvedOnly } = await c.req.json<{ format?: string; approvedOnly?: boolean }>().catch(() => ({ format: "txt", approvedOnly: false }));
    const fmt = format ?? "txt";

    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig());
      const tools = createInteractionToolsFromDeps(pipeline, state);
      const bookDir = state.bookDir(id);
      const outputPath = join(bookDir, `${id}.${fmt === "epub" ? "epub" : fmt}`);
      const result = await processProjectInteractionRequest({
        projectRoot: root,
        request: {
          intent: "export_book",
          bookId: id,
          format: fmt as "txt" | "md" | "epub",
          approvedOnly,
          outputPath,
        },
        tools,
        activeBookId: id,
      });
      return c.json({
        ok: true,
        path: (result.details?.outputPath as string | undefined) ?? outputPath,
        format: fmt,
        chapters: (result.details?.chaptersExported as number | undefined) ?? 0,
      });
    } catch (e) {
      rethrowApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Genre detail + copy ---

  app.get("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    try {
      const { readGenreProfile } = await import("@actalk/inkos-core");
      const { profile, body } = await readGenreProfile(root, genreId);
      return c.json({ profile, body });
    } catch (e) {
      return c.json({ error: String(e) }, 404);
    }
  });

  app.post("/api/v1/genres/:id/copy", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }
    try {
      const { getBuiltinGenresDir } = await import("@actalk/inkos-core");
      const { mkdir: mkdirFs, copyFile } = await import("node:fs/promises");
      const builtinDir = getBuiltinGenresDir();
      const projectGenresDir = join(root, "genres");
      await mkdirFs(projectGenresDir, { recursive: true });
      await copyFile(join(builtinDir, `${genreId}.md`), join(projectGenresDir, `${genreId}.md`));
      return c.json({ ok: true, path: `genres/${genreId}.md` });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Model overrides ---

  app.get("/api/v1/project/model-overrides", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ overrides: raw.modelOverrides ?? {} });
  });

  app.get("/api/v1/project/model-routing", async (c) => {
    const raw = await loadRawConfig(root);
    const envLayers = await loadLLMEnvLayers(root);
    const effective = await resolveEffectiveLLMConfig({
      consumer: "studio",
      projectRoot: root,
      envLayers,
      requireApiKey: false,
    });
    const overrides = raw.modelOverrides && typeof raw.modelOverrides === "object" && !Array.isArray(raw.modelOverrides)
      ? raw.modelOverrides as Record<string, unknown>
      : {};
    return c.json({
      service: effective.llm.service ?? null,
      defaultModel: effective.llm.model,
      configMode: effective.diagnostics.configMode,
      serviceSource: effective.diagnostics.serviceSource,
      modelSource: effective.diagnostics.modelSource,
      apiKeySource: effective.diagnostics.apiKeySource,
      warnings: effective.diagnostics.warnings,
      overrides,
      knownAgents: KNOWN_MODEL_ROUTING_AGENTS,
      phase7Agents: PHASE7_MODEL_ROUTING_AGENTS,
    });
  });

  app.put("/api/v1/project/model-overrides", async (c) => {
    const { overrides } = await c.req.json<{ overrides: Record<string, unknown> }>();
    await mutateRawConfig(root, (raw) => {
      raw.modelOverrides = overrides;
    });
    return c.json({ ok: true });
  });

  // --- Global default model ---

  app.get("/api/v1/project/default-model", async (c) => {
    const raw = await loadRawConfig(root);
    const llm = raw.llm && typeof raw.llm === "object" && !Array.isArray(raw.llm)
      ? raw.llm as Record<string, unknown>
      : {};
    return c.json({
      service: typeof llm.service === "string" ? llm.service : null,
      defaultModel: typeof llm.defaultModel === "string" && llm.defaultModel.trim()
        ? llm.defaultModel
        : typeof llm.model === "string" && llm.model.trim()
          ? llm.model
          : null,
    });
  });

  app.put("/api/v1/project/default-model", async (c) => {
    const body = await c.req.json<{ defaultModel?: string; service?: string }>();
    const defaultModel = typeof body.defaultModel === "string" ? body.defaultModel.trim() : "";
    if (!defaultModel) return c.json({ error: "defaultModel is required" }, 400);
    const service = await mutateRawConfig(root, (raw) => {
      raw.llm = raw.llm && typeof raw.llm === "object" && !Array.isArray(raw.llm) ? raw.llm : {};
      const llm = raw.llm as Record<string, unknown>;
      llm.defaultModel = defaultModel;
      if (typeof body.service === "string" && body.service.trim()) llm.service = body.service.trim();
      syncTopLevelLlmMirror(llm);
      return typeof llm.service === "string" ? llm.service : null;
    });
    return c.json({
      ok: true,
      service,
      defaultModel,
    });
  });

  // --- Chapter review mode (C4a: auto pipeline vs manual checkpoint) ---

  app.get("/api/v1/project/chapter-review-mode", async (c) => {
    const raw = await loadRawConfig(root);
    return c.json({ mode: readProjectChapterReviewMode(raw) });
  });

  app.put("/api/v1/project/chapter-review-mode", async (c) => {
    const { mode } = await c.req.json<{ mode?: string }>();
    const next = normalizeChapterReviewMode(mode);
    await mutateRawConfig(root, (raw) => {
      raw.writing = { ...(raw.writing ?? {}), reviewMode: next };
    });
    return c.json({ ok: true, mode: next });
  });

  app.get("/api/v1/books/:id/chapter-review-mode", async (c) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) return c.json({ error: "Invalid book id" }, 400);
    try {
      const [projectConfig, rawBook] = await Promise.all([
        loadRawConfig(root),
        loadRawBookConfig(root, bookId),
      ]);
      const projectMode = readProjectChapterReviewMode(projectConfig);
      const bookMode = readBookChapterReviewMode(rawBook);
      return c.json({
        mode: bookMode ?? projectMode,
        bookMode: bookMode ?? null,
        projectMode,
      });
    } catch (error) {
      rethrowApiError(error);
      return c.json({ error: `Book "${bookId}" not found` }, 404);
    }
  });

  app.put("/api/v1/books/:id/chapter-review-mode", async (c) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) return c.json({ error: "Invalid book id" }, 400);
    const { mode } = await c.req.json<{ mode?: string }>();
    try {
      if (mode !== "auto" && mode !== "manual" && mode !== "inherit") {
        throw new CoreMutationValidationError("INVALID_MUTATION", `Invalid chapter review mode: ${String(mode)}`);
      }
      const projectMode = readProjectChapterReviewMode(await loadRawConfig(root));
      const result = await executeCoreMutation({ state }, {
        kind: "set-chapter-review-mode",
        bookId,
        mode,
      });
      return c.json({
        ok: true,
        mode: result.bookMode ?? projectMode,
        bookMode: result.bookMode,
        projectMode,
      });
    } catch (error) {
      rethrowCoreMutationApiError(error);
      return c.json({ error: `Book "${bookId}" not found` }, 404);
    }
  });

  // --- Notify channels ---

  app.get("/api/v1/project/notify", async (c) => {
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    return c.json({ channels: raw.notify ?? [] });
  });

  app.put("/api/v1/project/notify", async (c) => {
    const { channels } = await c.req.json<{ channels: unknown[] }>();
    if (!Array.isArray(channels)) return c.json({ error: "channels must be an array" }, 400);
    await mutateRawConfig(root, (raw) => {
      raw.notify = channels;
    });
    return c.json({ ok: true });
  });

  // --- AIGC Detection ---

  app.post("/api/v1/books/:id/detect/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = normalizePositiveIntegerParam(c.req.param("chapter"), "chapter number");
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(chapterNum).padStart(4, "0");
      const match = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!match) return c.json({ error: "Chapter not found" }, 404);

      const content = await readFile(join(chaptersDir, match), "utf-8");
      const { analyzeAITells } = await import("@actalk/inkos-core");
      const result = analyzeAITells(content);
      return c.json({ chapterNumber: chapterNum, ...result });
    } catch (e) {
      rethrowApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Truth file edit ---

  app.put("/api/v1/books/:id/truth/:file{.+}", async (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    const bookDir = state.bookDir(id);
    const resolved = resolveTruthFilePath(bookDir, file);
    if (!resolved) {
      return c.json({ error: "Invalid truth file" }, 400);
    }
    const { content } = await c.req.json<{ content: string }>();
    try {
      await executeCoreMutation({ state }, {
        kind: "edit-truth",
        bookId: id,
        fileName: file,
        content,
      });
      return c.json({ ok: true });
    } catch (e) {
      rethrowCoreMutationApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // =============================================
  // NEW ENDPOINTS — CLI parity
  // =============================================

  // --- Book Delete ---

  app.delete("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await executeCoreMutation({ state }, { kind: "delete-book", bookId: id });
      broadcast("book:deleted", { bookId: id });
      return c.json({ ok: true, bookId: id });
    } catch (e) {
      rethrowCoreMutationApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Book Update ---

  app.put("/api/v1/books/:id", async (c) => {
    const id = c.req.param("id");
    const updates = await c.req.json<{
      chapterWordCount?: unknown;
      targetChapters?: unknown;
      status?: unknown;
      language?: unknown;
    }>();
    try {
      const result = await executeCoreMutation({ state }, {
        kind: "update-book-config",
        bookId: id,
        updates,
      });
      return c.json({ ok: true, book: result.book });
    } catch (e) {
      rethrowCoreMutationApiError(e);
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Write Rewrite (specific chapter) ---

  app.post("/api/v1/books/:id/rewrite/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = normalizePositiveIntegerParam(c.req.param("chapter"), "chapter number");
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    const operation = beginStudioOperation(id, "rewrite");
    launchStudioOperation({
      operation,
      run: async () => {
        const pipeline = new PipelineRunner(await buildPipelineConfig({
          externalContext: body.brief,
          bookIdForTelemetry: id,
          signal: operation.controller.signal,
        }));
        return executeCoreMutation({ state, pipeline }, {
        kind: "rewrite",
        bookId: id,
        chapterNumber: chapterNum,
        brief: body.brief,
        });
      },
      completeData: (result) => ({
          chapterNumber: result.chapterNumber,
          title: result.title,
          wordCount: result.wordCount,
          rolledBackTo: result.rolledBackTo,
          discarded: result.discarded,
          ...(result.operationId ? { operationId: result.operationId } : {}),
          ...(result.recovery ? { recovery: result.recovery } : {}),
      }),
    });
    return c.json({ status: "rewriting", bookId: id, chapter: chapterNum, requestId: operation.requestId }, 202);
  });

  app.post("/api/v1/books/:id/resync/:chapter", async (c) => {
    const id = c.req.param("id");
    const chapterNum = normalizePositiveIntegerParam(c.req.param("chapter"), "chapter number");
    const body: { brief?: string } = await c.req
      .json<{ brief?: string }>()
      .catch(() => ({}));

    const operation = beginStudioOperation(id, "resync");
    launchStudioOperation({
      operation,
      run: async () => {
        const pipeline = new PipelineRunner(await buildPipelineConfig({
          externalContext: body.brief,
          bookIdForTelemetry: id,
          signal: operation.controller.signal,
        }));
        return pipeline.resyncChapterArtifacts(id, chapterNum);
      },
      completeData: (result) => ({ chapter: chapterNum, status: result.status }),
    });
    return c.json({ status: "resyncing", bookId: id, chapter: chapterNum, requestId: operation.requestId }, 202);
  });

  // --- Detect All chapters ---

  app.post("/api/v1/books/:id/detect-all", async (c) => {
    const id = c.req.param("id");
    const bookDir = state.bookDir(id);

    try {
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const mdFiles = files.filter((f) => f.endsWith(".md") && /^\d{4}/.test(f)).sort();
      const { analyzeAITells } = await import("@actalk/inkos-core");

      const results = await Promise.all(
        mdFiles.map(async (f) => {
          const num = parseInt(f.slice(0, 4), 10);
          const content = await readFile(join(chaptersDir, f), "utf-8");
          const result = analyzeAITells(content);
          return { chapterNumber: num, filename: f, ...result };
        }),
      );
      return c.json({ bookId: id, results });
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Detect Stats ---

  app.get("/api/v1/books/:id/detect/stats", async (c) => {
    const id = c.req.param("id");
    try {
      const { loadDetectionHistory, analyzeDetectionInsights } = await import("@actalk/inkos-core");
      const bookDir = state.bookDir(id);
      const history = await loadDetectionHistory(bookDir);
      const insights = analyzeDetectionInsights(history);
      return c.json(insights);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Genre Create ---

  app.post("/api/v1/genres/create", async (c) => {
    const body = await c.req.json<{
      id: string; name: string; language?: string;
      chapterTypes?: string[]; fatigueWords?: string[];
      numericalSystem?: boolean; powerScaling?: boolean; eraResearch?: boolean;
      pacingRule?: string; satisfactionTypes?: string[]; auditDimensions?: number[];
      body?: string;
    }>();

    if (!body.id || !body.name) {
      return c.json({ error: "id and name are required" }, 400);
    }
    if (/[/\\\0]/.test(body.id) || body.id.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${body.id}"`);
    }

    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const frontmatter = [
      "---",
      `name: ${yamlScalar(body.name)}`,
      `id: ${yamlScalar(body.id)}`,
      `language: ${yamlScalar(body.language ?? "zh")}`,
      `chapterTypes: ${JSON.stringify(body.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(body.fatigueWords ?? [])}`,
      `numericalSystem: ${body.numericalSystem ?? false}`,
      `powerScaling: ${body.powerScaling ?? false}`,
      `eraResearch: ${body.eraResearch ?? false}`,
      `pacingRule: ${yamlScalar(body.pacingRule ?? "")}`,
      `satisfactionTypes: ${JSON.stringify(body.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(body.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${body.id}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: body.id });
  });

  // --- Genre Edit ---

  app.put("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const body = await c.req.json<{ profile: Record<string, unknown>; body: string }>();
    const { writeFile: writeFileFs, mkdir: mkdirFs } = await import("node:fs/promises");
    const genresDir = join(root, "genres");
    await mkdirFs(genresDir, { recursive: true });

    const p = body.profile;
    const frontmatter = [
      "---",
      `name: ${yamlScalar(p.name ?? genreId)}`,
      `id: ${yamlScalar(p.id ?? genreId)}`,
      `language: ${yamlScalar(p.language ?? "zh")}`,
      `chapterTypes: ${JSON.stringify(p.chapterTypes ?? [])}`,
      `fatigueWords: ${JSON.stringify(p.fatigueWords ?? [])}`,
      `numericalSystem: ${p.numericalSystem ?? false}`,
      `powerScaling: ${p.powerScaling ?? false}`,
      `eraResearch: ${p.eraResearch ?? false}`,
      `pacingRule: ${yamlScalar(p.pacingRule ?? "")}`,
      `satisfactionTypes: ${JSON.stringify(p.satisfactionTypes ?? [])}`,
      `auditDimensions: ${JSON.stringify(p.auditDimensions ?? [])}`,
      "---",
      "",
      body.body ?? "",
    ].join("\n");

    await writeFileFs(join(genresDir, `${genreId}.md`), frontmatter, "utf-8");
    return c.json({ ok: true, id: genreId });
  });

  // --- Genre Delete (project-level only) ---

  app.delete("/api/v1/genres/:id", async (c) => {
    const genreId = c.req.param("id");
    if (/[/\\\0]/.test(genreId) || genreId.includes("..")) {
      throw new ApiError(400, "INVALID_GENRE_ID", `Invalid genre ID: "${genreId}"`);
    }

    const filePath = join(root, "genres", `${genreId}.md`);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(filePath);
      return c.json({ ok: true, id: genreId });
    } catch (e) {
      return c.json({ error: `Genre "${genreId}" not found in project` }, 404);
    }
  });

  // --- Import Chapters ---

  app.post("/api/v1/books/:id/import/chapters", async (c) => {
    const id = c.req.param("id");
    const { text, splitRegex } = await c.req.json<{ text: string; splitRegex?: string }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);

    broadcast("import:start", { bookId: id, type: "chapters" });
    try {
      const { splitChapters } = await import("@actalk/inkos-core");
      const chapters = [...splitChapters(text, splitRegex)];

      const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForTelemetry: id }));
      const result = await pipeline.importChapters({ bookId: id, chapters });
      broadcast("import:complete", { bookId: id, type: "chapters", count: result.importedCount });
      return c.json(result);
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Import Canon ---

  app.post("/api/v1/books/:id/import/canon", async (c) => {
    const id = c.req.param("id");
    const { fromBookId } = await c.req.json<{ fromBookId: string }>();
    if (!fromBookId) return c.json({ error: "fromBookId is required" }, 400);

    broadcast("import:start", { bookId: id, type: "canon" });
    try {
      const pipeline = new PipelineRunner(await buildPipelineConfig({ bookIdForTelemetry: id }));
      await pipeline.importCanon(id, fromBookId);
      broadcast("import:complete", { bookId: id, type: "canon" });
      return c.json({ ok: true });
    } catch (e) {
      broadcast("import:error", { bookId: id, error: String(e) });
      return c.json({ error: String(e) }, 500);
    }
  });

  // --- Doctor (environment health check) ---

  app.get("/api/v1/doctor", async (c) => {
    const { existsSync } = await import("node:fs");
    const { GLOBAL_ENV_PATH } = await import("@actalk/inkos-core");

    const checks = {
      inkosJson: existsSync(join(root, "inkos.json")),
      projectEnv: existsSync(join(root, ".env")),
      globalEnv: existsSync(GLOBAL_ENV_PATH),
      booksDir: existsSync(join(root, "books")),
      llmConnected: false,
      bookCount: 0,
    };

    try {
      const books = await state.listBooks();
      checks.bookCount = books.length;
    } catch { /* ignore */ }

    try {
      const currentConfig = await loadCurrentProjectConfig({ requireApiKey: false });
      const service = currentConfig.llm.service ?? currentConfig.llm.provider;
      // Hard overall budget so the diagnostics page never hangs on a slow /
      // rate-limited upstream — if we can't confirm connectivity quickly, report
      // it as not-connected rather than spinning.
      const probe = await withTimeout(
        probeServiceCapabilities({
          root,
          service,
          apiKey: currentConfig.llm.apiKey,
          baseUrl: currentConfig.llm.baseUrl,
          preferredApiFormat: currentConfig.llm.apiFormat,
          preferredStream: currentConfig.llm.stream,
          preferredModel: currentConfig.llm.model,
          proxyUrl: currentConfig.llm.proxyUrl,
          language: normalizeStudioLanguage(currentConfig.language),
        }),
        DOCTOR_LLM_PROBE_BUDGET_MS,
        "doctor llm probe",
      );
      checks.llmConnected = probe.ok;
    } catch { /* slow/unreachable upstream — leave llmConnected false */ }

    return c.json(checks);
  });

  return app;
}

// --- Standalone runner ---

export async function startStudioServer(
  root: string,
  port = 4567,
  options?: { readonly staticDir?: string; readonly hostname?: string },
): Promise<ReturnType<typeof serve>> {
  const config = await loadProjectConfig(root, { consumer: "studio", requireApiKey: false });

  const app = createStudioServer(config, root);

  // Serve frontend static files — single process for API + frontend
  if (options?.staticDir) {
    const { readFile: readFileFs } = await import("node:fs/promises");
    const { join: joinPath } = await import("node:path");
    const { existsSync } = await import("node:fs");

    // Serve static assets (js, css, etc.)
    app.get("/assets/*", async (c) => {
      const filePath = joinPath(options.staticDir!, c.req.path);
      try {
        const content = await readFileFs(filePath);
        const ext = filePath.split(".").pop() ?? "";
        const contentTypes: Record<string, string> = {
          js: "application/javascript",
          css: "text/css",
          svg: "image/svg+xml",
          png: "image/png",
          ico: "image/x-icon",
          json: "application/json",
        };
        return new Response(content, {
          headers: { "Content-Type": contentTypes[ext] ?? "application/octet-stream" },
        });
      } catch {
        return c.notFound();
      }
    });

    // SPA fallback — serve index.html for all non-API routes
    const indexPath = joinPath(options.staticDir!, "index.html");
    if (existsSync(indexPath)) {
      const indexHtml = await readFileFs(indexPath, "utf-8");
      app.get("*", (c) => {
        if (c.req.path.startsWith("/api/v1/")) return c.notFound();
        return c.html(indexHtml);
      });
    }
  }

  const hostname = options?.hostname ?? (process.env.INKOS_STUDIO_HOST?.trim() || "127.0.0.1");
  console.log(`InkOS Studio running on http://${hostname}:${port}`);
  return serve({ fetch: app.fetch, port, hostname });
}
