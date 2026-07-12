import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { PipelineRunner } from "../pipeline/runner.js";
import { ArchitectIncompleteFoundationError } from "../agents/architect.js";
import { type ReviseMode } from "../agents/reviser.js";
import { defaultChapterLength } from "../utils/length-metrics.js";
import { inferLanguage } from "../utils/language.js";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StateManager } from "../state/manager.js";
import { assertSafeTruthFileName, createInteractionToolsFromDeps } from "../interaction/project-tools.js";
import { writeExportArtifact } from "../interaction/export-artifact.js";
import { assertSafeBookId, deriveBookIdFromTitle } from "../utils/book-id.js";
import { safeChildPath } from "../utils/path-safety.js";
import { normalizePlatformId, normalizePlatformOrOther } from "../models/book.js";
import { loadChaptersFromPath } from "./chapter-import-source.js";
import type { AgentContext } from "../agents/base.js";
import { ActionPayloadSchema, type ActionPayload } from "../interaction/action-envelope.js";
import { executeCoreMutation } from "../pipeline/chapter-mutations.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): AgentToolResult<undefined>;
function textResult<T>(text: string, details: T): AgentToolResult<T>;
function textResult<T = undefined>(text: string, details?: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details: details as T };
}

/**
 * Resolve a user-supplied relative path against the books root and guard
 * against path-traversal (../ etc.).
 */
function safeBooksPath(booksRoot: string, relativePath: string): string {
  return safeChildPath(booksRoot, relativePath);
}

function resolveToolBookId(
  toolName: string,
  paramsBookId: string | undefined,
  activeBookId: string | null,
): string {
  const resolvedBookId = paramsBookId ?? activeBookId ?? undefined;
  if (!resolvedBookId) {
    throw new Error(`${toolName} requires bookId when there is no active book.`);
  }
  const safeBookId = assertSafeBookId(resolvedBookId, `${toolName}.bookId`);
  if (paramsBookId && activeBookId && safeBookId !== activeBookId) {
    throw new Error(`${toolName}.bookId must match the active book.`);
  }
  return safeBookId;
}

function createDeterministicInteractionTools(pipeline: PipelineRunner, projectRoot: string) {
  const state = new StateManager(projectRoot);
  return createInteractionToolsFromDeps(pipeline, state);
}

const ProposeActionParams = Type.Object({
  action: Type.Union([
    Type.Literal("create_book"),
    Type.Literal("continuation_import"),
  ], {
    description: "The production or assisted Studio workflow the user appears to want, but which needs explicit confirmation from general chat.",
  }),
  instruction: Type.String({
    description: "The exact production instruction to run after the user confirms. It must be self-contained: include title, story direction, active target, or any referenced context that would otherwise be lost when switching sessions.",
  }),
  title: Type.Optional(Type.String({
    description: "Short user-facing title for the confirmation card.",
  })),
  summary: Type.Optional(Type.String({
    description: "One or two sentences explaining what will happen if the user confirms.",
  })),
  createBook: Type.Optional(Type.Object({
    title: Type.Optional(Type.String({
      description: "Confirmed long-form book title.",
    })),
    genre: Type.Optional(Type.String({
      description: "Confirmed book genre/category.",
    })),
    platform: Type.Optional(Type.Union([
      Type.Literal("tomato"),
      Type.Literal("qidian"),
      Type.Literal("feilu"),
      Type.Literal("other"),
    ], { description: "Confirmed target platform, e.g. tomato for 番茄." })),
    language: Type.Optional(Type.Union([
      Type.Literal("zh"),
      Type.Literal("en"),
    ], { description: "Confirmed writing language." })),
    targetChapters: Type.Optional(Type.Number({
      description: "Confirmed total chapter count.",
    })),
    chapterWordCount: Type.Optional(Type.Number({
      description: "Confirmed per-chapter length in the book's native unit.",
    })),
  }, { description: "Structured execution args for action=create_book. Put platform/length here; do not leave them only in instruction text." })),
});

type ProposeActionParamsType = Static<typeof ProposeActionParams>;
type ProposedActionTargetRoute = "import:chapters" | "import:canon";
type ProposeActionToolOptions = {
  readonly sameSession?: boolean;
};

function proposedActionSessionKind(action: ProposeActionParamsType["action"]): "book-create" | "chat" {
  if (action === "create_book") return "book-create";
  return "chat";
}

function proposedActionTargetRoute(action: ProposeActionParamsType["action"]): ProposedActionTargetRoute | undefined {
  if (action === "continuation_import") return "import:chapters";
  return undefined;
}

function proposedActionFallbackTitle(action: ProposeActionParamsType["action"], isZh: boolean): string {
  switch (action) {
    case "create_book":
      return isZh ? "创建长篇书籍" : "Create a long-form book";
    case "continuation_import":
      return isZh ? "打开续写导入" : "Open continuation import";
    default:
      return isZh ? "确认操作" : "Confirm action";
  }
}

