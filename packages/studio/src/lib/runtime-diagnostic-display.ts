import { tr } from "./app-language";

export interface RuntimeDiagnosticFact {
  readonly label: string;
  readonly value: string;
}

export interface RuntimeDiagnosticSection {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
}

export interface RuntimeDiagnosticViewModel {
  readonly facts: ReadonlyArray<RuntimeDiagnosticFact>;
  readonly sections: ReadonlyArray<RuntimeDiagnosticSection>;
}

interface MarkdownSection {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
}

interface ClaimLike {
  readonly id?: string;
  readonly content?: string;
  readonly constraints?: {
    readonly requiresCost?: ReadonlyArray<string>;
    readonly forbiddenUses?: ReadonlyArray<string>;
  };
  readonly relations?: {
    readonly conflictsWith?: ReadonlyArray<string>;
  };
}

interface ConflictResolveLike {
  readonly claim?: ClaimLike;
  readonly resolvesBy?: string;
}

interface ChapterClaimsLike {
  readonly chapterNumber?: number;
  readonly usable?: ReadonlyArray<ClaimLike>;
  readonly revealNow?: ReadonlyArray<ClaimLike>;
  readonly mustHide?: ReadonlyArray<ClaimLike>;
  readonly noGeneralize?: ReadonlyArray<ClaimLike>;
  readonly costRequired?: ReadonlyArray<ClaimLike>;
  readonly conflictResolve?: ReadonlyArray<ConflictResolveLike>;
}

interface VolumeContractLike {
  readonly volumeId?: string;
  readonly volumeNumber?: number;
  readonly title?: string;
  readonly chapterStart?: number;
  readonly chapterEnd?: number;
  readonly objective?: string;
  readonly irreversibleEvent?: string;
  readonly keyResults?: ReadonlyArray<{ readonly id?: string; readonly text?: string; readonly status?: string }>;
  readonly protagonistStageGoal?: string;
  readonly foregroundGoal?: string;
  readonly backgroundThread?: string;
  readonly worldRuleReleases?: ReadonlyArray<string>;
  readonly relationshipTensions?: ReadonlyArray<string>;
  readonly hookDebts?: ReadonlyArray<string>;
}

interface VolumeProgressLike {
  readonly entries?: ReadonlyArray<{
    readonly chapter?: number;
    readonly volumeId?: string;
    readonly volumeNumber?: number;
    readonly krRefs?: ReadonlyArray<string>;
    readonly visibleKrRefs?: ReadonlyArray<string>;
    readonly attemptedKrRefs?: ReadonlyArray<string>;
    readonly rationale?: string;
    readonly memoGoal?: string;
  }>;
}

interface ContextPackageLike {
  readonly chapter?: number;
  readonly selectedContext?: ReadonlyArray<{
    readonly source?: string;
    readonly reason?: string;
    readonly excerpt?: string;
  }>;
}

interface ChapterTraceLike {
  readonly chapter?: number;
  readonly plannerInputs?: ReadonlyArray<string>;
  readonly composerInputs?: ReadonlyArray<string>;
  readonly selectedSources?: ReadonlyArray<string>;
  readonly contextTiers?: {
    readonly protectedSources?: ReadonlyArray<string>;
    readonly compressibleSources?: ReadonlyArray<string>;
  };
  readonly tokenBudget?: {
    readonly protectedTokens?: number;
    readonly compressibleTokens?: number;
    readonly totalSelectedTokens?: number;
  };
  readonly compression?: {
    readonly compiledSource?: string;
    readonly protectedSources?: ReadonlyArray<string>;
    readonly compressedSources?: ReadonlyArray<string>;
    readonly protectedTokens?: number;
    readonly compressibleTokens?: number;
    readonly budgetTokens?: number;
  };
  readonly notes?: ReadonlyArray<string>;
}

interface RuleStackLike {
  readonly layers?: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
    readonly precedence?: number;
    readonly scope?: string;
  }>;
  readonly sections?: {
    readonly hard?: ReadonlyArray<string>;
    readonly soft?: ReadonlyArray<string>;
    readonly diagnostic?: ReadonlyArray<string>;
  };
  readonly overrideEdges?: ReadonlyArray<{
    readonly from?: string;
    readonly to?: string;
    readonly allowed?: boolean;
    readonly scope?: string;
  }>;
  readonly activeOverrides?: ReadonlyArray<{
    readonly from?: string;
    readonly to?: string;
    readonly target?: string;
    readonly reason?: string;
  }>;
}

export function buildRuntimeDiagnosticViewModel(
  fileName: string,
  content: string,
): RuntimeDiagnosticViewModel | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (/^runtime\/chapter-\d{4}\.claims\.json$/.test(fileName)) {
    return buildChapterClaimsViewModel(trimmed);
  }
  if (/^runtime\/chapter-\d{4}\.intent\.md$/.test(fileName)) {
    return buildIntentViewModel(trimmed);
  }
  if (/^runtime\/chapter-\d{4}\.plan\.md$/.test(fileName)) {
    return buildPersistedPlanViewModel(trimmed);
  }
  if (/^runtime\/chapter-\d{4}\.claim-brief\.md$/.test(fileName)) {
    return buildClaimBriefViewModel(trimmed);
  }
  if (/^runtime\/chapter-\d{4}\.context\.json$/.test(fileName)) {
    return buildContextPackageViewModel(trimmed);
  }
  if (/^runtime\/chapter-\d{4}\.rule-stack\.yaml$/.test(fileName)) {
    return buildRuleStackViewModel(trimmed);
  }
  if (/^runtime\/chapter-\d{4}\.trace\.json$/.test(fileName)) {
    return buildTraceViewModel(trimmed);
  }
  if (/^runtime\/volume-contracts\.json$/.test(fileName)) {
    return buildVolumeContractsViewModel(trimmed);
  }
  if (/^runtime\/volume-\d{3}\.contract\.json$/.test(fileName)) {
    return buildSingleVolumeContractViewModel(trimmed);
  }
  if (/^runtime\/volume-progress\.json$/.test(fileName)) {
    return buildVolumeProgressViewModel(trimmed);
  }
  if (/^runtime\/(?:volume-dashboard\.md|volume-\d{3}\.dashboard\.md)$/.test(fileName)) {
    return buildVolumeDashboardViewModel(trimmed);
  }
  if (fileName === "runtime/tier2_current_arc.md") {
    return buildCurrentArcViewModel(trimmed);
  }
  return null;
}

function buildChapterClaimsViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const parsed = safeJsonParse<ChapterClaimsLike>(content);
  if (!parsed) return null;

  const revealNow = parsed.revealNow ?? [];
  const mustHide = parsed.mustHide ?? [];
  const noGeneralize = parsed.noGeneralize ?? [];
  const costRequired = parsed.costRequired ?? [];
  const conflictResolve = parsed.conflictResolve ?? [];

  const facts: RuntimeDiagnosticFact[] = [];
  if (typeof parsed.chapterNumber === "number") {
    facts.push({ label: tr("章节", "Chapter"), value: String(parsed.chapterNumber) });
  }
  facts.push(
    { label: tr("可用设定", "Usable"), value: String((parsed.usable ?? []).length) },
    { label: tr("本章揭示", "Reveal Now"), value: String(revealNow.length) },
    { label: tr("必须隐藏", "Must Hide"), value: String(mustHide.length) },
    { label: tr("不可泛化", "No Generalize"), value: String(noGeneralize.length) },
    { label: tr("代价约束", "Cost Required"), value: String(costRequired.length) },
  );

  const sections: RuntimeDiagnosticSection[] = [];
  pushSection(sections, tr("本章计划揭示", "Planned Reveal"), revealNow.map(formatClaimLine));
  pushSection(sections, tr("必须继续隐藏", "Keep Hidden"), mustHide.map(formatClaimLine));
  pushSection(sections, tr("不可泛化提醒", "Do Not Generalize"), noGeneralize.map(formatNoGeneralizeLine));
  pushSection(sections, tr("使用需付代价", "Required Costs"), costRequired.map(formatCostLine));
  pushSection(sections, tr("冲突解析", "Conflict Resolution"), conflictResolve.map(formatConflictResolveLine));

  return { facts, sections };
}

function buildIntentViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const sections = parseMarkdownSections(content, 2);
  if (sections.length === 0) return null;

  const goal = sectionBody(sections, "Goal");
  const outlineNode = sectionBody(sections, "Outline Node");
  const arcContext = sectionBody(sections, "Arc Context");
  const memoSectionLines = sectionLines(sections, "Chapter Memo");
  const threadRefs = collectBulletsUnderSubheading(memoSectionLines, "### Thread Refs");
  const volumeBinding = collectBulletsUnderSubheading(memoSectionLines, "### Volume KR Binding");
  const mustKeep = findMarkdownSectionItems(sections, "Must Keep");
  const mustAvoid = findMarkdownSectionItems(sections, "Must Avoid");
  const styleEmphasis = findMarkdownSectionItems(sections, "Style Emphasis");
  const memoBody = sectionBody(sections, "Chapter Memo");

  const facts: RuntimeDiagnosticFact[] = [
    { label: tr("目标", "Goal"), value: shorten(goal ?? "-", 80) },
    { label: tr("关联线索", "Thread Refs"), value: String(threadRefs.length) },
    { label: tr("卷级绑定", "Volume Bindings"), value: String(volumeBinding.length) },
    { label: tr("保留事项", "Must Keep"), value: String(mustKeep.length) },
    { label: tr("避免事项", "Must Avoid"), value: String(mustAvoid.length) },
  ];

  const viewSections: RuntimeDiagnosticSection[] = [];
  if (goal) pushSection(viewSections, tr("章节目标", "Chapter Goal"), [goal]);
  if (outlineNode) pushSection(viewSections, tr("大纲节点", "Outline Node"), [outlineNode]);
  if (arcContext) pushSection(viewSections, tr("叙事弧上下文", "Arc Context"), [arcContext]);
  pushSection(viewSections, tr("关联线索", "Thread Refs"), threadRefs);
  pushSection(viewSections, tr("卷级 KR 绑定", "Volume KR Binding"), volumeBinding);
  pushSection(viewSections, tr("必须保留", "Must Keep"), mustKeep);
  pushSection(viewSections, tr("必须避免", "Must Avoid"), mustAvoid);
  pushSection(viewSections, tr("风格强调", "Style Emphasis"), styleEmphasis);
  if (memoBody) pushSection(viewSections, tr("章节备忘", "Chapter Memo"), collectListItems(memoBody.split(/\r?\n/)));

  return { facts, sections: viewSections };
}

function buildPersistedPlanViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const sections = parseMarkdownSections(content, 2);
  if (sections.length === 0) return null;

  const metadata = parseKeyValueLines(sectionLines(sections, "Metadata"));
  const intentSection = sectionLines(sections, "Intent");
  const plannerInputs = findMarkdownSectionItems(sections, "Planner Inputs");
  const memoBlock = extractMarkedBlock(content, "MEMO");
  const memoSections = memoBlock ? parseMarkdownSections(memoBlock, 2) : [];

  const facts: RuntimeDiagnosticFact[] = [
    { label: tr("章节", "Chapter"), value: metadata.get("Chapter") ?? "-" },
    { label: tr("黄金开篇", "Golden Opening"), value: metadata.get("Golden Opening") ?? "-" },
    { label: tr("规划输入", "Planner Inputs"), value: String(plannerInputs.length) },
    { label: tr("线索绑定", "Thread Refs"), value: String(findMarkdownSectionItems(memoSections, "关联线索", "Thread Refs").length) },
  ];

  const viewSections: RuntimeDiagnosticSection[] = [];
  const intentGoal = parseFirstKeyValue(intentSection, "Intent Goal");
  const outlineNode = parseFirstKeyValue(intentSection, "Outline Node");
  const arcContext = parseFirstKeyValue(intentSection, "Arc Context");
  if (intentGoal) pushSection(viewSections, tr("章节目标", "Intent Goal"), [intentGoal]);
  if (outlineNode) pushSection(viewSections, tr("大纲节点", "Outline Node"), [outlineNode]);
  if (arcContext) pushSection(viewSections, tr("叙事弧上下文", "Arc Context"), [arcContext]);
  pushSection(viewSections, tr("必须保留", "Must Keep"), collectBulletsUnderSubheading(intentSection, "### Must Keep"));
  pushSection(viewSections, tr("必须避免", "Must Avoid"), collectBulletsUnderSubheading(intentSection, "### Must Avoid"));
  pushSection(viewSections, tr("风格强调", "Style Emphasis"), collectBulletsUnderSubheading(intentSection, "### Style Emphasis"));
  pushSection(viewSections, tr("规划输入", "Planner Inputs"), plannerInputs.map(trimBookPath));

  return { facts, sections: viewSections };
}

function buildClaimBriefViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const lines = content.split(/\r?\n/);
  const chapterNumber = lines
    .map((line) => line.match(/第\s*(\d+)\s*章|Chapter\s+(\d+)/i))
    .find(Boolean);
  const pov = lines
    .map((line) => line.match(/^(?:视角|POV)[:：]\s*(.+)$/i)?.[1]?.trim())
    .find(Boolean);
  const sections = parseMarkdownSections(content, 2);
  if (sections.length === 0) return null;

  const usable = findMarkdownSectionItems(sections, "本章可用设定", "writer 可渲染", "usable");
  const revealNow = findMarkdownSectionItems(sections, "本章计划揭示", "reveal");
  const mustHide = findMarkdownSectionItems(sections, "本章必须隐藏", "hide");
  const noGeneralize = findMarkdownSectionItems(sections, "不可泛化", "generalize");
  const costRequired = findMarkdownSectionItems(sections, "使用需付出代价", "cost");
  const conflictResolve = findMarkdownSectionItems(sections, "冲突解析", "conflict");

  const facts: RuntimeDiagnosticFact[] = [];
  const parsedChapter = chapterNumber?.[1] ?? chapterNumber?.[2];
  if (parsedChapter) facts.push({ label: tr("章节", "Chapter"), value: parsedChapter });
  if (pov) facts.push({ label: tr("视角", "POV"), value: pov });
  facts.push(
    { label: tr("可用设定", "Usable"), value: String(usable.length) },
    { label: tr("计划揭示", "Reveal"), value: String(revealNow.length) },
    { label: tr("必须隐藏", "Must Hide"), value: String(mustHide.length) },
    { label: tr("不可泛化", "No Generalize"), value: String(noGeneralize.length) },
    { label: tr("代价约束", "Cost Required"), value: String(costRequired.length) },
  );

  const viewSections: RuntimeDiagnosticSection[] = [];
  pushSection(viewSections, tr("本章计划揭示", "Planned Reveal"), revealNow);
  pushSection(viewSections, tr("必须继续隐藏", "Keep Hidden"), mustHide);
  pushSection(viewSections, tr("不可泛化提醒", "Do Not Generalize"), noGeneralize);
  pushSection(viewSections, tr("使用需付代价", "Required Costs"), costRequired);
  pushSection(viewSections, tr("冲突解析", "Conflict Resolution"), conflictResolve);

  return { facts, sections: viewSections };
}

function buildVolumeContractsViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const parsed = safeJsonParse<{ readonly contracts?: ReadonlyArray<VolumeContractLike> }>(content);
  const contracts = parsed?.contracts;
  if (!contracts) return null;

  const facts: RuntimeDiagnosticFact[] = [
    { label: tr("卷合同数", "Contracts"), value: String(contracts.length) },
    {
      label: tr("关键结果", "Key Results"),
      value: String(contracts.reduce((sum, contract) => sum + (contract.keyResults?.length ?? 0), 0)),
    },
  ];

  const sections = contracts
    .map((contract) => ({
      title: formatVolumeTitle(contract),
      items: summarizeContract(contract),
    }))
    .filter((section) => section.items.length > 0);

  return { facts, sections };
}

function buildSingleVolumeContractViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const contract = safeJsonParse<VolumeContractLike>(content);
  if (!contract) return null;

  const facts: RuntimeDiagnosticFact[] = [
    { label: tr("卷编号", "Volume"), value: String(contract.volumeNumber ?? contract.volumeId ?? "-") },
    { label: tr("关键结果", "Key Results"), value: String(contract.keyResults?.length ?? 0) },
    {
      label: tr("章节范围", "Chapter Range"),
      value: contract.chapterStart && contract.chapterEnd
        ? `${contract.chapterStart}-${contract.chapterEnd}`
        : tr("未声明", "Undeclared"),
    },
  ];

  return {
    facts,
    sections: [{
      title: formatVolumeTitle(contract),
      items: summarizeContract(contract),
    }],
  };
}

type RuleStackSectionKey = "hard" | "soft" | "diagnostic";

function buildVolumeProgressViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const parsed = safeJsonParse<VolumeProgressLike>(content);
  const entries = (parsed?.entries ?? [])
    .filter((entry) => typeof entry.chapter === "number")
    .sort((left, right) => (left.chapter ?? 0) - (right.chapter ?? 0));
  if (!parsed?.entries) return null;

  const latest = entries[entries.length - 1];
  const volumeIds = [...new Set(entries.map((entry) => entry.volumeId).filter(Boolean))];
  const visibleRefs = entries.reduce((sum, entry) => sum + (entry.visibleKrRefs?.length ?? 0), 0);

  const facts: RuntimeDiagnosticFact[] = [
    { label: tr("进度记录", "Entries"), value: String(entries.length) },
    { label: tr("覆盖卷数", "Volumes"), value: String(volumeIds.length) },
    { label: tr("可见推进", "Visible KR"), value: String(visibleRefs) },
    { label: tr("最新章节", "Latest Chapter"), value: latest?.chapter ? String(latest.chapter) : "-" },
  ];

  const recentItems = [...entries]
    .slice(-6)
    .reverse()
    .map((entry) => formatVolumeProgressLine(entry));

  const groupedByVolume = volumeIds
    .map((volumeId) => {
      const volumeEntries = entries.filter((entry) => entry.volumeId === volumeId);
      const lastEntry = volumeEntries[volumeEntries.length - 1];
      return {
        title: formatVolumeProgressTitle(volumeId, lastEntry?.volumeNumber),
        items: [
          `${tr("记录章节", "Tracked chapters")} ${volumeEntries.map((entry) => `ch${entry.chapter}`).join(", ")}`,
          `${tr("最近绑定", "Recent bindings")} ${renderRefs(lastEntry?.krRefs)}`,
          `${tr("最近可见推进", "Recent visible")} ${renderRefs(lastEntry?.visibleKrRefs)}`,
        ],
      };
    })
    .filter((section) => section.items.some((item) => !item.endsWith(" -")));

  const sections: RuntimeDiagnosticSection[] = [];
  pushSection(sections, tr("最近进度", "Recent Progress"), recentItems);
  sections.push(...groupedByVolume);

  return { facts, sections };
}

function buildCurrentArcViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const lines = content.split(/\r?\n/);
  const updatedChapter = lines
    .map((line) => line.match(/^-+\s*updated_for_chapter:\s*(\d+)/i)?.[1])
    .find(Boolean);
  const sections = parseLabeledBulletSections(content);

  const facts: RuntimeDiagnosticFact[] = [];
  if (updatedChapter) {
    facts.push({ label: tr("更新到章节", "Updated For"), value: updatedChapter });
  }
  facts.push(
    { label: tr("叙事压力", "Pressure"), value: String(sections.get("当前叙事压力")?.length ?? 0) },
    { label: tr("活跃支线", "Active Subplots"), value: String(sections.get("活跃支线")?.length ?? 0) },
    { label: tr("情绪轨迹", "Emotional Beats"), value: String(sections.get("近期情感线")?.length ?? 0) },
    { label: tr("下章焦点", "Next Focus"), value: String(sections.get("下一章规划焦点")?.length ?? 0) },
  );

  const viewSections: RuntimeDiagnosticSection[] = [];
  pushSection(viewSections, tr("当前叙事压力", "Narrative Pressure"), sections.get("当前叙事压力") ?? []);
  pushSection(viewSections, tr("活跃支线", "Active Subplots"), sections.get("活跃支线") ?? []);
  pushSection(viewSections, tr("近期情感线", "Recent Emotional Beats"), sections.get("近期情感线") ?? []);
  pushSection(viewSections, tr("下一章规划焦点", "Next Planning Focus"), sections.get("下一章规划焦点") ?? []);

  return { facts, sections: viewSections };
}

function buildContextPackageViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const parsed = safeJsonParse<ContextPackageLike>(content);
  const selected = parsed?.selectedContext;
  if (!selected) return null;

  const protectedEntries = selected.filter((entry) => isProtectedRuntimeSource(entry.source));
  const runtimeEntries = selected.filter((entry) => entry.source?.startsWith("runtime/"));
  const storyEntries = selected.filter((entry) => entry.source?.startsWith("story/"));

  const facts: RuntimeDiagnosticFact[] = [
    { label: tr("章节", "Chapter"), value: parsed?.chapter ? String(parsed.chapter) : "-" },
    { label: tr("上下文条目", "Context Entries"), value: String(selected.length) },
    { label: tr("受保护来源", "Protected-like"), value: String(protectedEntries.length) },
    { label: tr("运行时来源", "Runtime Sources"), value: String(runtimeEntries.length) },
    { label: tr("故事来源", "Story Sources"), value: String(storyEntries.length) },
  ];

  const viewSections: RuntimeDiagnosticSection[] = [];
  pushSection(viewSections, tr("运行时上下文", "Runtime Context"), summarizeContextEntries(runtimeEntries));
  pushSection(viewSections, tr("故事上下文", "Story Context"), summarizeContextEntries(storyEntries));
  pushSection(viewSections, tr("关键受保护来源", "Protected Sources"), summarizeContextEntries(protectedEntries));

  return { facts, sections: viewSections };
}

function buildRuleStackViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const parsed = parseRuleStackYaml(content);
  if (!parsed) return null;

  const hard = parsed.sections?.hard ?? [];
  const soft = parsed.sections?.soft ?? [];
  const diagnostic = parsed.sections?.diagnostic ?? [];
  const activeOverrides = parsed.activeOverrides ?? [];

  const facts: RuntimeDiagnosticFact[] = [
    { label: tr("规则层", "Layers"), value: String(parsed.layers?.length ?? 0) },
    { label: tr("硬规则", "Hard Rules"), value: String(hard.length) },
    { label: tr("软规则", "Soft Rules"), value: String(soft.length) },
    { label: tr("诊断规则", "Diagnostic Rules"), value: String(diagnostic.length) },
    { label: tr("激活覆盖", "Active Overrides"), value: String(activeOverrides.length) },
  ];

  const layerItems = (parsed.layers ?? []).map((layer) => [
    layer.id?.trim(),
    layer.name?.trim(),
    layer.precedence !== undefined ? `p${layer.precedence}` : undefined,
    layer.scope?.trim(),
  ].filter(Boolean).join(" · "));

  const edgeItems = (parsed.overrideEdges ?? []).map((edge) => {
    const route = [edge.from, edge.to].filter(Boolean).join(" -> ");
    const allowed = edge.allowed === true
      ? tr("允许", "allowed")
      : edge.allowed === false
        ? tr("禁止", "blocked")
        : tr("未知", "unknown");
    return [route, allowed, edge.scope].filter(Boolean).join(" · ");
  });

  const overrideItems = activeOverrides.map((entry) =>
    [
      [entry.from, entry.to].filter(Boolean).join(" -> "),
      entry.target,
      entry.reason,
    ].filter(Boolean).join(" · "),
  );

  const viewSections: RuntimeDiagnosticSection[] = [];
  pushSection(viewSections, tr("规则层级", "Rule Layers"), layerItems);
  pushSection(viewSections, tr("硬规则来源", "Hard Rule Sources"), hard);
  pushSection(viewSections, tr("软规则来源", "Soft Rule Sources"), soft);
  pushSection(viewSections, tr("诊断来源", "Diagnostic Sources"), diagnostic);
  pushSection(viewSections, tr("覆盖边", "Override Edges"), edgeItems);
  pushSection(viewSections, tr("当前激活覆盖", "Active Overrides"), overrideItems);

  return { facts, sections: viewSections };
}

function buildTraceViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const parsed = safeJsonParse<ChapterTraceLike>(content);
  if (!parsed) return null;

  const facts: RuntimeDiagnosticFact[] = [
    { label: tr("章节", "Chapter"), value: parsed.chapter ? String(parsed.chapter) : "-" },
    { label: tr("规划输入", "Planner Inputs"), value: String(parsed.plannerInputs?.length ?? 0) },
    { label: tr("编排输入", "Composer Inputs"), value: String(parsed.composerInputs?.length ?? 0) },
    { label: tr("受保护来源", "Protected Sources"), value: String(parsed.contextTiers?.protectedSources?.length ?? 0) },
    { label: tr("总上下文Token", "Selected Tokens"), value: String(parsed.tokenBudget?.totalSelectedTokens ?? 0) },
  ];

  const viewSections: RuntimeDiagnosticSection[] = [];
  pushSection(viewSections, tr("规划输入", "Planner Inputs"), (parsed.plannerInputs ?? []).map(trimBookPath));
  pushSection(viewSections, tr("编排输入", "Composer Inputs"), (parsed.composerInputs ?? []).map(trimBookPath));
  pushSection(viewSections, tr("已选来源", "Selected Sources"), (parsed.selectedSources ?? []).map(trimBookPath));
  pushSection(viewSections, tr("受保护层", "Protected Tier"), (parsed.contextTiers?.protectedSources ?? []).map(trimBookPath));
  pushSection(viewSections, tr("可压缩层", "Compressible Tier"), (parsed.contextTiers?.compressibleSources ?? []).map(trimBookPath));
  if (parsed.compression) {
    pushSection(viewSections, tr("压缩记录", "Compression"), summarizeCompression(parsed.compression));
  }
  pushSection(viewSections, tr("治理备注", "Notes"), parsed.notes ?? []);

  return { facts, sections: viewSections };
}

function buildVolumeDashboardViewModel(content: string): RuntimeDiagnosticViewModel | null {
  const sections = parseMarkdownSections(content, 2);
  if (sections.length === 0) return null;

  const sectionSummaries = sections.map((section) => summarizeVolumeDashboardSection(section));
  const totalKrs = sectionSummaries.reduce((sum, section) => sum + section.krRows.length, 0);
  const totalDone = sectionSummaries.reduce((sum, section) => sum + countKrStatus(section.krRows, "done"), 0);
  const totalAdvanced = sectionSummaries.reduce((sum, section) => sum + countKrStatus(section.krRows, "advanced"), 0);

  const facts: RuntimeDiagnosticFact[] = [
    { label: tr("卷面板", "Volume Panels"), value: String(sectionSummaries.length) },
    { label: tr("关键结果", "Key Results"), value: String(totalKrs) },
    { label: tr("已完成KR", "Done KR"), value: String(totalDone) },
    { label: tr("推进中KR", "Advanced KR"), value: String(totalAdvanced) },
  ];

  const viewSections: RuntimeDiagnosticSection[] = sectionSummaries.map((section) => ({
    title: section.title,
    items: section.items,
  })).filter((section) => section.items.length > 0);

  return { facts, sections: viewSections };
}

function safeJsonParse<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function pushSection(
  target: RuntimeDiagnosticSection[],
  title: string,
  items: ReadonlyArray<string>,
): void {
  const trimmed = items.map((item) => item.trim()).filter(Boolean);
  if (trimmed.length === 0) return;
  target.push({ title, items: trimmed });
}

function formatClaimLine(claim: ClaimLike): string {
  const id = claim.id?.trim();
  const content = claim.content?.trim();
  if (id && content) return `[${id}] ${content}`;
  return id ?? content ?? "-";
}

function formatNoGeneralizeLine(claim: ClaimLike): string {
  const base = formatClaimLine(claim);
  const forbidden = claim.constraints?.forbiddenUses?.filter(Boolean) ?? [];
  return forbidden.length > 0
    ? `${base} · ${tr("禁止", "Forbidden")}: ${forbidden.join(" / ")}`
    : base;
}

function formatCostLine(claim: ClaimLike): string {
  const base = formatClaimLine(claim);
  const costs = claim.constraints?.requiresCost?.filter(Boolean) ?? [];
  return costs.length > 0
    ? `${base} · ${tr("代价", "Cost")}: ${costs.join(" / ")}`
    : base;
}

