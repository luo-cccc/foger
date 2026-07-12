import { fetchJson, useApi, postApi } from "../hooks/use-api";
import { useEffect, useMemo, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useNewSSEMessages, type SSEMessage } from "../hooks/use-sse";
import { useColors } from "../hooks/use-colors";
import { deriveBookActivity, shouldRefetchBookView } from "../hooks/use-book-activity";
import { localizeKnownRuntimeMessage } from "../lib/error-copy";
import { getPipelineFailureAction, type PipelineFailureStage } from "../lib/pipeline-failure-advice";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import {
  ChevronLeft,
  Zap,
  FileText,
  CheckCheck,
  BarChart2,
  Download,
  Search,
  Wand2,
  Eye,
  Database,
  Check,
  X,
  ShieldCheck,
  RotateCcw,
  RefreshCw,
  Sparkles,
  Trash2,
  Save,
  Hand,
  Settings2,
  Square,
} from "lucide-react";

interface ChapterMeta {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly operationId?: string;
}

interface BookData {
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly status: string;
    readonly chapterWordCount: number;
    readonly targetChapters?: number;
    readonly language?: string;
  };
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly nextChapter: number;
}

type ReviseMode = "spot-fix" | "polish" | "rewrite" | "rework" | "anti-detect";
type ExportFormat = "txt" | "md" | "epub";
type BookStatus = "active" | "paused" | "outlining" | "completed" | "dropped";
type BookPromptAction =
  | { readonly kind: "rewrite"; readonly chapterNum: number }
  | { readonly kind: "revise"; readonly chapterNum: number; readonly mode: ReviseMode }
  | { readonly kind: "resync"; readonly chapterNum: number }
  | { readonly kind: "revise-foundation" }
  | { readonly kind: "plan" }
  | { readonly kind: "compose" };
type ChapterRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "committed-cleanup"; readonly chapterNumber: number }
  | { readonly kind: "rolled-back"; readonly chapterNumber: number; readonly rolledBackTo: number };

interface Nav {
  toDashboard: () => void;
  toChapter: (bookId: string, num: number) => void;
  toAnalytics: (bookId: string) => void;
  toTruth: (bookId: string) => void;
  toServices: () => void;
  toDoctor: (operationId?: string) => void;
}

function pipelineFailureStageLabel(stage: PipelineFailureStage, language?: string): string {
  const labels = language === "en"
    ? { write: "Writing", draft: "Drafting", rewrite: "Rewriting", revise: "Revising", audit: "Auditing", "repair-state": "Repairing state", resync: "Resyncing state" }
    : { write: "写作", draft: "草稿", rewrite: "重写", revise: "修订", audit: "审计", "repair-state": "修复状态", resync: "同步状态" };
  return labels[stage];
}

function getBookPromptCopy(action: BookPromptAction, english: boolean) {
  switch (action.kind) {
    case "rewrite":
      return english
        ? { title: `Rewrite chapter ${action.chapterNum}`, description: "Add an optional brief for this run only. Leave it blank to use the existing focus.", placeholder: "Rewrite direction or constraints", confirm: "Start rewrite", required: false }
        : { title: `重写第 ${action.chapterNum} 章`, description: "可选：输入这次重写要遵循的补充想法，留空则沿用现有 focus。", placeholder: "重写方向或约束", confirm: "开始重写", required: false };
    case "revise":
      return english
        ? { title: `Revise chapter ${action.chapterNum}`, description: "Add an optional brief for this revision. Leave it blank to use the existing focus.", placeholder: "Revision direction or constraints", confirm: "Start revision", required: false }
        : { title: `修订第 ${action.chapterNum} 章`, description: "可选：输入这次修订要遵循的补充想法，留空则沿用现有 focus。", placeholder: "修订方向或约束", confirm: "开始修订", required: false };
    case "resync":
      return english
        ? { title: `Sync chapter ${action.chapterNum}`, description: "Add optional guidance for interpreting the edited chapter body. Leave it blank to sync directly from the text.", placeholder: "Sync guidance", confirm: "Start sync", required: false }
        : { title: `同步第 ${action.chapterNum} 章`, description: "可选：输入同步已编辑正文时要遵循的补充说明，留空则直接按正文同步。", placeholder: "同步说明", confirm: "开始同步", required: false };
    case "revise-foundation":
      return english
        ? { title: "Revise book foundation", description: "This rewrites the book foundation and does not directly change chapter text.", placeholder: "Required revision feedback", confirm: "Revise foundation", required: true }
        : { title: "重修基础设定", description: "此操作会重写书籍基础设定，不直接修改章节正文。", placeholder: "请输入重修反馈（必填）", confirm: "重修设定", required: true };
    case "plan":
      return english
        ? { title: "Plan next chapter", description: "Optionally provide extra context for planning the next chapter.", placeholder: "Planning context", confirm: "Create plan", required: false }
        : { title: "规划下一章", description: "可选：提供下一章规划时要参考的补充说明。", placeholder: "规划补充说明", confirm: "生成规划", required: false };
    case "compose":
      return english
        ? { title: "Compose next chapter", description: "Optionally provide extra context for composing the next chapter.", placeholder: "Composition context", confirm: "Compose chapter", required: false }
        : { title: "组装下一章", description: "可选：提供下一章组装时要参考的补充说明。", placeholder: "组装补充说明", confirm: "开始组装", required: false };
  }
}