function proposedActionFallbackSummary(action: ProposeActionParamsType["action"], isZh: boolean): string {
  if (proposedActionTargetRoute(action)) {
    return isZh
      ? "确认后只会打开现有 Studio 工具，不会直接生成成品。"
      : "After confirmation, InkOS will only open the existing Studio tool; it will not generate finished content directly.";
  }
  return isZh
    ? "确认后会切换到对应入口并执行这条需求。"
    : "After confirmation, InkOS will switch to the matching surface and run this request.";
}

function compactObject<T extends Record<string, unknown>>(value: T | undefined): T | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      const text = raw.trim();
      if (text) out[key] = text;
      continue;
    }
    if (Array.isArray(raw)) {
      const items = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim());
      if (items.length > 0) out[key] = items;
      continue;
    }
    if (typeof raw === "number") {
      if (Number.isFinite(raw) && raw > 0) out[key] = raw;
      continue;
    }
    if (raw !== undefined && raw !== null) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out as T : undefined;
}

function proposedActionPayload(params: ProposeActionParamsType): ActionPayload | undefined {
  const payload: ActionPayload = {};
  if (params.action === "create_book") {
    const createBook = compactObject(params.createBook);
    if (createBook) payload.createBook = createBook;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function validateProposedActionPayload(payload: ActionPayload | undefined): {
  readonly payload?: ActionPayload;
  readonly error?: string;
} {
  if (!payload) return {};
  const parsed = ActionPayloadSchema.safeParse(payload);
  if (parsed.success) return { payload: parsed.data };
  return { error: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

function requireProposedText(value: string | undefined, label: string): void {
  if (typeof value === "string" && value.trim().length > 0) return;
  throw new Error(`propose_action is missing ${label}; retry with that field in the structured payload, not only in summary or instruction.`);
}

function assertExecutableProposedAction(params: ProposeActionParamsType, payload: ActionPayload | undefined): void {
  if (params.action === "create_book") {
    requireProposedText(payload?.createBook?.title, "createBook.title");
    return;
  }
}

export function createProposeActionTool(
  language: "zh" | "en" = "zh",
  options: ProposeActionToolOptions = {},
): AgentTool<typeof ProposeActionParams> {
  return {
    name: "propose_action",
    description:
      "Ask the user to confirm a production action from general chat. " +
      "Use this before creating books when the user has not clicked a confirmation.",
    label: "Confirm Action",
    parameters: ProposeActionParams,
    async execute(_toolCallId: string, params: ProposeActionParamsType): Promise<AgentToolResult<unknown>> {
      const targetSessionKind = proposedActionSessionKind(params.action);
      const targetRoute = proposedActionTargetRoute(params.action);
      const isZh = language === "zh";
      const title = params.title?.trim() || proposedActionFallbackTitle(params.action, isZh);
      const summary = params.summary?.trim() || proposedActionFallbackSummary(params.action, isZh);
      const proposedPayload = validateProposedActionPayload(proposedActionPayload(params));
      if (proposedPayload.error) {
        throw new Error(`Invalid proposed action payload: ${proposedPayload.error}`);
      }
      const actionPayload = proposedPayload.payload;
      assertExecutableProposedAction(params, actionPayload);
      return textResult(
        [
          title,
          summary,
          "",
          `Instruction: ${params.instruction}`,
        ].join("\n"),
        {
          kind: "proposed_action",
          action: params.action,
          targetSessionKind,
          ...(targetRoute ? { targetRoute } : {}),
          title,
          summary,
          instruction: params.instruction,
          ...(actionPayload ? { actionPayload } : {}),
        },
      );
    },
  };
}

const SubAgentParams = Type.Object({
  agent: Type.Union([
    Type.Literal("architect"),
    Type.Literal("writer"),
    Type.Literal("auditor"),
    Type.Literal("reviser"),
    Type.Literal("exporter"),
  ], { description: "Sub-agent to run. architect initialises a new book; writer writes the next chapter; auditor reviews; reviser revises; exporter exports." }),
  instruction: Type.Optional(Type.String({ description: "Self-contained instruction for the sub-agent (used by architect book creation)." })),
  bookId: Type.Optional(Type.String({ description: "Target book ID. Omit to use the active book." })),
  title: Type.Optional(Type.String({ description: "Book title. Required for architect book creation." })),
  chapterNumber: Type.Optional(Type.Number({ description: "Target chapter number for auditor / reviser." })),
  genre: Type.Optional(Type.String({ description: "Book genre (architect)." })),
  platform: Type.Optional(Type.Union([
    Type.Literal("tomato"),
    Type.Literal("qidian"),
    Type.Literal("feilu"),
    Type.Literal("other"),
  ], { description: "architect only: target platform. Default: other" })),
  language: Type.Optional(Type.Union([
    Type.Literal("zh"),
    Type.Literal("en"),
  ], { description: "architect only: writing language. Default: zh" })),
  targetChapters: Type.Optional(Type.Number({ description: "architect only: total chapter count. Default: 200" })),
  chapterWordCount: Type.Optional(Type.Number({ description: "architect/writer: per-chapter length in the book's native unit (zh characters / en words). Default: 3000 zh, 2000 en" })),
  revise: Type.Optional(Type.Boolean({
    description: "architect only: true 表示在当前 active book 上重新生成架构稿，而不是新建书籍。no-book creation sessions cannot revise an existing book.",
  })),
  feedback: Type.Optional(Type.String({
    description: "architect only: revise 模式下的调整要求。举例：把架构稿从条目式升级成段落式架构稿、某个角色设定需要重新设计、主线冲突表达太弱需要加强等。如果是架构稿评审未通过要求重写的场景，把评审意见的 overallFeedback 原样传入即可",
  })),
  // -- reviser params --
  mode: Type.Optional(Type.Union([
    Type.Literal("spot-fix"),
    Type.Literal("polish"),
    Type.Literal("rewrite"),
    Type.Literal("rework"),
    Type.Literal("anti-detect"),
  ], { description: "reviser only: revision mode. Default: spot-fix" })),
  // -- exporter params --
  format: Type.Optional(Type.Union([
    Type.Literal("txt"),
    Type.Literal("md"),
    Type.Literal("epub"),
  ], { description: "exporter only: export format. Default: txt" })),
  approvedOnly: Type.Optional(Type.Boolean({ description: "exporter only: export only approved chapters. Default: false" })),
});

type SubAgentParamsType = Static<typeof SubAgentParams>;

const ArchitectCreateSubAgentParams = Type.Object({
  agent: Type.Literal("architect"),
  instruction: Type.String({ description: "Confirmed self-contained book-creation instruction for the architect." }),
  bookId: Type.Optional(Type.String({
    description: "Optional new book ID. Usually omit it and let InkOS derive the ID from title.",
  })),
  title: Type.Optional(Type.String({ description: "Confirmed book title. Required when creating a book." })),
  genre: Type.Optional(Type.String({ description: "Confirmed book genre." })),
  platform: Type.Optional(Type.Union([
    Type.Literal("tomato"),
    Type.Literal("qidian"),
    Type.Literal("feilu"),
    Type.Literal("other"),
  ], { description: "Confirmed target platform. Default: other" })),
  language: Type.Optional(Type.Union([
    Type.Literal("zh"),
    Type.Literal("en"),
  ], { description: "Confirmed writing language. Default: zh" })),
  targetChapters: Type.Optional(Type.Number({ description: "Confirmed total chapter count. Default: 200" })),
  chapterWordCount: Type.Optional(Type.Number({ description: "Confirmed per-chapter length in the book's native unit. Default: 3000 zh, 2000 en" })),
});

function prepareSubAgentArguments(args: unknown): SubAgentParamsType {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args as SubAgentParamsType;
  }

  const prepared = { ...(args as Record<string, unknown>) };
  if ("platform" in prepared) {
    const platform = normalizePlatformId(prepared.platform);
    if (platform) {
      prepared.platform = platform;
    } else {
      delete prepared.platform;
    }
  }
  return prepared as SubAgentParamsType;
}

export function createSubAgentTool(
  pipeline: PipelineRunner,
  activeBookId: string | null,
  projectRoot?: string,
  options: {
    readonly actionPayload?: ActionPayload;
    readonly architectCreateOnly?: boolean;
    readonly language?: "zh" | "en";
  } = {},
): AgentTool<any> {
  const sessionIsZh = (options.language ?? "zh") !== "en";
  return {
    name: "sub_agent",
    description: options.architectCreateOnly
      ? "Create a new long-form InkOS book foundation. This confirmation turn can only call agent='architect'; writing chapters happens after the session is bound to the created book."
      : "Delegate a heavy operation to a specialised sub-agent. " +
        "Use agent='architect' to initialise a new book, 'writer' to write the next chapter, " +
        "'auditor' to audit quality, 'reviser' to revise a chapter, 'exporter' to export.",
    label: "Sub-Agent",
    parameters: options.architectCreateOnly ? ArchitectCreateSubAgentParams : SubAgentParams,
    prepareArguments: prepareSubAgentArguments,
    async execute(
      _toolCallId: string,
      params: SubAgentParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const { agent, instruction, bookId, title, chapterNumber, genre, platform, language, targetChapters, chapterWordCount, revise, feedback, mode, format, approvedOnly } = params;

      const progress = (msg: string) => {
        onUpdate?.(textResult(msg));
      };

      try {
        if (options.architectCreateOnly && agent !== "architect") {
          throw new Error("This confirmed book-creation turn can only run the architect. Open the created book or use the book session to write chapters.");
        }
        if (!activeBookId && agent !== "architect") {
          return textResult("No active book. Only the architect agent can create a book from this session.");
        }
        if (activeBookId && agent === "architect" && !revise) {
          return textResult(
            sessionIsZh
              ? "当前已有书籍，不需要建书。如果你想创建新书，请先回到首页。"
              : "This session already has a book, so no new book is needed. To create a new book, go back to the home page first.",
          );
        }

        switch (agent) {
          case "architect": {
            const createBookPayload = options.actionPayload?.createBook;
            if (revise) {
              if (!activeBookId) {
                return textResult("Open the book first before revising its foundation.");
              }
              const targetBookId = resolveToolBookId("architect", bookId, activeBookId);
              if (!projectRoot) {
                throw new Error("Foundation revision requires a project root for the shared mutation command.");
              }
              progress(`Revising foundation for "${targetBookId}"...`);
              await executeCoreMutation({ state: new StateManager(projectRoot), pipeline }, {
                kind: "revise-foundation",
                bookId: targetBookId,
                feedback: feedback ?? instruction ?? "",
              });
              progress(`Foundation revised for "${targetBookId}".`);
              return textResult(
                sessionIsZh
                  ? `Book "${targetBookId}" 架构稿已按要求重写。原书的条目式架构稿已备份到 story/.backup-phase4-<时间戳>/。`
                  : `Book "${targetBookId}" foundation has been rewritten as requested. The previous itemized foundation was backed up to story/.backup-phase4-<timestamp>/.`,
              );
            }
            const confirmedTitle = createBookPayload?.title?.trim();
            const resolvedTitle = confirmedTitle || title?.trim();
            if (!resolvedTitle) {
              return textResult('Error: title is required for the architect agent.');
            }
            const id = confirmedTitle
              ? deriveBookIdFromTitle(confirmedTitle) || `book-${Date.now().toString(36)}`
              : bookId
                ? assertSafeBookId(bookId, "architect.bookId")
                : deriveBookIdFromTitle(resolvedTitle) || `book-${Date.now().toString(36)}`;
            const now = new Date().toISOString();
            const resolvedLanguage = createBookPayload?.language ?? language ?? inferLanguage(instruction);
            progress(`Starting architect for book "${id}"...`);
            await pipeline.initBook(
              {
                id,
                title: resolvedTitle,
                genre: createBookPayload?.genre ?? genre ?? "general",
                platform: normalizePlatformOrOther(createBookPayload?.platform ?? platform),
                language: resolvedLanguage as any,
                status: "outlining" as any,
                targetChapters: createBookPayload?.targetChapters ?? targetChapters ?? 200,
                chapterWordCount: createBookPayload?.chapterWordCount ?? chapterWordCount ?? defaultChapterLength(resolvedLanguage),
                createdAt: now,
                updatedAt: now,
              },
              { externalContext: instruction },
            );
            progress(`Architect finished — book "${id}" foundation created.`);
            return textResult(
              `Book "${resolvedTitle}" (${id}) initialised successfully. Foundation files are ready.`,
              { kind: "book_created", bookId: id, title: resolvedTitle },
            );
          }

          case "writer": {
            const targetBookId = resolveToolBookId("writer", bookId, activeBookId);
            progress(`Writing next chapter for "${targetBookId}"...`);
            const result = await pipeline.writeNextChapter(targetBookId, chapterWordCount);
            progress(`Writer finished chapter for "${targetBookId}".`);
            const resultStatus = (result as any).status;
            const wordCount = (result as any).wordCount ?? "unknown";
            const chapterNumberResult = (result as any).chapterNumber;
            const titleResult = (result as any).title;
            const message = resultStatus && resultStatus !== "ready-for-review" && resultStatus !== "active"
              ? `Chapter output for "${targetBookId}" ended with status "${resultStatus}" and needs review before it is treated as complete. Word count: ${wordCount}.`
              : `Chapter written for "${targetBookId}". Word count: ${wordCount}.`;
            return textResult(
              message,
              {
                kind: "chapter_written",
                bookId: targetBookId,
                chapterNumber: chapterNumberResult,
                title: titleResult,
                wordCount,
                status: resultStatus,
              },
            );
          }

          case "auditor": {
            const targetBookId = resolveToolBookId("auditor", bookId, activeBookId);
            if (!projectRoot) {
              throw new Error("Chapter audit requires a project root for the shared mutation command.");
            }
            progress(`Auditing chapter ${chapterNumber ?? "latest"} for "${targetBookId}"...`);
            const audit = await executeCoreMutation({ state: new StateManager(projectRoot), pipeline }, {
              kind: "audit-chapter",
              bookId: targetBookId,
              chapterNumber,
            });
            progress(`Audit complete for "${targetBookId}".`);
            const issueLines = (audit.issues ?? [])
              .map((i: any) => `[${i.severity}] ${i.description}`)
              .join("\n");
            return textResult(
              `Audit chapter ${audit.chapterNumber}: ${audit.passed ? "PASSED" : "FAILED"}, ${(audit.issues ?? []).length} issue(s).` +
              (issueLines ? `\n${issueLines}` : ""),
            );
          }

          case "reviser": {
            const targetBookId = resolveToolBookId("reviser", bookId, activeBookId);
            const resolvedMode: ReviseMode = (mode as ReviseMode) ?? "spot-fix";
            progress(`Revising "${targetBookId}" chapter ${chapterNumber ?? "latest"} in ${resolvedMode} mode...`);
            const result = await pipeline.reviseDraft(targetBookId, chapterNumber, resolvedMode, instruction);
            const applied = result.applied !== false;
            const resultChapter = result.chapterNumber ?? chapterNumber;
            const details = {
              kind: "chapter_revision",
              bookId: targetBookId,
              chapterNumber: resultChapter,
              mode: resolvedMode,
              applied,
              status: result.status,
              wordCount: result.wordCount,
              fixedIssues: result.fixedIssues,
              skippedReason: result.skippedReason,
              revisionDiagnostics: result.revisionDiagnostics,
            };
            if (!applied) {
              progress(`Revision not applied for "${targetBookId}".`);
              const diagnostics = result.revisionDiagnostics;
              const diagnosticText = diagnostics
                ? [
                    "",
                    "Revision gate:",
                    `- Standard: ${diagnostics.standard}`,
                    `- Before: blocking=${diagnostics.before.blockingCount}, critical=${diagnostics.before.criticalCount}, aiTell=${diagnostics.before.aiTellCount}`,
                    `- After: blocking=${diagnostics.after.blockingCount}, critical=${diagnostics.after.criticalCount}, aiTell=${diagnostics.after.aiTellCount}`,
                    ...(diagnostics.remainingIssues.length > 0
                      ? [
                          "- Remaining issues:",
                          ...diagnostics.remainingIssues.map((issue) => `  - [${issue.severity}] ${issue.category}: ${issue.description}${issue.suggestion ? ` (${issue.suggestion})` : ""}`),
                        ]
                      : []),
                  ].join("\n")
                : "";
              return textResult(
                `Revision not applied for "${targetBookId}" chapter ${resultChapter ?? "latest"}: ${result.skippedReason ?? result.status ?? "pipeline kept the original chapter"}.${diagnosticText}`,
                details,
              );
            }
            progress(`Revision complete for "${targetBookId}".`);
            return textResult(
              `Revision (${resolvedMode}) complete for "${targetBookId}" chapter ${resultChapter ?? "latest"}.`,
              details,
            );
          }

          case "exporter": {
            const targetBookId = resolveToolBookId("exporter", bookId, activeBookId);
            if (!projectRoot) return textResult("Error: exporter requires projectRoot.");
            const inferredFormat = format ?? (/epub/i.test(instruction ?? "")
              ? "epub"
              : /markdown|\bmd\b/i.test(instruction ?? "")
                ? "md"
                : "txt");
            const exportApprovedOnly = approvedOnly ?? /approved|已通过|通过章节/.test(instruction ?? "");
            const state = new StateManager(projectRoot);
            const result = await writeExportArtifact(state, targetBookId, {
              format: inferredFormat,
              approvedOnly: exportApprovedOnly,
            });
            return textResult(
              `Exported "${targetBookId}": ${result.chaptersExported} chapters, ${result.totalWords} words → ${result.outputPath}`,
            );
          }

          default:
            return textResult(`Unknown agent: ${agent}`);
        }
      } catch (err: any) {
        if (agent === "architect" && err instanceof ArchitectIncompleteFoundationError) {
          const missing = err.missing.join(", ");
          return textResult(
            [
              err.message,
              "",
              `缺失 section: ${missing}`,
              "我会把已生成的部分保留下来，并继续补齐缺失 section；不要重新发明一本书。",
            ].join("\n"),
            {
              kind: "architect_incomplete",
              missing: [...err.missing],
              partialContent: err.partialContent,
              retryInstruction: `Continue repairing the architect foundation. Preserve the partial content and fill missing sections: ${missing}.`,
            },
          );
        }
        console.error(`[sub_agent] "${agent}" failed:`, err);
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
const WriteTruthFileParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  fileName: Type.String({ description: "Truth file path under story/. Prefer outline/story_frame.md, outline/volume_map.md, roles/major/<name>.md, roles/minor/<name>.md; flat files such as current_focus.md and author_intent.md are also supported." }),
  content: Type.String({ description: "Full replacement content for the truth file." }),
});

const ImportChaptersParams = Type.Object({
  bookId: Type.Optional(Type.String({
    description: "Target book ID to import into. In active-book sessions, omit it to use the current active book; if provided, it must match the active book. In general chat there is no active book, so it is required and must be an existing book.",
  })),
  sourcePath: Type.String({
    description: "Local path of the chapter source: either the stored_path from the Uploaded Files block (project-relative, e.g. .inkos/uploads/<session>/novel.txt) or an absolute path on this machine that the user provided. A directory imports each .md/.txt file as one chapter in filename order; a single file is split into chapters automatically by heading lines.",
  }),
  splitPattern: Type.Optional(Type.String({
    description: "Single-file mode only: custom JavaScript regex source matching chapter heading lines. Omit to use the default pattern, which matches \"第X章/第X回\" and \"Chapter N\" headings.",
  })),
  resumeFrom: Type.Optional(Type.Number({
    description: "Resume an interrupted import from chapter N (1-based). Required when the book already has chapters: replay starts at chapter N and earlier chapters are kept. Omit for a fresh import into an empty book.",
  })),
  importMode: Type.Optional(Type.Union([
    Type.Literal("continuation"),
    Type.Literal("series"),
  ], {
    description: "continuation (default): the book picks up exactly where the imported text left off, no new spacetime. series: shared universe but an independent new story, so a new spacetime is generated.",
  })),
});

type ImportChaptersParamsType = Static<typeof ImportChaptersParams>;

export function createImportChaptersTool(
  pipeline: PipelineRunner,
  activeBookId: string | null,
  projectRoot: string,
): AgentTool<typeof ImportChaptersParams> {
  return {
    name: "import_chapters",
    description:
      "Import an existing novel's chapters from a local file or directory into an InkOS book as real chapters (not reference material). " +
      "InkOS reverse-engineers foundation/truth files from the imported text and replays every chapter to rebuild story state, so the book can be continued afterwards.",
    label: "Import Chapters",
    parameters: ImportChaptersParams,
    async execute(
      _toolCallId: string,
      params: ImportChaptersParamsType,
      _signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ): Promise<AgentToolResult<unknown>> {
      const targetBookId = resolveToolBookId("import_chapters", params.bookId, activeBookId);

      const state = new StateManager(projectRoot);
      const existingChapterCount = (await state.getNextChapterNumber(targetBookId)) - 1;
      if (existingChapterCount > 0 && params.resumeFrom === undefined) {
        throw new Error(
          `Book "${targetBookId}" already has ${existingChapterCount} chapter(s). ` +
          `Pass resumeFrom=<n> to resume/append from chapter n, or ask the user to clear the existing chapters first.`,
        );
      }

      const resolvedSourcePath = isAbsolute(params.sourcePath)
        ? params.sourcePath
        : resolve(projectRoot, params.sourcePath);
      onUpdate?.(textResult(`Reading chapters from ${resolvedSourcePath}...`));
      const chapters = await loadChaptersFromPath(resolvedSourcePath, params.splitPattern);

      onUpdate?.(textResult(`Found ${chapters.length} chapter(s); importing into "${targetBookId}"...`));
      const result = await pipeline.importChapters({
        bookId: targetBookId,
        chapters,
        resumeFrom: params.resumeFrom,
        importMode: params.importMode,
      });

      const regeneratedFoundation = (params.resumeFrom ?? 1) === 1;
      return textResult(
        [
          `Imported ${result.importedCount} chapter(s) into book "${result.bookId}".`,
          `Total imported length: ${result.totalWords}. Next chapter to write: ${result.nextChapter}.`,
          regeneratedFoundation
            ? "Foundation and truth files were reverse-engineered from the imported text; chapter files and the chapter index were rebuilt by sequential replay."
            : `Resumed replay from chapter ${params.resumeFrom}; earlier chapters and the existing foundation were kept.`,
          `The book can now be continued with sub_agent(agent="writer") in the book session.`,
        ].join("\n"),
        {
          kind: "chapters_imported",
          bookId: result.bookId,
          importedCount: result.importedCount,
          totalWords: result.totalWords,
          nextChapter: result.nextChapter,
          importMode: params.importMode ?? "continuation",
        },
      );
    },
  };
}

export function createWriteTruthFileTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof WriteTruthFileParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "write_truth_file",
    description: "Replace a truth/control file under story/ using deterministic project tools.",
    label: "Write Truth File",
    parameters: WriteTruthFileParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      try {
        const bookId = resolveToolBookId("write_truth_file", params.bookId, activeBookId);
        const fileName = assertSafeTruthFileName(params.fileName);
        await tools.writeTruthFile(bookId, fileName, params.content);
        return textResult(`Updated "${fileName}" for "${bookId}".`);
      } catch (err: any) {
        return textResult(`write_truth_file failed: ${err?.message ?? String(err)}`);
      }
    },
  };
}

const RenameEntityParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  oldValue: Type.String({ description: "Current entity name." }),
  newValue: Type.String({ description: "New entity name." }),
});

