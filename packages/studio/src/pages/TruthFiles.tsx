import { fetchJson, useApi } from "../hooks/use-api";
import { useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { Pencil, Save, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { sortTruthFiles, truthFileDisplayLabel } from "../lib/truth-display";
import { buildRuntimeDiagnosticViewModel } from "../lib/runtime-diagnostic-display";
import {
  buildGovernanceOverviewSections,
  latestRuntimeChapter,
  latestRuntimeVolume,
  pickGovernanceOverviewTargets,
  type GovernanceOverviewSection,
  type GovernanceOverviewKind,
} from "../lib/governance-overview";

interface TruthFile {
  readonly name: string;
  readonly size: number;
  readonly preview: string;
  readonly legacy?: boolean;
  readonly readonly?: boolean;
  readonly readonlyReason?: string;
}

const streamdownPlugins = { cjk };

// Phase 5 hotfix: shim files are read-only — point users at the
// authoritative outline/* path so edits actually land where the runtime
// reads them.
export const SHIM_AUTHORITATIVE_PATH: Readonly<Record<string, string>> = {
  "story_bible.md": "outline/story_frame.md",
  "book_rules.md": "outline/story_frame.md",
};

/**
 * Phase hotfix 2: when the GET response carries `legacy: true`, the file is
 * a Phase 5 compat shim. The UI must hide the Edit button and surface a
 * warning pointing at the authoritative outline path. This helper centralizes
 * the rule so it's unit-testable without a DOM.
 */
export interface FilePresentation {
  readonly canEdit: boolean;
  readonly legacy: boolean;
  readonly authoritativePath: string | null;
  readonly readonly: boolean;
  readonly readonlyReason: string | null;
}

export function deriveFilePresentation(
  fileName: string | null,
  fileData: { content: string | null; legacy?: boolean; readonly?: boolean; readonlyReason?: string } | null | undefined,
): FilePresentation {
  const legacy = fileData?.legacy === true;
  const readonly = fileData?.readonly === true;
  const authoritativePath = fileName ? SHIM_AUTHORITATIVE_PATH[fileName] ?? null : null;
  // Edit only makes sense when we actually have content AND it's not a shim.
  const canEdit = !!fileName && !!fileData && fileData.content != null && !legacy && !readonly;
  return {
    canEdit,
    legacy,
    authoritativePath,
    readonly,
    readonlyReason: readonly ? fileData?.readonlyReason ?? "readonly" : null,
  };
}

interface Nav {
  toBook: (id: string) => void;
  toDashboard: () => void;
}

export function TruthFiles({ bookId, nav, theme, t }: { bookId: string; nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const { data } = useApi<{ files: ReadonlyArray<TruthFile> }>(`/books/${bookId}/truth`);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"files" | "overview">("files");
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const { data: fileData, refetch: refetchFile } = useApi<{ file: string; content: string | null; legacy?: boolean; readonly?: boolean; readonlyReason?: string }>(
    selected ? `/books/${bookId}/truth/${selected}` : "",
  );

  const presentation = deriveFilePresentation(selected, fileData);
  const isLegacyShim = presentation.legacy;
  const isRuntimeDiagnostic = presentation.readonlyReason === "runtime-diagnostic";
  const truthFiles = sortTruthFiles(data?.files ?? []);
  const overviewTargets = pickGovernanceOverviewTargets(truthFiles);
  const overviewSections = buildGovernanceOverviewSections(truthFiles);
  const latestChapter = latestRuntimeChapter(truthFiles);
  const latestVolume = latestRuntimeVolume(truthFiles);
  const diagnosticSummary = isRuntimeDiagnostic && selected && fileData?.content
    ? buildRuntimeDiagnosticViewModel(selected, fileData.content)
    : null;

  const targetName = (kind: GovernanceOverviewKind) => overviewTargets.find((target) => target.kind === kind)?.name ?? null;

  const { data: currentArcOverviewData } = useApi<{ file: string; content: string | null }>(
    targetName("current_arc") ? `/books/${bookId}/truth/${targetName("current_arc")}` : "",
  );
  const { data: volumeDashboardOverviewData } = useApi<{ file: string; content: string | null }>(
    targetName("volume_dashboard") ? `/books/${bookId}/truth/${targetName("volume_dashboard")}` : "",
  );
  const { data: volumeProgressOverviewData } = useApi<{ file: string; content: string | null }>(
    targetName("volume_progress") ? `/books/${bookId}/truth/${targetName("volume_progress")}` : "",
  );
  const { data: volumeContractsOverviewData } = useApi<{ file: string; content: string | null }>(
    targetName("volume_contracts") ? `/books/${bookId}/truth/${targetName("volume_contracts")}` : "",
  );
  const { data: chapterIntentOverviewData } = useApi<{ file: string; content: string | null }>(
    targetName("chapter_intent") ? `/books/${bookId}/truth/${targetName("chapter_intent")}` : "",
  );
  const { data: chapterClaimBriefOverviewData } = useApi<{ file: string; content: string | null }>(
    targetName("chapter_claim_brief") ? `/books/${bookId}/truth/${targetName("chapter_claim_brief")}` : "",
  );
  const { data: chapterRuleStackOverviewData } = useApi<{ file: string; content: string | null }>(
    targetName("chapter_rule_stack") ? `/books/${bookId}/truth/${targetName("chapter_rule_stack")}` : "",
  );
  const { data: chapterTraceOverviewData } = useApi<{ file: string; content: string | null }>(
    targetName("chapter_trace") ? `/books/${bookId}/truth/${targetName("chapter_trace")}` : "",
  );

  const overviewCards = [
    buildOverviewCard(targetName("current_arc"), currentArcOverviewData?.content),
    buildOverviewCard(targetName("volume_dashboard"), volumeDashboardOverviewData?.content),
    buildOverviewCard(targetName("volume_progress"), volumeProgressOverviewData?.content),
    buildOverviewCard(targetName("volume_contracts"), volumeContractsOverviewData?.content),
    buildOverviewCard(targetName("chapter_intent"), chapterIntentOverviewData?.content),
    buildOverviewCard(targetName("chapter_claim_brief"), chapterClaimBriefOverviewData?.content),
    buildOverviewCard(targetName("chapter_rule_stack"), chapterRuleStackOverviewData?.content),
    buildOverviewCard(targetName("chapter_trace"), chapterTraceOverviewData?.content),
  ].filter((card): card is OverviewCard => card !== null);
  const overviewCardByName = new Map(overviewCards.map((card) => [card.name, card] as const));

  const startEdit = () => {
    setEditText(fileData?.content ?? "");
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
  };

  const handleSaveEdit = async () => {
    if (!selected) return;
    setSavingEdit(true);
    try {
      await fetchJson(`/books/${bookId}/truth/${selected}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editText }),
      });
      setEditMode(false);
      refetchFile();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingEdit(false);
    }
  };

  const renderFileBody = () => {
    if (!selected || fileData?.content == null) return null;
    if (isRuntimeDiagnostic && selected.endsWith(".md")) {
      return (
        <div className="text-sm leading-relaxed text-foreground/90 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mb-3 [&_h2]:text-base [&_h2]:font-medium [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:mt-4 [&_h3]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_code]:rounded [&_code]:bg-muted/60 [&_code]:px-1 [&_code]:py-0.5 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border/50 [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-border/40 [&_td]:px-2 [&_td]:py-1">
          <Streamdown plugins={streamdownPlugins} mode="static">{fileData.content}</Streamdown>
        </div>
      );
    }
    return <pre className="text-sm leading-relaxed whitespace-pre-wrap font-mono text-foreground/80">{fileData.content}</pre>;
  };

  const renderOverview = () => {
    if (overviewCards.length === 0) {
      return <div className="text-muted-foreground text-sm italic">{t("truth.noOverview")}</div>;
    }

    return (
      <div className="space-y-5">
        <div className="grid gap-px overflow-hidden rounded-md border border-border/50 bg-border/40 sm:grid-cols-2 xl:grid-cols-4">
          <div className="bg-background px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("truth.runtimeArtifacts")}</div>
            <div className="mt-1 text-sm font-medium text-foreground">{overviewCards.length}</div>
          </div>
          <div className="bg-background px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("truth.latestChapter")}</div>
            <div className="mt-1 text-sm font-medium text-foreground">{latestChapter ? Number.parseInt(latestChapter, 10) : "-"}</div>
          </div>
          <div className="bg-background px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("truth.latestVolume")}</div>
            <div className="mt-1 text-sm font-medium text-foreground">{latestVolume ? Number.parseInt(latestVolume, 10) : "-"}</div>
          </div>
          <div className="bg-background px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("truth.runtimeFiles")}</div>
            <div className="mt-1 text-sm font-medium text-foreground">
              {truthFiles.filter((file) => file.readonlyReason === "runtime-diagnostic").length}
            </div>
          </div>
        </div>

        <div className="space-y-5">
          {overviewSections.map((section) => (
            <div key={section.id} className="rounded-md border border-border/40 overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-border/40 bg-muted/20 px-4 py-3">
                <div>
                  <h2 className="text-sm font-medium text-foreground">{overviewSectionTitle(section, t)}</h2>
                  <div className="mt-1 text-xs text-muted-foreground">{overviewSectionSubtitle(section, t)}</div>
                </div>
                <span className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] font-medium ${
                  section.status === "complete"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                }`}>
                  {section.status === "complete" ? t("truth.coverageComplete") : t("truth.coveragePartial")}
                </span>
              </div>

              {section.missing.length > 0 && (
                <div className="border-b border-border/40 bg-amber-500/5 px-4 py-3">
                  <div className="text-xs font-medium text-amber-700 dark:text-amber-300">{t("truth.missingArtifacts")}</div>
                  <ul className="mt-1 space-y-1 text-sm text-amber-700/90 dark:text-amber-200">
                    {section.missing.map((name) => (
                      <li key={`${section.id}-missing-${name}`}>{truthFileDisplayLabel(name)}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="divide-y divide-border/40">
                {section.targets.map((target) => {
                  const card = overviewCardByName.get(target.name);
                  return card ? renderOverviewCard(card, setSelected, setEditMode, setViewMode, c, t) : null;
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.books")}</button>
        <span className="text-border">/</span>
        <button onClick={() => nav.toBook(bookId)} className={c.link}>{bookId}</button>
        <span className="text-border">/</span>
        <span className="text-foreground">{t("truth.title")}</span>
      </div>

      <h1 className="font-serif text-3xl">{t("truth.title")}</h1>

      <div className="inline-flex rounded-lg border border-border/50 bg-muted/30 p-1">
        <button
          onClick={() => setViewMode("files")}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            viewMode === "files" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
          }`}
        >
          {t("truth.filesView")}
        </button>
        <button
          onClick={() => setViewMode("overview")}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            viewMode === "overview" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
          }`}
        >
          {t("truth.overview")}
        </button>
      </div>

      <div className="grid grid-cols-[240px_1fr] gap-6">
        {/* File list */}
        <div data-testid="truth-file-list" className={`border ${c.cardStatic} rounded-lg overflow-hidden`}>
          {truthFiles.map((f) => (
            <button
              key={f.name}
              data-testid="truth-file-button"
              data-file-name={f.name}
              onClick={() => { setSelected(f.name); setEditMode(false); }}
              className={`w-full text-left px-3 py-2.5 text-sm border-b border-border/40 transition-colors ${
                selected === f.name
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-muted/30 text-muted-foreground"
              }`}
            >
              <div className="text-sm truncate">{truthFileDisplayLabel(f.name)}</div>
              <div className="font-mono text-xs text-muted-foreground mt-0.5 truncate">{f.name}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{f.size.toLocaleString()} {t("truth.chars")}</div>
            </button>
          ))}
          {truthFiles.length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">{t("truth.empty")}</div>
          )}
        </div>

        {/* Content viewer */}
        <div className={`border ${c.cardStatic} rounded-lg p-5 min-h-[400px] flex flex-col`}>
          {viewMode === "overview" ? (
            renderOverview()
          ) : selected && fileData?.content != null ? (
            <>
              {isLegacyShim && (
                <div
                  data-testid="legacy-shim-warning"
                  className="mb-3 px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs leading-relaxed"
                >
                  <div className="font-medium">兼容层只读 / Read-only compat shim</div>
                  <div className="mt-1">
                    本文件已废弃，仅供外部读取。权威来源：
                    <code className="ml-1 px-1 py-0.5 rounded bg-background/40 font-mono">
                      {SHIM_AUTHORITATIVE_PATH[selected] ?? "outline/"}
                    </code>
                  </div>
                </div>
              )}
              {isRuntimeDiagnostic && (
                <div
                  data-testid="runtime-diagnostic-warning"
                  className="mb-3 px-3 py-2 rounded-md border border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 text-xs leading-relaxed"
                >
                  <div className="font-medium">运行时诊断文件 / Runtime diagnostic</div>
                  <div className="mt-1">
                    这里展示写作时生成的上下文、设定工作集、卷级合同或进度看板。它只用于追溯系统如何治理章节，不作为可编辑设定。
                  </div>
                </div>
              )}
              {diagnosticSummary && !editMode && (
                <div className="mb-4 space-y-4">
                  {diagnosticSummary.facts.length > 0 && (
                    <div className="grid gap-px overflow-hidden rounded-md border border-border/50 bg-border/40 sm:grid-cols-2 xl:grid-cols-3">
                      {diagnosticSummary.facts.map((fact) => (
                        <div key={`${fact.label}-${fact.value}`} className="bg-background px-3 py-2.5">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{fact.label}</div>
                          <div className="mt-1 text-sm font-medium text-foreground">{fact.value}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {diagnosticSummary.sections.length > 0 && (
                    <div className="divide-y divide-border/40 rounded-md border border-border/40">
                      {diagnosticSummary.sections.map((section) => (
                        <section key={section.title} className="px-4 py-3">
                          <h2 className="text-sm font-medium text-foreground">{section.title}</h2>
                          <ul className="mt-2 space-y-1.5 text-sm leading-6 text-muted-foreground">
                            {section.items.map((item, index) => (
                              <li key={`${section.title}-${index}`}>{item}</li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center justify-end gap-2 mb-3">
                {editMode ? (
                  <>
                    <button
                      onClick={cancelEdit}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnSecondary}`}
                    >
                      <X size={14} />
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      disabled={savingEdit}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnPrimary} disabled:opacity-50`}
                    >
                      <Save size={14} />
                      {savingEdit ? t("truth.saving") : t("truth.save")}
                    </button>
                  </>
                ) : (
                  presentation.canEdit && (
                    <button
                      onClick={startEdit}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md ${c.btnSecondary}`}
                    >
                      <Pencil size={14} />
                      Edit
                    </button>
                  )
                )}
              </div>
              {editMode ? (
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className={`${c.input} flex-1 rounded-md p-3 text-sm font-mono leading-relaxed resize-none min-h-[360px]`}
                />
              ) : (
                renderFileBody()
              )}
            </>
          ) : selected && fileData?.content === null ? (
            <div className="text-muted-foreground text-sm">{t("truth.notFound")}</div>
          ) : (
            <div className="text-muted-foreground/50 text-sm italic">{t("truth.selectFile")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

interface OverviewCard {
  readonly name: string;
  readonly summary: NonNullable<ReturnType<typeof buildRuntimeDiagnosticViewModel>>;
}

function buildOverviewCard(name: string | null, content: string | null | undefined): OverviewCard | null {
  if (!name || !content) return null;
  const summary = buildRuntimeDiagnosticViewModel(name, content);
  return summary ? { name, summary } : null;
}

function renderOverviewCard(
  card: OverviewCard,
  setSelected: (value: string | null) => void,
  setEditMode: (value: boolean) => void,
  setViewMode: (value: "files" | "overview") => void,
  c: ReturnType<typeof useColors>,
  t: TFunction,
) {
  return (
    <section key={card.name} className="px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">{truthFileDisplayLabel(card.name)}</h3>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground truncate">{card.name}</div>
        </div>
        <button
          onClick={() => {
            setSelected(card.name);
            setEditMode(false);
            setViewMode("files");
          }}
          className={`shrink-0 inline-flex items-center px-2.5 py-1.5 text-xs rounded-md ${c.btnSecondary}`}
        >
          {t("truth.openFile")}
        </button>
      </div>

      {card.summary.facts.length > 0 && (
        <div className="mt-3 grid gap-px overflow-hidden rounded-md border border-border/40 bg-border/40 sm:grid-cols-2 xl:grid-cols-4">
          {card.summary.facts.map((fact) => (
            <div key={`${card.name}-${fact.label}-${fact.value}`} className="bg-background px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{fact.label}</div>
              <div className="mt-1 text-sm font-medium text-foreground">{fact.value}</div>
            </div>
          ))}
        </div>
      )}

      {card.summary.sections.length > 0 && (
        <div className="mt-3 space-y-3">
          {card.summary.sections.slice(0, 2).map((section) => (
            <div key={`${card.name}-${section.title}`}>
              <div className="text-xs font-medium text-foreground">{section.title}</div>
              <ul className="mt-1 space-y-1 text-sm leading-6 text-muted-foreground">
                {section.items.slice(0, 3).map((item, index) => (
                  <li key={`${card.name}-${section.title}-${index}`}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function overviewSectionTitle(section: GovernanceOverviewSection, t: TFunction): string {
  return section.id === "volume" ? t("truth.volumeGroup") : t("truth.chapterGroup");
}

function overviewSectionSubtitle(section: GovernanceOverviewSection, t: TFunction): string {
  return section.id === "volume"
    ? t("truth.volumeGroupHint")
    : t("truth.chapterGroupHint");
}