function translateChapterStatus(status: string, t: TFunction): string {
  const map: Record<string, () => string> = {
    "ready-for-review": () => t("chapter.readyForReview"),
    "approved": () => t("chapter.approved"),
    "drafted": () => t("chapter.drafted"),
    "needs-revision": () => t("chapter.needsRevision"),
    "imported": () => t("chapter.imported"),
    "audit-failed": () => t("chapter.auditFailed"),
  };
  return map[status]?.() ?? status;
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  "ready-for-review": { color: "text-amber-500 bg-amber-500/10", icon: <Eye size={12} /> },
  approved: { color: "text-emerald-500 bg-emerald-500/10", icon: <Check size={12} /> },
  drafted: { color: "text-muted-foreground bg-muted/20", icon: <FileText size={12} /> },
  "needs-revision": { color: "text-destructive bg-destructive/10", icon: <RotateCcw size={12} /> },
  imported: { color: "text-blue-500 bg-blue-500/10", icon: <Download size={12} /> },
};

export function BookDetail({
  bookId,
  nav,
  theme,
  t,
  sse,
}: {
  bookId: string;
  nav: Nav;
  theme: Theme;
  t: TFunction;
  sse: { messages: ReadonlyArray<SSEMessage> };
}) {
  const c = useColors(theme);
  const { data, loading, error, refetch } = useApi<BookData>(`/books/${bookId}`);
  const [writeRequestPending, setWriteRequestPending] = useState(false);
  const [draftRequestPending, setDraftRequestPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [rewritingChapters, setRewritingChapters] = useState<ReadonlyArray<number>>([]);
  const [revisingChapters, setRevisingChapters] = useState<ReadonlyArray<number>>([]);
  const [syncingChapters, setSyncingChapters] = useState<ReadonlyArray<number>>([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsWordCount, setSettingsWordCount] = useState<number | null>(null);
  const [settingsTargetChapters, setSettingsTargetChapters] = useState<number | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<BookStatus | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("txt");
  const [exportApprovedOnly, setExportApprovedOnly] = useState(false);
  const [bookActionPending, setBookActionPending] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [cancelRequestPending, setCancelRequestPending] = useState(false);
  const [promptAction, setPromptAction] = useState<BookPromptAction | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [promptSubmitting, setPromptSubmitting] = useState(false);
  // Auto (pipeline self-reviews) vs manual (write the draft and stop; you
  // run audit / revise / approve as checkpoint actions). This is scoped to
  // the current book, with project-level mode as the inherited default.
  const [reviewMode, setReviewMode] = useState<"auto" | "manual">("auto");
  useEffect(() => {
    void fetchJson<{ mode?: string }>(`/books/${encodeURIComponent(bookId)}/chapter-review-mode`)
      .then((r) => setReviewMode(r.mode === "manual" ? "manual" : "auto"))
      .catch(() => undefined);
  }, [bookId]);
  const activity = useMemo(() => deriveBookActivity(sse.messages, bookId), [bookId, sse.messages]);
  const writing = writeRequestPending || activity.writing;
  const drafting = draftRequestPending || activity.drafting;
  const longOperationActive = activity.activeOperation !== null;
  const latestPersistedChapter = data?.chapters.reduce(
    (latest, chapter) => Math.max(latest, chapter.number),
    0,
  ) ?? 0;
  const latestChapter = data?.chapters.find((chapter) => chapter.number === latestPersistedChapter);
  const continuationBlocked = latestChapter?.status === "audit-failed"
    || latestChapter?.status === "state-degraded";
  const latestStateDegradedChapter = data?.chapters.at(-1)?.status === "state-degraded"
    ? data.chapters.at(-1)?.number
    : undefined;
  const pipelineFailureAction = activity.lastFailure
    ? getPipelineFailureAction({
      stage: activity.lastFailure.stage,
      error: activity.lastFailure.error,
      canRepairLatestState: latestStateDegradedChapter !== undefined,
    })
    : null;

  useNewSSEMessages(sse.messages, (recent) => {
    const eventData = recent.data as { bookId?: string; recovery?: ChapterRecovery } | null;
    if (eventData?.bookId !== bookId) return;

    if (eventData.recovery?.kind === "rolled-back") {
      setRecoveryNotice(
        data?.book.language === "en"
          ? `Recovered an incomplete chapter ${eventData.recovery.chapterNumber} write and restored the book to chapter ${eventData.recovery.rolledBackTo}.`
          : `已恢复未完成的第 ${eventData.recovery.chapterNumber} 章写入，并回滚至第 ${eventData.recovery.rolledBackTo} 章。`,
      );
    }

    if (recent.event === "write:start") {
      setWriteRequestPending(false);
      return;
    }

    if (recent.event === "draft:start") {
      setDraftRequestPending(false);
      return;
    }

    if (shouldRefetchBookView(recent, bookId)) {
      setWriteRequestPending(false);
      setDraftRequestPending(false);
      refetch();
    }
    if (recent.event === "repair-state:complete") {
      setRecoveryNotice(
        data?.book.language === "en"
          ? "Chapter state repair completed."
          : "章节状态修复已完成。",
      );
    }
    if (recent.event === "resync:complete") {
      setRecoveryNotice(
        data?.book.language === "en"
          ? "Chapter truth and state sync completed."
          : "章节真相与状态同步已完成。",
      );
    }
    if (recent.event.endsWith(":cancelled")) {
      setCancelRequestPending(false);
      setRecoveryNotice(
        data?.book.language === "en"
          ? "Operation cancelled. The previous durable chapter state was preserved."
          : "操作已取消，已保留取消前的持久化章节状态。",
      );
    }
  });

  const handleCancelOperation = async () => {
    const operation = activity.activeOperation;
    if (!operation || operation.cancelling || cancelRequestPending) return;
    setCancelRequestPending(true);
    try {
      await fetchJson(`/books/${bookId}/operations/${operation.requestId}/cancel`, { method: "POST" });
    } catch (e) {
      setCancelRequestPending(false);
      alert(e instanceof Error ? e.message : "Cancel failed");
    }
  };

  const handleWriteNext = async () => {
    setWriteRequestPending(true);
    try {
      await postApi(`/books/${bookId}/write-next`);
    } catch (e) {
      setWriteRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleDraft = async () => {
    setDraftRequestPending(true);
    try {
      await postApi(`/books/${bookId}/draft`);
    } catch (e) {
      setDraftRequestPending(false);
      alert(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleToggleReviewMode = async () => {
    const next = reviewMode === "manual" ? "auto" : "manual";
    setReviewMode(next);
    try {
      await fetchJson(`/books/${encodeURIComponent(bookId)}/chapter-review-mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      });
    } catch {
      setReviewMode(reviewMode); // revert on failure
    }
  };

  const handleDeleteBook = async () => {
    setConfirmDeleteOpen(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/books/${bookId}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? `${res.status}`);
      }
      nav.toDashboard();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const openPrompt = (action: BookPromptAction) => {
    setPromptValue("");
    setPromptAction(action);
  };

  const handleRewrite = (chapterNum: number) => {
    openPrompt({ kind: "rewrite", chapterNum });
  };

  const handleRevise = (chapterNum: number, mode: ReviseMode) => {
    openPrompt({ kind: "revise", chapterNum, mode });
  };

  const handleSync = (chapterNum: number) => {
    openPrompt({ kind: "resync", chapterNum });
  };

  const handleSaveSettings = async () => {
    if (!data) return;
    setSavingSettings(true);
    try {
      const body: Record<string, unknown> = {};
      if (settingsWordCount !== null) body.chapterWordCount = settingsWordCount;
      if (settingsTargetChapters !== null) body.targetChapters = settingsTargetChapters;
      if (settingsStatus !== null) body.status = settingsStatus;
      await fetchJson(`/books/${bookId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleApproveAll = async () => {
    if (!data) return;
    const reviewable = data.chapters.filter((ch) => ch.status === "ready-for-review");
    let failed = 0;
    for (const chapter of reviewable) {
      try {
        await postApi(`/books/${bookId}/chapters/${chapter.number}/approve`);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      alert(`${failed}/${reviewable.length} approve(s) failed`);
    }
    refetch();
  };

  const runBookAction = async (key: string, action: () => Promise<string>) => {
    setBookActionPending(key);
    try {
      alert(await action());
      refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBookActionPending(null);
    }
  };

  const handleEvaluate = async () => {
    await runBookAction("eval", async () => {
      const result = await fetchJson<{
        qualityScore: number;
        totalChapters: number;
        totalWords: number;
        auditPassRate: number;
        avgAiTellDensity: number;
        hookResolveRate: number;
      }>(`/books/${bookId}/eval`);
      return [
        `${t("book.evaluate")}: ${result.qualityScore}/100`,
        `${t("dash.chapters")}: ${result.totalChapters}`,
        `${t("book.words")}: ${result.totalWords.toLocaleString()}`,
        `Audit: ${result.auditPassRate}%`,
        `AI tells: ${result.avgAiTellDensity}/1k`,
        `Hooks: ${result.hookResolveRate}%`,
      ].join("\n");
    });
  };

  const handleConsolidate = async () => {
    await runBookAction("consolidate", async () => {
      const result = await fetchJson<{ archivedVolumes?: number; retainedChapters?: number }>(`/books/${bookId}/consolidate`, {
        method: "POST",
      });
      return data?.book.language === "en"
        ? `Consolidated ${result.archivedVolumes ?? 0} volume(s). Retained ${result.retainedChapters ?? 0} recent chapter summaries.`
        : `已归并 ${result.archivedVolumes ?? 0} 个卷摘要，保留最近 ${result.retainedChapters ?? 0} 条章节摘要。`;
    });
  };

  const handleReviseFoundation = () => {
    openPrompt({ kind: "revise-foundation" });
  };

  const handlePlan = () => {
    openPrompt({ kind: "plan" });
  };

  const handleCompose = () => {
    openPrompt({ kind: "compose" });
  };

  const handleRepairState = async (chapterNum: number) => {
    setBookActionPending(`repair-state-${chapterNum}`);
    try {
      await fetchJson(`/books/${bookId}/repair-state/${chapterNum}`, { method: "POST" });
    } catch (e) {
      alert(e instanceof Error ? e.message : "State repair failed");
    } finally {
      setBookActionPending(null);
    }
  };

  const handlePromptSubmit = async () => {
    const action = promptAction;
    if (!action || promptSubmitting) return;
    const value = promptValue.trim();
    if (action.kind === "revise-foundation" && !value) return;

    setPromptSubmitting(true);
    try {
      switch (action.kind) {
        case "rewrite":
          setRewritingChapters((prev) => [...prev, action.chapterNum]);
          await fetchJson(`/books/${bookId}/rewrite/${action.chapterNum}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ brief: value || undefined }),
          });
          break;
        case "revise":
          setRevisingChapters((prev) => [...prev, action.chapterNum]);
          await fetchJson(`/books/${bookId}/revise/${action.chapterNum}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: action.mode, brief: value || undefined }),
          });
          refetch();
          break;
        case "resync":
          setSyncingChapters((prev) => [...prev, action.chapterNum]);
          await fetchJson(`/books/${bookId}/resync/${action.chapterNum}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ brief: value || undefined }),
          });
          break;
        case "revise-foundation":
          setBookActionPending("revise-foundation");
          await fetchJson(`/books/${bookId}/foundation/revise`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ feedback: value }),
          });
          alert(data?.book.language === "en" ? "Foundation revised." : "基础设定已重修。");
          refetch();
          break;
        case "plan": {
          setBookActionPending("plan");
          const result = await fetchJson<{ chapterNumber?: number; title?: string }>(`/books/${bookId}/plan`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context: value || undefined }),
          });
          alert(data?.book.language === "en"
            ? `Planned chapter ${result.chapterNumber ?? "?"}: ${result.title ?? ""}`
            : `已计划第 ${result.chapterNumber ?? "?"} 章：${result.title ?? ""}`);
          refetch();
          break;
        }
        case "compose": {
          setBookActionPending("compose");
          const result = await fetchJson<{ chapterNumber?: number; title?: string }>(`/books/${bookId}/compose`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context: value || undefined }),
          });
          alert(data?.book.language === "en"
            ? `Composed chapter ${result.chapterNumber ?? "?"}: ${result.title ?? ""}`
            : `已组装第 ${result.chapterNumber ?? "?"} 章：${result.title ?? ""}`);
          refetch();
          break;
        }
      }
      setPromptAction(null);
      setPromptValue("");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Action failed");
    } finally {
      if (action.kind === "rewrite") {
        setRewritingChapters((prev) => prev.filter((n) => n !== action.chapterNum));
      }
      if (action.kind === "revise") {
        setRevisingChapters((prev) => prev.filter((n) => n !== action.chapterNum));
      }
      if (action.kind === "resync") {
        setSyncingChapters((prev) => prev.filter((n) => n !== action.chapterNum));
      }
      if (["revise-foundation", "plan", "compose"].includes(action.kind)) {
        setBookActionPending(null);
      }
      setPromptSubmitting(false);
    }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  const { book, chapters } = data;
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
  const reviewCount = chapters.filter((ch) => ch.status === "ready-for-review").length;

  const currentWordCount = settingsWordCount ?? book.chapterWordCount;
  const currentTargetChapters = settingsTargetChapters ?? book.targetChapters ?? 0;
  const currentStatus = settingsStatus ?? (book.status as BookStatus);

  const exportHref = `/api/v1/books/${bookId}/export?format=${exportFormat}${exportApprovedOnly ? "&approvedOnly=true" : ""}`;
  const promptCopy = promptAction ? getBookPromptCopy(promptAction, book.language === "en") : null;

  return (
    <div className="space-y-8 fade-in">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <button
          onClick={nav.toDashboard}
          className="hover:text-primary transition-colors flex items-center gap-1"
        >
          <ChevronLeft size={14} />
          {t("bread.books")}
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{book.title}</span>
      </nav>

      {recoveryNotice && (
        <div data-testid="chapter-recovery-notice" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {recoveryNotice}
        </div>
      )}

      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-border/40 pb-8">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-serif font-medium">{book.title}</h1>
            {book.language === "en" && (
              <span className="px-1.5 py-0.5 rounded border border-primary/20 text-primary text-[10px] font-bold">EN</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground font-medium">
            <span className="px-2 py-0.5 rounded bg-secondary/50 text-foreground/70 uppercase tracking-wider text-xs">{book.genre}</span>
            <div className="flex items-center gap-1.5">
              <FileText size={14} />
              <span>{chapters.length} {t("dash.chapters")}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Zap size={14} />
              <span>{totalWords.toLocaleString()} {t("book.words")}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleWriteNext}
            disabled={writing || drafting || longOperationActive || continuationBlocked}
            title={latestChapter?.status === "audit-failed"
              ? (book.language === "en"
                  ? `Chapter ${latestChapter.number} failed audit. Revise or rewrite it before continuing.`
                  : `第 ${latestChapter.number} 章审稿未通过，请先修订或重写。`)
              : latestChapter?.status === "state-degraded"
                ? (book.language === "en"
                    ? `Chapter ${latestChapter.number} has degraded state. Repair or rewrite it before continuing.`
                    : `第 ${latestChapter.number} 章状态结算失败，请先修复状态或重写。`)
                : undefined}
            data-testid="write-next-button"
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            {writing ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Zap size={16} />}
            {writing ? t("dash.writing") : t("book.writeNext")}
          </button>
          <button
            onClick={handleDraft}
            disabled={writing || drafting || longOperationActive || continuationBlocked}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-secondary text-foreground rounded-xl hover:bg-secondary/80 transition-all border border-border/50 disabled:opacity-50"
          >
            {drafting ? <div className="w-4 h-4 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" /> : <Wand2 size={16} />}
            {drafting ? t("book.drafting") : t("book.draftOnly")}
          </button>
          <button
            onClick={handleToggleReviewMode}
            title={reviewMode === "manual"
              ? "手动审查：写完即停，由你点 审稿/修订/通过（更快、更可控）。点此切回自动。"
              : "自动审查：写完自动审校并按需重写（更省心，但更慢）。点此切到手动·写完即停。"}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-secondary/60 text-foreground rounded-xl border border-border/50 hover:bg-secondary transition-all"
          >
            {reviewMode === "manual" ? <Hand size={16} /> : <Settings2 size={16} />}
            {reviewMode === "manual" ? "审查：手动·写完即停" : "审查：自动"}
          </button>
          <button
            onClick={() => setConfirmDeleteOpen(true)}
            disabled={deleting}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-white transition-all border border-destructive/20 disabled:opacity-50"
          >
            {deleting ? <div className="w-4 h-4 border-2 border-destructive/20 border-t-destructive rounded-full animate-spin" /> : <Trash2 size={16} />}
            {deleting ? t("common.loading") : t("book.deleteBook")}
          </button>
        </div>
      </div>

      {(writing || drafting || activity.activeOperation || activity.lastFailure) && (
        <div
          data-testid={activity.lastFailure ? "pipeline-failure-notice" : undefined}
          className={`rounded-2xl border px-4 py-3 text-sm ${
            activity.lastFailure
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-primary/20 bg-primary/[0.04] text-foreground"
          }`}
        >
          {activity.lastFailure ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">
                  {t("book.pipelineFailed")} ({pipelineFailureStageLabel(activity.lastFailure.stage, data?.book.language)})
                </div>
                <div className="mt-1 break-words text-xs text-foreground/80">
                  {localizeKnownRuntimeMessage(activity.lastFailure.error)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {pipelineFailureAction === "retry" && (
                  <button
                    data-testid="pipeline-failure-retry"
                    onClick={() => void (activity.lastFailure?.stage === "write" ? handleWriteNext() : handleDraft())}
                    className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background"
                  >
                    <RefreshCw size={13} />
                    {data?.book.language === "en" ? "Retry" : "重试"}
                  </button>
                )}
                {pipelineFailureAction === "repair-state" && latestStateDegradedChapter !== undefined && (
                  <button
                    data-testid="pipeline-failure-repair"
                    onClick={() => void handleRepairState(latestStateDegradedChapter)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                  >
                    <Settings2 size={13} />
                    {data?.book.language === "en" ? "Repair state" : "修复状态"}
                  </button>
                )}
                {pipelineFailureAction === "open-services" && (
                  <button
                    data-testid="pipeline-failure-services"
                    onClick={nav.toServices}
                    className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background"
                  >
                    <Settings2 size={13} />
                    {data?.book.language === "en" ? "Model services" : "模型配置"}
                  </button>
                )}
                <button
                  data-testid="pipeline-failure-doctor"
                  onClick={() => nav.toDoctor()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-background"
                >
                  <ShieldCheck size={13} />
                  {data?.book.language === "en" ? "Open Doctor" : "打开诊断"}
                </button>
              </div>
            </div>
          ) : activity.activeOperation ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                {pipelineFailureStageLabel(activity.activeOperation.kind, data?.book.language)}
                {activity.activeOperation.cancelling || cancelRequestPending
                  ? (data?.book.language === "en" ? " · cancelling and restoring state" : " · 正在取消并恢复状态")
                  : (data?.book.language === "en" ? " · operation in progress" : " · 操作执行中")}
              </span>
              <button
                type="button"
                data-testid="cancel-book-operation"
                onClick={() => void handleCancelOperation()}
                disabled={activity.activeOperation.cancelling || cancelRequestPending}
                className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
              >
                <Square size={12} fill="currentColor" />
                {activity.activeOperation.cancelling || cancelRequestPending
                  ? (data?.book.language === "en" ? "Cancelling" : "正在取消")
                  : (data?.book.language === "en" ? "Cancel" : "取消")}
              </button>
            </div>
          ) : writing ? (
            <span>{t("book.pipelineWriting")}</span>
          ) : (
            <span>{t("book.pipelineDrafting")}</span>
          )}
        </div>
      )}

      {/* Tool Strip */}
      <div className="flex flex-wrap items-center gap-2 py-1">
          {reviewCount > 0 && (
            <button
              onClick={handleApproveAll}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-emerald-500/10 text-emerald-600 rounded-lg hover:bg-emerald-500/20 transition-all border border-emerald-500/20"
            >
              <CheckCheck size={14} />
              {t("book.approveAll")} ({reviewCount})
            </button>
          )}
          <button
            onClick={() => nav.toTruth(bookId)}
            data-testid="truth-files-button"
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <Database size={14} />
            {t("book.truthFiles")}
          </button>
          <button
            onClick={() => nav.toAnalytics(bookId)}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
          >
            <BarChart2 size={14} />
            {t("book.analytics")}
          </button>
          <button
            onClick={handleEvaluate}
            disabled={bookActionPending === "eval"}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50 disabled:opacity-50"
          >
            <Search size={14} />
            {bookActionPending === "eval" ? t("common.loading") : t("book.evaluate")}
          </button>
          <button
            onClick={handleConsolidate}
            disabled={bookActionPending === "consolidate"}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50 disabled:opacity-50"
          >
            <Database size={14} />
            {bookActionPending === "consolidate" ? t("common.loading") : t("book.consolidate")}
          </button>
          <button
            onClick={handleReviseFoundation}
            disabled={bookActionPending === "revise-foundation"}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50 disabled:opacity-50"
          >
            <Sparkles size={14} />
            {bookActionPending === "revise-foundation" ? t("common.loading") : t("book.reviseFoundation")}
          </button>
          <button
            onClick={handlePlan}
            disabled={bookActionPending === "plan"}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50 disabled:opacity-50"
          >
            <FileText size={14} />
            {bookActionPending === "plan" ? t("common.loading") : t("book.planNext")}
          </button>
          <button
            onClick={handleCompose}
            disabled={bookActionPending === "compose"}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50 disabled:opacity-50"
          >
            <Wand2 size={14} />
            {bookActionPending === "compose" ? t("common.loading") : t("book.composeNext")}
          </button>
          <div className="flex items-center gap-2">
            <select
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
              className="px-2 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg border border-border/50 outline-none"
            >
              <option value="txt">TXT</option>
              <option value="md">MD</option>
              <option value="epub">EPUB</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={exportApprovedOnly}
                onChange={(e) => setExportApprovedOnly(e.target.checked)}
                className="rounded border-border/50"
              />
              {t("book.approvedOnly")}
            </label>
            <button
              onClick={async () => {
                try {
                  const data = await fetchJson<{ path?: string; chapters?: number }>(`/books/${bookId}/export-save`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ format: exportFormat, approvedOnly: exportApprovedOnly }),
                  });
                  alert(`${t("common.exportSuccess")}\n${data.path}\n(${data.chapters} ${t("dash.chapters")})`);
                } catch (e) {
                  alert(e instanceof Error ? e.message : "Export failed");
                }
              }}
              className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-secondary/50 text-muted-foreground rounded-lg hover:text-foreground hover:bg-secondary transition-all border border-border/50"
            >
              <Download size={14} />
              {t("book.export")}
            </button>
          </div>
      </div>

      {/* Book Settings */}
      <div className="paper-sheet rounded-2xl border border-border/40 shadow-sm p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">{t("book.settings")}</h2>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.wordsPerChapter")}</label>
            <input
              type="number"
              value={currentWordCount}
              onChange={(e) => setSettingsWordCount(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("create.targetChapters")}</label>
            <input
              type="number"
              value={currentTargetChapters}
              onChange={(e) => setSettingsTargetChapters(Number(e.target.value))}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50 w-32"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t("book.status")}</label>
            <select
              value={currentStatus}
              onChange={(e) => setSettingsStatus(e.target.value as BookStatus)}
              className="px-3 py-2 text-sm rounded-lg border border-border/50 bg-secondary/30 outline-none focus:border-primary/50"
            >
              <option value="active">{t("book.statusActive")}</option>
              <option value="paused">{t("book.statusPaused")}</option>
              <option value="outlining">{t("book.statusOutlining")}</option>
              <option value="completed">{t("book.statusCompleted")}</option>
              <option value="dropped">{t("book.statusDropped")}</option>
            </select>
          </div>
          <button
            onClick={handleSaveSettings}
            disabled={savingSettings}
            className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
          >
            {savingSettings ? <div className="w-4 h-4 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
            {savingSettings ? t("book.saving") : t("book.save")}
          </button>
        </div>
      </div>

      {/* Chapters Table */}
      <div className="paper-sheet rounded-2xl overflow-hidden border border-border/40 shadow-xl shadow-primary/5">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted/30 border-b border-border/50">
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-16">#</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.manuscriptTitle")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-28">{t("book.words")}</th>
                <th className="text-left px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground w-36">{t("book.status")}</th>
                <th className="text-right px-6 py-4 font-bold text-[11px] uppercase tracking-widest text-muted-foreground">{t("book.curate")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {chapters.map((ch, index) => {
                const staggerClass = `stagger-${Math.min(index + 1, 5)}`;
                return (
                <tr
                  key={ch.number}
                  data-testid={`chapter-row-${ch.number}`}
                  data-chapter-status={ch.status}
                  className={`group hover:bg-primary/[0.02] transition-colors fade-in ${staggerClass}`}
                >
                  <td className="px-6 py-4 text-muted-foreground/60 font-mono text-xs">{ch.number.toString().padStart(2, '0')}</td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => nav.toChapter(bookId, ch.number)}
                      className="font-serif text-lg font-medium hover:text-primary transition-colors text-left"
                    >
                      {ch.title || t("chapter.label").replace("{n}", String(ch.number))}
                    </button>
                    {ch.operationId && (
                      <button
                        data-testid={`chapter-operation-${ch.number}`}
                        onClick={() => nav.toDoctor(ch.operationId)}
                        className="mt-1 font-mono text-[10px] text-muted-foreground hover:text-primary hover:underline"
                        title={ch.operationId}
                      >
                        {ch.operationId}
                      </button>
                    )}
                  </td>
                  <td className="px-6 py-4 text-muted-foreground font-medium tabular-nums text-xs">{(ch.wordCount ?? 0).toLocaleString()}</td>
                  <td className="px-6 py-4">
                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight ${STATUS_CONFIG[ch.status]?.color ?? "bg-muted text-muted-foreground"}`}>
                      {STATUS_CONFIG[ch.status]?.icon}
                      {translateChapterStatus(ch.status, t)}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex gap-1.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                      {ch.status === "ready-for-review" && (
                        <>
                          <button
                            onClick={async () => {
                              try { await postApi(`/books/${bookId}/chapters/${ch.number}/approve`); refetch(); }
                              catch (e) { alert(e instanceof Error ? e.message : "Approve failed"); }
                            }}
                            className="p-2 rounded-lg bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500 hover:text-white transition-all shadow-sm"
                            title={t("book.approve")}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={async () => {
                              try { await postApi(`/books/${bookId}/chapters/${ch.number}/reject`); refetch(); }
                              catch (e) { alert(e instanceof Error ? e.message : "Reject failed"); }
                            }}
                            className="p-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive hover:text-white transition-all shadow-sm"
                            title={t("book.reject")}
                          >
                            <X size={14} />
                          </button>
                        </>
                      )}
                      <button
                        onClick={async () => {
                          try {
                            const auditResult = await fetchJson<{ passed?: boolean; issues?: unknown[] }>(`/books/${bookId}/audit/${ch.number}`, { method: "POST" });
                            alert(auditResult.passed ? "Audit passed" : `Audit failed: ${auditResult.issues?.length ?? 0} issues`);
                            refetch();
                          } catch (e) {
                            alert(e instanceof Error ? e.message : "Audit failed");
                          }
                        }}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm"
                        title={t("book.audit")}
                      >
                        <ShieldCheck size={14} />
                      </button>
                      <button
                        onClick={() => handleRewrite(ch.number)}
                        disabled={rewritingChapters.includes(ch.number) || longOperationActive}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                        title={t("book.rewrite")}
                      >
                        {rewritingChapters.includes(ch.number)
                          ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                          : <RotateCcw size={14} />}
                      </button>
                      <button
                        onClick={() => handleSync(ch.number)}
                        disabled={syncingChapters.includes(ch.number) || longOperationActive || ch.number !== latestPersistedChapter}
                        className="p-2 rounded-lg bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all shadow-sm disabled:opacity-50"
                        title={data?.book.language === "en" ? "Sync truth/state from edited chapter" : "根据已编辑章节同步 truth/state"}
                      >
                        {syncingChapters.includes(ch.number)
                          ? <div className="w-3.5 h-3.5 border-2 border-muted-foreground/20 border-t-muted-foreground rounded-full animate-spin" />
                          : <RefreshCw size={14} />}
                      </button>
                      {ch.status === "state-degraded" && (
                        <button
                          onClick={() => handleRepairState(ch.number)}
                          data-testid={`repair-state-${ch.number}`}
                          disabled={bookActionPending === `repair-state-${ch.number}` || longOperationActive}
                          className="p-2 rounded-lg bg-amber-500/10 text-amber-600 hover:bg-amber-500 hover:text-white transition-all shadow-sm disabled:opacity-50"
                          title={t("book.repairState")}
                        >
                          {bookActionPending === `repair-state-${ch.number}`
                            ? <div className="w-3.5 h-3.5 border-2 border-amber-600/20 border-t-amber-600 rounded-full animate-spin" />
                            : <Settings2 size={14} />}
                        </button>
                      )}
                      <select
                        disabled={revisingChapters.includes(ch.number) || longOperationActive}
                        value=""
                        onChange={(e) => {
                          const mode = e.target.value as ReviseMode;
                          if (mode) handleRevise(ch.number, mode);
                        }}
                        className="px-2 py-1.5 text-[11px] font-bold rounded-lg bg-secondary text-muted-foreground border border-border/50 outline-none hover:text-primary hover:bg-primary/10 transition-all disabled:opacity-50 cursor-pointer"
                        title="Revise with AI"
                      >
                        <option value="" disabled>{revisingChapters.includes(ch.number) ? t("common.loading") : t("book.curate")}</option>
                        <option value="spot-fix">{t("book.spotFix")}</option>
                        <option value="polish">{t("book.polish")}</option>
                        <option value="rewrite">{t("book.rewrite")}</option>
                        <option value="rework">{t("book.rework")}</option>
                        <option value="anti-detect">{t("book.antiDetect")}</option>
                      </select>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {chapters.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-muted/20 flex items-center justify-center mb-4">
               <FileText size={20} className="text-muted-foreground/40" />
            </div>
            <p className="text-sm italic font-serif text-muted-foreground">
              {t("book.noChapters")}
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t("book.deleteBook")}
        message={t("book.confirmDelete")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={handleDeleteBook}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
      <Dialog
        open={promptAction !== null}
        onOpenChange={(open) => {
          if (!open && !promptSubmitting) {
            setPromptAction(null);
            setPromptValue("");
          }
        }}
      >
        <DialogContent showCloseButton={!promptSubmitting} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{promptCopy?.title}</DialogTitle>
            <DialogDescription>{promptCopy?.description}</DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            data-testid="book-action-prompt-input"
            value={promptValue}
            onChange={(event) => setPromptValue(event.target.value)}
            placeholder={promptCopy?.placeholder}
            disabled={promptSubmitting}
            className="min-h-28 resize-y"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPromptAction(null);
                setPromptValue("");
              }}
              disabled={promptSubmitting}
            >
              {book.language === "en" ? "Cancel" : "取消"}
            </Button>
            <Button
              type="button"
              data-testid="book-action-prompt-submit"
              onClick={() => void handlePromptSubmit()}
              disabled={promptSubmitting || Boolean(promptCopy?.required && !promptValue.trim())}
            >
              {promptSubmitting
                ? (book.language === "en" ? "Submitting" : "正在提交")
                : promptCopy?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