export function createRenameEntityTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof RenameEntityParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "rename_entity",
    description: "Rename an entity across truth files and chapters using deterministic edit control.",
    label: "Rename Entity",
    parameters: RenameEntityParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const bookId = resolveToolBookId("rename_entity", params.bookId, activeBookId);
      const result = await tools.renameEntity(bookId, params.oldValue, params.newValue) as {
        readonly __interaction?: { readonly responseText?: string };
      };
      const summary = result.__interaction?.responseText ?? `Renamed "${params.oldValue}" to "${params.newValue}" in "${bookId}".`;
      return textResult(summary);
    },
  };
}

const PatchChapterTextParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  chapterNumber: Type.Number({ description: "Chapter number to patch." }),
  targetText: Type.String({ description: "Exact text to replace." }),
  replacementText: Type.String({ description: "Replacement text." }),
});

export function createPatchChapterTextTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof PatchChapterTextParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "patch_chapter_text",
    description: "Apply a deterministic local text patch to a chapter and mark it for review.",
    label: "Patch Chapter",
    parameters: PatchChapterTextParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const bookId = resolveToolBookId("patch_chapter_text", params.bookId, activeBookId);
      const result = await tools.patchChapterText(
        bookId,
        params.chapterNumber,
        params.targetText,
        params.replacementText,
      ) as {
        readonly __interaction?: { readonly responseText?: string };
      };
      const summary = result.__interaction?.responseText ?? `Patched chapter ${params.chapterNumber} for "${bookId}".`;
      return textResult(summary);
    },
  };
}