function formatConflictResolveLine(entry: ConflictResolveLike): string {
  const claim = entry.claim;
  const base = formatClaimLine(claim ?? {});
  const conflicts = claim?.relations?.conflictsWith?.filter(Boolean) ?? [];
  const resolution = entry.resolvesBy?.trim();
  const relationText = conflicts.length > 0
    ? `${tr("冲突于", "Conflicts with")} ${conflicts.join(" / ")}`
    : tr("存在冲突", "Has conflict");
  return resolution ? `${base} · ${relationText} · ${tr("解析", "Resolve")}: ${resolution}` : `${base} · ${relationText}`;
}

function formatVolumeTitle(contract: VolumeContractLike): string {
  const label = contract.title?.trim() || contract.volumeId?.trim() || tr("未命名卷", "Untitled Volume");
  const volumeNumber = contract.volumeNumber;
  return typeof volumeNumber === "number"
    ? tr(`第${volumeNumber}卷 · ${label}`, `Volume ${volumeNumber} · ${label}`)
    : label;
}

function summarizeContract(contract: VolumeContractLike): string[] {
  const items: string[] = [];
  if (contract.objective) items.push(`${tr("目标", "Objective")}: ${contract.objective}`);
  if (contract.irreversibleEvent) items.push(`${tr("不可逆事件", "Irreversible Event")}: ${contract.irreversibleEvent}`);
  if (contract.protagonistStageGoal) items.push(`${tr("主角阶段", "Protagonist Stage")}: ${contract.protagonistStageGoal}`);
  if (contract.foregroundGoal) items.push(`${tr("前台目标", "Foreground Goal")}: ${contract.foregroundGoal}`);
  if (contract.backgroundThread) items.push(`${tr("后台暗线", "Background Thread")}: ${contract.backgroundThread}`);
  for (const kr of contract.keyResults ?? []) {
    const id = kr.id?.trim() || tr("未编号KR", "KR");
    const text = kr.text?.trim() || tr("未填写描述", "Missing description");
    const status = kr.status?.trim();
    items.push(status ? `${id} [${status}] ${text}` : `${id} ${text}`);
  }
  if ((contract.worldRuleReleases?.length ?? 0) > 0) {
    items.push(`${tr("规则释放", "Rule Releases")}: ${contract.worldRuleReleases?.join(" / ")}`);
  }
  if ((contract.relationshipTensions?.length ?? 0) > 0) {
    items.push(`${tr("关系张力", "Relationship Tensions")}: ${contract.relationshipTensions?.join(" / ")}`);
  }
  if ((contract.hookDebts?.length ?? 0) > 0) {
    items.push(`${tr("Hook 债", "Hook Debts")}: ${contract.hookDebts?.join(" / ")}`);
  }
  return items;
}

function formatVolumeProgressLine(entry: NonNullable<VolumeProgressLike["entries"]>[number]): string {
  const parts = [
    `${tr("第", "Chapter ")}${entry.chapter}${tr("章", "")}`,
    `${tr("绑定", "Bound")}: ${renderRefs(entry.krRefs)}`,
  ];
  if ((entry.visibleKrRefs?.length ?? 0) > 0) {
    parts.push(`${tr("可见推进", "Visible")}: ${renderRefs(entry.visibleKrRefs)}`);
  }
  if ((entry.attemptedKrRefs?.length ?? 0) > 0) {
    parts.push(`${tr("尝试推进", "Attempted")}: ${renderRefs(entry.attemptedKrRefs)}`);
  }
  if (entry.memoGoal?.trim()) {
    parts.push(`${tr("目标", "Goal")}: ${entry.memoGoal.trim()}`);
  }
  if (entry.rationale?.trim()) {
    parts.push(`${tr("说明", "Rationale")}: ${entry.rationale.trim()}`);
  }
  return parts.join(" · ");
}

function formatVolumeProgressTitle(volumeId: string | undefined, volumeNumber: number | undefined): string {
  if (typeof volumeNumber === "number") {
    return tr(`第${volumeNumber}卷进度`, `Volume ${volumeNumber} Progress`);
  }
  return volumeId?.trim() || tr("卷级进度", "Volume Progress");
}

function renderRefs(refs: ReadonlyArray<string> | undefined): string {
  return refs && refs.length > 0 ? refs.join(" / ") : "-";
}

function parseLabeledBulletSections(content: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentLabel: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      currentLabel = null;
      continue;
    }
    const heading = line.match(/^(.+?)[：:]$/)?.[1]?.trim();
    if (heading) {
      currentLabel = heading;
      if (!sections.has(currentLabel)) sections.set(currentLabel, []);
      continue;
    }
    if (currentLabel && line.startsWith("-")) {
      sections.get(currentLabel)?.push(line.replace(/^-\s*/, "").trim());
    }
  }

  return sections;
}

function parseMarkdownSections(content: string, level: number): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const headingPrefix = "#".repeat(level);
  let currentTitle: string | null = null;
  let currentLines: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(new RegExp(`^${headingPrefix}\\s+(.+?)\\s*$`));
    if (headingMatch) {
      if (currentTitle) {
        sections.push({ title: currentTitle, lines: currentLines });
      }
      currentTitle = headingMatch[1]!.trim();
      currentLines = [];
      continue;
    }
    if (currentTitle) currentLines.push(line);
  }

  if (currentTitle) {
    sections.push({ title: currentTitle, lines: currentLines });
  }
  return sections;
}

function findMarkdownSectionItems(
  sections: ReadonlyArray<MarkdownSection>,
  ...prefixes: ReadonlyArray<string>
): string[] {
  const section = sections.find((entry) =>
    prefixes.some((prefix) => entry.title.toLowerCase().includes(prefix.toLowerCase()))
  );
  return section ? collectListItems(section.lines) : [];
}

function sectionBody(sections: ReadonlyArray<MarkdownSection>, titlePrefix: string): string | undefined {
  const section = sections.find((entry) => entry.title.toLowerCase().includes(titlePrefix.toLowerCase()));
  if (!section) return undefined;
  const body = section.lines.join("\n").trim();
  return body && body !== "- none" && body !== "(none)" ? body : undefined;
}

function sectionLines(sections: ReadonlyArray<MarkdownSection>, titlePrefix: string): string[] {
  const section = sections.find((entry) => entry.title.toLowerCase().includes(titlePrefix.toLowerCase()));
  return section ? [...section.lines] : [];
}

function collectListItems(lines: ReadonlyArray<string>): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^-+\s*/, "").trim())
    .filter((line) => line && line !== "(无)" && line.toLowerCase() !== "(none)");
}

function collectBulletsUnderSubheading(lines: ReadonlyArray<string>, heading: string): string[] {
  const bullets: string[] = [];
  let active = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === heading) {
      active = true;
      continue;
    }
    if (active && /^###\s+/.test(line)) break;
    if (active && line.startsWith("- ")) bullets.push(line.replace(/^-+\s*/, "").trim());
  }
  return bullets;
}

function summarizeVolumeDashboardSection(section: MarkdownSection): { title: string; items: string[]; krRows: Array<Record<string, string>> } {
  const keyValueBullets = parseKeyValueBullets(section.lines);
  const recentEntries = collectBulletsUnderHeading(section.lines, "### Recent entries");
  const krRows = parseMarkdownTable(section.lines);
  const krStatusSummary = summarizeKrStatuses(krRows);

  const items: string[] = [];
  for (const key of [
    "objective",
    "irreversibleEvent",
    "protagonistStageGoal",
    "foregroundGoal",
    "backgroundThread",
    "progressEntries",
  ]) {
    const value = keyValueBullets.get(key);
    if (value) {
      items.push(`${humanizeDashboardKey(key)}: ${value}`);
    }
  }

  const supplyLines = [
    keyValueBullets.get("worldRuleReleases"),
    keyValueBullets.get("relationshipTensions"),
    keyValueBullets.get("hookDebts"),
  ].filter(Boolean);
  if (supplyLines.length > 0) {
    items.push(`${tr("卷供给", "Volume Supply")}: ${supplyLines.join(" | ")}`);
  }

  if (krStatusSummary) items.push(krStatusSummary);
  for (const row of krRows.slice(0, 4)) {
    const id = row.KR || row.kr;
    const status = row.status;
    const text = row.text;
    if (id || text) items.push([id, status ? `[${status}]` : "", text].filter(Boolean).join(" "));
  }
  for (const entry of recentEntries.slice(0, 3)) {
    items.push(`${tr("最近章节", "Recent")}: ${entry}`);
  }

  return { title: section.title, items, krRows };
}

function parseKeyValueLines(lines: ReadonlyArray<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    map.set(match[1]!.trim(), match[2]!.trim());
  }
  return map;
}

function parseFirstKeyValue(lines: ReadonlyArray<string>, key: string): string | undefined {
  return parseKeyValueLines(lines).get(key);
}

function parseKeyValueBullets(lines: ReadonlyArray<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/^-\s*([A-Za-z][A-Za-z0-9]*?)\s*:\s*(.+)$/);
    if (!match) continue;
    map.set(match[1]!, match[2]!.trim());
  }
  return map;
}

function parseMarkdownTable(lines: ReadonlyArray<string>): Array<Record<string, string>> {
  const tableLines = lines.map((line) => line.trim()).filter((line) => line.startsWith("|"));
  if (tableLines.length < 3) return [];
  const header = splitMarkdownTableRow(tableLines[0]!);
  const rows = tableLines.slice(2)
    .map(splitMarkdownTableRow)
    .filter((cells) => cells.length === header.length);
  return rows.map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""])));
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function countKrStatus(rows: ReadonlyArray<Record<string, string>>, status: string): number {
  return rows.filter((row) => (row.status ?? "").toLowerCase() === status).length;
}

function summarizeKrStatuses(rows: ReadonlyArray<Record<string, string>>): string | null {
  if (rows.length === 0) return null;
  const done = countKrStatus(rows, "done");
  const advanced = countKrStatus(rows, "advanced");
  const attempted = countKrStatus(rows, "attempted");
  const pending = countKrStatus(rows, "pending");
  return `${tr("KR状态", "KR Status")}: done ${done} / advanced ${advanced} / attempted ${attempted} / pending ${pending}`;
}

function collectBulletsUnderHeading(lines: ReadonlyArray<string>, heading: string): string[] {
  const bullets: string[] = [];
  let active = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === heading) {
      active = true;
      continue;
    }
    if (active && /^###\s+/.test(line)) break;
    if (active && line.startsWith("- ")) {
      bullets.push(line.replace(/^-+\s*/, "").trim());
    }
  }
  return bullets;
}

function humanizeDashboardKey(key: string): string {
  switch (key) {
    case "objective":
      return tr("目标", "Objective");
    case "irreversibleEvent":
      return tr("不可逆事件", "Irreversible Event");
    case "protagonistStageGoal":
      return tr("主角阶段", "Protagonist Stage");
    case "foregroundGoal":
      return tr("前台目标", "Foreground Goal");
    case "backgroundThread":
      return tr("后台暗线", "Background Thread");
    case "progressEntries":
      return tr("进度记录", "Progress Entries");
    default:
      return key;
  }
}

function extractMarkedBlock(markdown: string, name: string): string | undefined {
  const match = markdown.match(new RegExp(`<!--\\s*INKOS_PLAN_${name}_START\\s*-->\\s*([\\s\\S]*?)\\s*<!--\\s*INKOS_PLAN_${name}_END\\s*-->`, "m"));
  return match?.[1]?.trim();
}

function shorten(value: string, limit: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > limit ? `${trimmed.slice(0, Math.max(0, limit - 1))}…` : trimmed;
}