const ReplaceChapterTextParams = Type.Object({
  bookId: Type.Optional(Type.String({ description: "Book ID. Omit to use the active book." })),
  chapterNumber: Type.Number({ description: "Chapter number to replace." }),
  fullText: Type.String({ description: "The complete replacement chapter markdown/text supplied by the user." }),
});

export function createReplaceChapterTextTool(
  pipeline: PipelineRunner,
  projectRoot: string,
  activeBookId: string | null,
): AgentTool<typeof ReplaceChapterTextParams> {
  const tools = createDeterministicInteractionTools(pipeline, projectRoot);
  return {
    name: "replace_chapter_text",
    description:
      "Replace a whole existing chapter with user-supplied full chapter text and mark it for review. " +
      "Use only when the user provides the complete replacement chapter; for model-generated rewrites use sub_agent reviser.",
    label: "Replace Chapter",
    parameters: ReplaceChapterTextParams,
    async execute(_toolCallId, params): Promise<AgentToolResult<undefined>> {
      const bookId = resolveToolBookId("replace_chapter_text", params.bookId, activeBookId);
      const result = await tools.replaceChapterText(
        bookId,
        params.chapterNumber,
        params.fullText,
      ) as {
        readonly __interaction?: { readonly responseText?: string };
      };
      const summary = result.__interaction?.responseText ?? `Replaced chapter ${params.chapterNumber} for "${bookId}".`;
      return textResult(summary);
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Read Tool
// ---------------------------------------------------------------------------

const ReadParams = Type.Object({
  path: Type.String({ description: "File path relative to books/, or an absolute path when system path reading is enabled." }),
});

export interface ReadToolOptions {
  readonly allowSystemPaths?: boolean;
}

function resolveReadPath(booksRoot: string, requestedPath: string, options: ReadToolOptions): string {
  if (options.allowSystemPaths && isAbsolute(requestedPath)) {
    return resolve(requestedPath);
  }
  return safeBooksPath(booksRoot, requestedPath);
}

export function createReadTool(
  projectRoot: string,
  options: ReadToolOptions = {},
): AgentTool<typeof ReadParams> {
  const booksRoot = join(projectRoot, "books");
  const description = options.allowSystemPaths
    ? "Read a file. Relative paths resolve under books/; absolute paths read from the system filesystem."
    : "Read a file from the book directory. Path is relative to books/.";

  return {
    name: "read",
    description,
    label: "Read File",
    parameters: ReadParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ReadParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const filePath = resolveReadPath(booksRoot, params.path, options);
        const content = await readFile(filePath, "utf-8");
        return textResult(content);
      } catch (err: any) {
        return textResult(`Failed to read "${params.path}": ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Edit Tool
// ---------------------------------------------------------------------------

const EditParams = Type.Object({
  path: Type.String({ description: "File path relative to books/" }),
  old_string: Type.String({ description: "Exact string to find in the file" }),
  new_string: Type.String({ description: "Replacement string" }),
});

export function createEditTool(projectRoot: string): AgentTool<typeof EditParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "edit",
    description:
      "Edit a file under books/ via exact string replacement. " +
      "old_string must appear exactly once in the file. " +
      "For chapter text use patch_chapter_text; for canonical truth files (outline/story_frame.md, outline/volume_map.md, roles/**/*.md, current_focus.md, author_intent.md) prefer write_truth_file; " +
      "to rewrite or polish a whole chapter call sub_agent with agent=\"reviser\".",
    label: "Edit File",
    parameters: EditParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof EditParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const filePath = safeBooksPath(booksRoot, params.path);
        const content = await readFile(filePath, "utf-8");
        const idx = content.indexOf(params.old_string);
        if (idx === -1) {
          return textResult(`old_string not found in "${params.path}".`);
        }
        if (content.indexOf(params.old_string, idx + 1) !== -1) {
          return textResult(`old_string appears more than once in "${params.path}". Provide a more specific match.`);
        }
        const updated = content.slice(0, idx) + params.new_string + content.slice(idx + params.old_string.length);
        await writeFile(filePath, updated, "utf-8");
        return textResult(`File "${params.path}" updated successfully.`);
      } catch (err: any) {
        return textResult(`Failed to edit "${params.path}": ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Write Tool
// ---------------------------------------------------------------------------

const WriteFileParams = Type.Object({
  path: Type.String({ description: "File path relative to books/" }),
  content: Type.String({ description: "Full file content to write" }),
});

export function createWriteFileTool(projectRoot: string): AgentTool<typeof WriteFileParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "write",
    description:
      "Create a new file, or fully replace an existing file's content under books/. " +
      "Parent directories are created automatically. Existing content is overwritten silently — " +
      "for canonical truth files prefer write_truth_file; " +
      "for whole-chapter rewrites/polishing call sub_agent with agent=\"reviser\".",
    label: "Write File",
    parameters: WriteFileParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof WriteFileParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const filePath = safeBooksPath(booksRoot, params.path);
        const parentDir = resolve(filePath, "..");
        const { mkdir } = await import("node:fs/promises");
        await mkdir(parentDir, { recursive: true });
        await writeFile(filePath, params.content, "utf-8");
        return textResult(`File "${params.path}" written successfully.`);
      } catch (err: any) {
        return textResult(`Failed to write "${params.path}": ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Grep Tool
// ---------------------------------------------------------------------------

const GrepParams = Type.Object({
  bookId: Type.String({ description: "Book ID to search within" }),
  pattern: Type.String({ description: "Search pattern (plain text or regex)" }),
});

export function createGrepTool(projectRoot: string): AgentTool<typeof GrepParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "grep",
    description:
      "Search for a text pattern across a book's story/ and chapters/ directories. Returns matching lines.",
    label: "Search",
    parameters: GrepParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof GrepParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const bookDir = safeBooksPath(booksRoot, params.bookId);
        const regex = new RegExp(params.pattern, "gi");
        const results: string[] = [];

        async function searchDir(dir: string, prefix: string) {
          let entries: string[];
          try {
            entries = await readdir(dir);
          } catch {
            return; // directory doesn't exist
          }
          for (const entry of entries) {
            const fullPath = join(dir, entry);
            const entryStat = await stat(fullPath);
            if (entryStat.isDirectory()) {
              await searchDir(fullPath, `${prefix}${entry}/`);
            } else if (entry.endsWith(".md") || entry.endsWith(".txt") || entry.endsWith(".json")) {
              const content = await readFile(fullPath, "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  results.push(`${prefix}${entry}:${i + 1}: ${lines[i]}`);
                  regex.lastIndex = 0; // reset for next test
                }
              }
            }
          }
        }

        await Promise.all([
          searchDir(join(bookDir, "story"), "story/"),
          searchDir(join(bookDir, "chapters"), "chapters/"),
        ]);

        if (results.length === 0) {
          return textResult(`No matches for "${params.pattern}" in book "${params.bookId}".`);
        }

        const truncated = results.length > 100
          ? results.slice(0, 100).join("\n") + `\n\n... [${results.length - 100} more matches]`
          : results.join("\n");

        return textResult(truncated);
      } catch (err: any) {
        return textResult(`Grep failed: ${err?.message ?? String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Ls Tool
// ---------------------------------------------------------------------------

const LsParams = Type.Object({
  bookId: Type.String({ description: "Book ID" }),
  subdir: Type.Optional(
    Type.String({ description: "Subdirectory within the book, e.g. 'story', 'chapters', 'story/runtime'" }),
  ),
});

export function createLsTool(projectRoot: string): AgentTool<typeof LsParams> {
  const booksRoot = join(projectRoot, "books");

  return {
    name: "ls",
    description: "List files in a book directory. Optionally specify a subdirectory like 'story' or 'chapters'.",
    label: "List Files",
    parameters: LsParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof LsParams>,
    ): Promise<AgentToolResult<undefined>> {
      try {
        const base = safeBooksPath(booksRoot, params.bookId);
        const target = params.subdir ? safeBooksPath(base, params.subdir) : base;

        const entries = await readdir(target);
        const details: string[] = [];

        for (const entry of entries) {
          const fullPath = join(target, entry);
          try {
            const entryStat = await stat(fullPath);
            const suffix = entryStat.isDirectory() ? "/" : ` (${entryStat.size} bytes)`;
            details.push(`${entry}${suffix}`);
          } catch {
            details.push(entry);
          }
        }

        if (details.length === 0) {
          return textResult(`Directory is empty: ${params.bookId}/${params.subdir ?? ""}`);
        }

        return textResult(details.join("\n"));
      } catch (err: any) {
        return textResult(`Failed to list "${params.bookId}/${params.subdir ?? ""}": ${err?.message ?? String(err)}`);
      }
    },
  };
}