function trimBookPath(value: string): string {
  return value.replace(/^story\//, "").trim();
}

function isProtectedRuntimeSource(source: string | undefined): boolean {
  if (!source) return false;
  return source.startsWith("runtime/")
    || /current_focus|author_intent|story_frame|volume_map|current_state|pending_hooks|audit_drift/.test(source);
}

function summarizeContextEntries(
  entries: ReadonlyArray<{ readonly source?: string; readonly reason?: string; readonly excerpt?: string }>,
): string[] {
  return entries.slice(0, 8).map((entry) => {
    const source = trimBookPath(entry.source ?? "-");
    const reason = entry.reason?.trim();
    const excerpt = entry.excerpt?.trim();
    if (reason && excerpt) return `${source} · ${reason} · ${shorten(excerpt, 80)}`;
    if (reason) return `${source} · ${reason}`;
    return source;
  });
}

function summarizeCompression(compression: NonNullable<ChapterTraceLike["compression"]>): string[] {
  const items = [
    compression.compiledSource ? `${tr("编译来源", "Compiled Source")}: ${trimBookPath(compression.compiledSource)}` : undefined,
    compression.protectedSources?.length
      ? `${tr("保护来源", "Protected Sources")}: ${compression.protectedSources.map(trimBookPath).join(" / ")}`
      : undefined,
    compression.compressedSources?.length
      ? `${tr("被压缩来源", "Compressed Sources")}: ${compression.compressedSources.map(trimBookPath).join(" / ")}`
      : undefined,
    compression.budgetTokens !== undefined
      ? `${tr("压缩预算", "Budget Tokens")}: ${compression.budgetTokens}`
      : undefined,
  ].filter(Boolean);
  return items as string[];
}

function parseRuleStackYaml(content: string): RuleStackLike | null {
  const lines = content.split(/\r?\n/);
  if (!lines.some((line) => line.trim().startsWith("layers:"))) return null;

  const result: {
    layers: Array<NonNullable<RuleStackLike["layers"]>[number]>;
    sections: {
      hard: string[];
      soft: string[];
      diagnostic: string[];
    };
    overrideEdges: Array<NonNullable<RuleStackLike["overrideEdges"]>[number]>;
    activeOverrides: Array<NonNullable<RuleStackLike["activeOverrides"]>[number]>;
  } = {
    layers: [],
    sections: {
      hard: [],
      soft: [],
      diagnostic: [],
    },
    overrideEdges: [],
    activeOverrides: [],
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed === "layers:") {
      const parsed = parseYamlObjectList(lines, index + 1);
      result.layers = parsed.items.map((item) => ({
        id: item.id,
        name: item.name,
        precedence: item.precedence ? Number(item.precedence) : undefined,
        scope: item.scope,
      }));
      index = parsed.nextIndex;
      continue;
    }

    if (trimmed === "sections:") {
      const parsed = parseYamlSections(lines, index + 1);
      result.sections = parsed.sections;
      index = parsed.nextIndex;
      continue;
    }

    if (trimmed === "overrideEdges:") {
      const parsed = parseYamlObjectList(lines, index + 1);
      result.overrideEdges = parsed.items.map((item) => ({
        from: item.from,
        to: item.to,
        allowed: item.allowed === "true" ? true : item.allowed === "false" ? false : undefined,
        scope: item.scope,
      }));
      index = parsed.nextIndex;
      continue;
    }

    if (trimmed === "activeOverrides:") {
      const parsed = parseYamlObjectList(lines, index + 1);
      result.activeOverrides = parsed.items.map((item) => ({
        from: item.from,
        to: item.to,
        target: item.target,
        reason: item.reason,
      }));
      index = parsed.nextIndex;
      continue;
    }

    index += 1;
  }

  return result;
}

function parseYamlObjectList(
  lines: ReadonlyArray<string>,
  startIndex: number,
): { items: Array<Record<string, string>>; nextIndex: number } {
  const items: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  let index = startIndex;

  while (index < lines.length) {
    const raw = lines[index]!;
    const trimmed = raw.trim();
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (indent < 2) break;

    const listItem = raw.match(/^\s*-\s+([A-Za-z0-9_]+):\s*(.+)\s*$/);
    if (listItem) {
      if (current) items.push(current);
      current = { [listItem[1]!]: stripYamlScalar(listItem[2]!) };
      index += 1;
      continue;
    }

    const field = raw.match(/^\s+([A-Za-z0-9_]+):\s*(.+)\s*$/);
    if (field && current) {
      current[field[1]!] = stripYamlScalar(field[2]!);
      index += 1;
      continue;
    }

    index += 1;
  }

  if (current) items.push(current);
  return { items, nextIndex: index };
}

function parseYamlSections(
  lines: ReadonlyArray<string>,
  startIndex: number,
): {
  sections: {
    hard: string[];
    soft: string[];
    diagnostic: string[];
  };
  nextIndex: number;
} {
  const sections: Record<RuleStackSectionKey, string[]> = {
    hard: [],
    soft: [],
    diagnostic: [],
  };
  let currentKey: RuleStackSectionKey | null = null;
  let index = startIndex;

  while (index < lines.length) {
    const raw = lines[index]!;
    const trimmed = raw.trim();
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (indent < 2) break;

    const heading = raw.match(/^\s{2}([A-Za-z0-9_]+):\s*$/);
    if (heading) {
      const key = heading[1] as RuleStackSectionKey;
      if (key in sections) currentKey = key;
      index += 1;
      continue;
    }

    const item = raw.match(/^\s{4}-\s+(.+)\s*$/);
    if (item && currentKey) {
      sections[currentKey] = [...(sections[currentKey] ?? []), stripYamlScalar(item[1]!)];
      index += 1;
      continue;
    }

    index += 1;
  }

  return { sections, nextIndex: index };
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
