import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ReviseMode, ReviseOutput } from "../agents/reviser.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import type {
  ChapterReviewTelemetry,
  ChapterReviewTerminationReason,
} from "../models/chapter.js";
import { hasCriticalIssue } from "./chapter-quality-gate.js";
import { countChapterLength, isOutsideHardRange } from "../utils/length-metrics.js";

export interface ChapterReviewCycleUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewCycleControlInput {
  readonly chapterIntent: string;
  readonly chapterMemo?: ChapterMemo;
  readonly chapterIntentData?: ChapterIntent;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

export interface ChapterReviewCycleResult {
  readonly finalContent: string;
  readonly finalWordCount: number;
  readonly preAuditNormalizedWordCount: number;
  readonly revised: boolean;
  readonly auditResult: AuditResult;
  readonly totalUsage: ChapterReviewCycleUsage;
  readonly postReviseCount: number;
  readonly normalizeApplied: boolean;
  readonly reviewAttempts: ReadonlyArray<ChapterReviewAttempt>;
  readonly reviewTelemetry: ChapterReviewTelemetry;
}

export interface ChapterReviewAttempt {
  readonly stage: "initial" | "revision";
  readonly iteration: number;
  readonly selected: boolean;
  readonly score: number;
  readonly passed: boolean;
  readonly wordCount: number;
  readonly lengthInRange: boolean;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly aiTellCount: number;
  readonly actionableIssues: ReadonlyArray<AuditIssue>;
}

export interface ChapterReviewEvaluation {
  readonly auditResult: AuditResult;
  readonly aiTellCount: number;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly revisionBlockingIssues: ReadonlyArray<AuditIssue>;
}

export interface ChapterReviewEvaluationOptions {
  readonly temperature?: number;
  readonly verificationIssues?: ReadonlyArray<AuditIssue>;
}

const DEFAULT_MAX_REVIEW_ITERATIONS = 2;
const PASS_SCORE_THRESHOLD = 85;
const NET_IMPROVEMENT_EPSILON = 3;

interface ReviewSnapshot {
  readonly content: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly score: number;
  readonly lengthInRange: boolean;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly aiTellCount: number;
  readonly revisionBlockingIssues: ReadonlyArray<AuditIssue>;
}

interface ReviewAssessment {
  readonly auditResult: AuditResult;
  readonly score: number;
  readonly lengthInRange: boolean;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly aiTellCount: number;
  readonly revisionBlockingIssues: ReadonlyArray<AuditIssue>;
}

export async function runChapterReviewCycle(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly initialOutput: Pick<WriteChapterOutput, "content" | "wordCount" | "postWriteErrors" | "postWriteWarnings">;
  readonly reducedControlInput?: ChapterReviewCycleControlInput;
  readonly lengthSpec: LengthSpec;
  readonly initialUsage: ChapterReviewCycleUsage;
  readonly createReviser: () => {
    reviseChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      issues: ReadonlyArray<AuditIssue>,
      mode?: ReviseMode,
      genre?: string,
      options?: {
        chapterIntent?: string;
        chapterMemo?: ChapterMemo;
        chapterIntentData?: ChapterIntent;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        lengthSpec?: LengthSpec;
      },
    ) => Promise<ReviseOutput>;
  };
  readonly evaluateChapter: (
    content: string,
    options?: ChapterReviewEvaluationOptions,
  ) => Promise<ChapterReviewEvaluation>;
  readonly normalizeDraftLengthIfNeeded: (chapterContent: string) => Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: ChapterReviewCycleUsage;
  }>;
  readonly normalizePostWriteSurface?: (chapterContent: string) => string;
  readonly assertChapterContentNotEmpty: (content: string, stage: string) => void;
  readonly addUsage: (
    left: ChapterReviewCycleUsage,
    right?: ChapterReviewCycleUsage,
  ) => ChapterReviewCycleUsage;
  readonly maxReviewIterations?: number;
  readonly maxRevisionCalls?: number;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logStage: (message: { zh: string; en: string }) => void;
}): Promise<ChapterReviewCycleResult> {
  let totalUsage = params.initialUsage;
  let normalizeApplied = false;
  let finalContent = params.initialOutput.content;
  let finalWordCount = params.initialOutput.wordCount;
  let auditCalls = 0;
  let revisionCalls = 0;
  let normalizationCalls = 0;

  // ---------------------------------------------------------------------------
  // Length normalization: dedicated step, only runs for clear hard-range drift.
  // Length is NOT mixed into the reviser's issues — normalize handles it.
  // ---------------------------------------------------------------------------
  const normalizeIfHardDrift = async (content: string): Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
  }> => {
    const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
    if (!isOutsideHardRange(wordCount, params.lengthSpec)) {
      return { content, wordCount, applied: false };
    }
    normalizationCalls += 1;
    const result = await params.normalizeDraftLengthIfNeeded(content);
    totalUsage = params.addUsage(totalUsage, result.tokenUsage);
    return result;
  };

  const normalizedBeforeAudit = await normalizeIfHardDrift(finalContent);
  finalContent = params.normalizePostWriteSurface?.(normalizedBeforeAudit.content) ?? normalizedBeforeAudit.content;
  finalWordCount = countChapterLength(finalContent, params.lengthSpec.countingMode);
  normalizeApplied = normalizeApplied || normalizedBeforeAudit.applied;
  const preAuditNormalizedWordCount = finalWordCount;
  params.assertChapterContentNotEmpty(finalContent, "draft generation");

  // ---------------------------------------------------------------------------
  // Helper: assess a chapter (audit + deterministic checks + length + score)
  // ---------------------------------------------------------------------------
  const assess = async (
    content: string,
    options?: ChapterReviewEvaluationOptions,
  ): Promise<ReviewAssessment> => {
    auditCalls += 1;
    const evaluation = await params.evaluateChapter(content, options);
    const reportedScore = evaluation.auditResult.overallScore;
    const score = reportedScore === undefined || (reportedScore <= 0 && evaluation.auditResult.passed)
      ? 100
      : reportedScore;
    const auditResult = score === reportedScore
      ? evaluation.auditResult
      : { ...evaluation.auditResult, overallScore: score };
    totalUsage = params.addUsage(totalUsage, auditResult.tokenUsage);
    const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
    const lengthInRange = !isOutsideHardRange(wordCount, params.lengthSpec);

    return {
      auditResult,
      score,
      lengthInRange,
      blockingCount: evaluation.blockingCount,
      criticalCount: evaluation.criticalCount,
      aiTellCount: evaluation.aiTellCount,
      revisionBlockingIssues: evaluation.revisionBlockingIssues,
    };
  };

  const addInitialPostWriteIssues = (assessment: ReviewAssessment): ReviewAssessment => {
    const postWriteIssues: AuditIssue[] = [
      ...params.initialOutput.postWriteErrors.map((issue): AuditIssue => ({
        severity: "critical",
        category: issue.rule,
        description: issue.description,
        suggestion: issue.suggestion,
        repairScope: issue.repairScope,
      })),
      ...params.initialOutput.postWriteWarnings.map((issue): AuditIssue => ({
        severity: "warning",
        category: issue.rule,
        description: issue.description,
        suggestion: issue.suggestion,
        repairScope: issue.repairScope,
      })),
    ];
    if (postWriteIssues.length === 0) return assessment;

    const revisionBlockingIssues = deduplicateIssues([
      ...assessment.revisionBlockingIssues,
      ...postWriteIssues,
    ]);
    const auditIssues = deduplicateIssues([
      ...assessment.auditResult.issues,
      ...postWriteIssues,
    ]);
    return {
      ...assessment,
      auditResult: {
        ...assessment.auditResult,
        passed: assessment.auditResult.passed
          && !auditIssues.some((issue) => issue.severity === "critical"),
        issues: auditIssues,
      },
      blockingCount: revisionBlockingIssues.filter(
        (issue) => issue.severity === "warning" || issue.severity === "critical",
      ).length,
      criticalCount: revisionBlockingIssues.filter((issue) => issue.severity === "critical").length,
      revisionBlockingIssues,
    };
  };

  const isPassed = (assessment: ReviewAssessment): boolean =>
    !hasCriticalIssue(assessment.auditResult.issues)
    && assessment.score >= PASS_SCORE_THRESHOLD
    && assessment.lengthInRange;

  const actionableIssueFingerprint = (assessment: ReviewAssessment): string =>
    assessment.revisionBlockingIssues
      .filter((issue) => issue.severity !== "info")
      .map((issue) => [
        issue.severity,
        normalizeFingerprintText(issue.category),
        normalizeFingerprintText(issue.description),
        issue.repairScope ?? "",
      ].join("|"))
      .sort()
      .join("\n");

  const hasMeaningfulProgress = (before: ReviewAssessment, after: ReviewAssessment): boolean =>
    after.criticalCount < before.criticalCount
    || after.blockingCount < before.blockingCount
    || after.aiTellCount < before.aiTellCount
    || (
      after.score >= before.score + NET_IMPROVEMENT_EPSILON
      && actionableIssueFingerprint(after) !== actionableIssueFingerprint(before)
    );

  // ---------------------------------------------------------------------------
  // Scoring loop: assess → revise → assess. Default is two automatic repair
  // passes so structural issues can converge without making retries unbounded.
  // ---------------------------------------------------------------------------
  const configuredReviewIterations = Math.max(
    0,
    Math.floor(params.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS),
  );
  const configuredRevisionCalls = params.maxRevisionCalls === undefined
    ? configuredReviewIterations
    : Math.max(0, Math.floor(params.maxRevisionCalls));
  const maxReviewIterations = Math.min(configuredReviewIterations, configuredRevisionCalls);
  params.logStage({ zh: "审计草稿", en: "auditing draft" });
  const initial = addInitialPostWriteIssues(await assess(finalContent));

  const snapshots: ReviewSnapshot[] = [{
    content: finalContent,
    wordCount: finalWordCount,
    auditResult: initial.auditResult,
    score: initial.score,
    lengthInRange: initial.lengthInRange,
    blockingCount: initial.blockingCount,
    criticalCount: initial.criticalCount,
    aiTellCount: initial.aiTellCount,
    revisionBlockingIssues: initial.revisionBlockingIssues,
  }];

  const buildReviewAttempts = (selected: ReviewSnapshot): ReadonlyArray<ChapterReviewAttempt> =>
    snapshots.map((snapshot, index) => ({
      stage: index === 0 ? "initial" : "revision",
      iteration: index,
      selected: snapshot === selected,
      score: snapshot.score,
      passed: !hasCriticalIssue(snapshot.auditResult.issues)
        && snapshot.score >= PASS_SCORE_THRESHOLD
        && snapshot.lengthInRange,
      wordCount: snapshot.wordCount,
      lengthInRange: snapshot.lengthInRange,
      blockingCount: snapshot.blockingCount,
      criticalCount: snapshot.criticalCount,
      aiTellCount: snapshot.aiTellCount,
      actionableIssues: snapshot.revisionBlockingIssues.filter((issue) => issue.severity !== "info"),
    }));

  let currentAudit = initial;
  let postReviseCount = 0;
  let terminationReason: ChapterReviewTerminationReason = isPassed(initial)
    ? "initial-passed"
    : "max-review-iterations";
  const buildReviewTelemetry = (): ChapterReviewTelemetry => ({
    terminationReason,
    auditCalls,
    revisionCalls,
    normalizationCalls,
    reviewedCandidates: snapshots.length,
    configuredMaxRevisions: maxReviewIterations,
  });

  if (initial.auditResult.parseFailed) {
    terminationReason = "audit-parse-failed";
    params.logWarn({
      zh: "审稿输出解析失败，跳过自动修稿以避免误改正文",
      en: "Audit output parsing failed; skipping automatic repair to avoid rewriting valid prose from an unreliable audit.",
    });
    return {
      finalContent,
      finalWordCount,
      preAuditNormalizedWordCount,
      revised: false,
      auditResult: initial.auditResult,
      totalUsage,
      postReviseCount,
      normalizeApplied,
      reviewAttempts: buildReviewAttempts(snapshots[0]!),
      reviewTelemetry: buildReviewTelemetry(),
    };
  }

  if (!isPassed(initial)) {
    for (let iteration = 0; iteration < maxReviewIterations; iteration++) {
      const actionableIssues = currentAudit.revisionBlockingIssues.filter(
        (issue) => issue.severity !== "info",
      );
      if (actionableIssues.length === 0) {
        terminationReason = "no-actionable-issues";
        params.logWarn({
          zh: "审计未通过但没有可执行修复项，跳过自动修稿",
          en: "Audit did not pass but exposed no actionable repair issues; skipping automatic revision.",
        });
        break;
      }

      params.logStage({
        zh: `修复轮次 ${iteration + 1}/${maxReviewIterations}（当前 ${currentAudit.score} 分）`,
        en: `repair iteration ${iteration + 1}/${maxReviewIterations} (current score: ${currentAudit.score})`,
      });

      const reviser = params.createReviser();
      revisionCalls += 1;
      const reviseOutput = await reviser.reviseChapter(
        params.bookDir,
        finalContent,
        params.chapterNumber,
        actionableIssues,
        "auto",
        params.book.genre,
        { ...params.reducedControlInput, lengthSpec: params.lengthSpec },
      );
      totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);

      if (reviseOutput.revisedContent.length === 0 || reviseOutput.revisedContent === finalContent) {
        terminationReason = "revision-unchanged";
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 未产出新内容，退出循环`,
          en: `repair iteration ${iteration + 1} produced no new content, exiting loop`,
        });
        break;
      }

      params.assertChapterContentNotEmpty(reviseOutput.revisedContent, `repair iteration ${iteration + 1}`);
      const normalizedRevision = await normalizeIfHardDrift(reviseOutput.revisedContent);
      normalizeApplied = normalizeApplied || normalizedRevision.applied;
      const revisedContent = params.normalizePostWriteSurface?.(normalizedRevision.content) ?? normalizedRevision.content;
      const revisedWordCount = countChapterLength(revisedContent, params.lengthSpec.countingMode);

      if (revisedContent === finalContent) {
        terminationReason = "normalized-revision-unchanged";
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 经长度/表面归一化后与当前正文相同，跳过重复审计`,
          en: `repair iteration ${iteration + 1} normalized back to the current chapter; skipping duplicate audit`,
        });
        break;
      }
      if (snapshots.some((snapshot) => snapshot.content === revisedContent)) {
        terminationReason = "revision-cycle-detected";
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 回到了已审版本，跳过重复审计并退出循环`,
          en: `repair iteration ${iteration + 1} returned to an already reviewed version; skipping duplicate audit and exiting`,
        });
        break;
      }

      // Every repair is normalized before re-audit so a structural fix is not
      // discarded solely because the reviser drifted outside hard bounds.
      let nextAssessment = await assess(revisedContent, {
        temperature: 0,
        ...(reviseOutput.changeKind === "patch" ? { verificationIssues: actionableIssues } : {}),
      });
      if (
        !nextAssessment.auditResult.passed
        && nextAssessment.auditResult.issues.length === 0
        && currentAudit.auditResult.issues.length > 0
      ) {
        nextAssessment = {
          ...nextAssessment,
          auditResult: {
            ...nextAssessment.auditResult,
            issues: currentAudit.auditResult.issues,
            summary: nextAssessment.auditResult.summary || currentAudit.auditResult.summary,
          },
          aiTellCount: currentAudit.aiTellCount,
          blockingCount: currentAudit.blockingCount,
          criticalCount: currentAudit.criticalCount,
          revisionBlockingIssues: currentAudit.revisionBlockingIssues,
        };
      }

      snapshots.push({
        content: revisedContent,
        wordCount: revisedWordCount,
        auditResult: nextAssessment.auditResult,
        score: nextAssessment.score,
        lengthInRange: nextAssessment.lengthInRange,
        blockingCount: nextAssessment.blockingCount,
        criticalCount: nextAssessment.criticalCount,
        aiTellCount: nextAssessment.aiTellCount,
        revisionBlockingIssues: nextAssessment.revisionBlockingIssues,
      });

      // Check if passed
      if (isPassed(nextAssessment)) {
        terminationReason = "passed-after-revision";
        params.logStage({
          zh: `修复后达到通过线（${nextAssessment.score} 分），退出循环`,
          en: `repair reached pass threshold (${nextAssessment.score}), exiting loop`,
        });
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        break;
      }

      // Continue when actionable issues improved even if the model's numeric
      // score did not move.
      const issueSetUnchanged = actionableIssueFingerprint(currentAudit)
        === actionableIssueFingerprint(nextAssessment);
      const countImproved = nextAssessment.criticalCount < currentAudit.criticalCount
        || nextAssessment.blockingCount < currentAudit.blockingCount
        || nextAssessment.aiTellCount < currentAudit.aiTellCount;
      if (issueSetUnchanged && !countImproved) {
        terminationReason = "issue-set-unchanged";
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 的可执行问题集合未变化，忽略随机分数波动并退出循环`,
          en: `repair iteration ${iteration + 1} left the actionable issue set unchanged; ignoring score noise and exiting`,
        });
        break;
      }
      if (hasMeaningfulProgress(currentAudit, nextAssessment)) {
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        // Continue to next iteration
      } else {
        terminationReason = "no-material-progress";
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 未净提升（分数 ${currentAudit.score} → ${nextAssessment.score}，critical ${currentAudit.criticalCount} → ${nextAssessment.criticalCount}，blocking ${currentAudit.blockingCount} → ${nextAssessment.blockingCount}），退出循环`,
          en: `repair iteration ${iteration + 1} no net improvement (score ${currentAudit.score} → ${nextAssessment.score}, critical ${currentAudit.criticalCount} → ${nextAssessment.criticalCount}, blocking ${currentAudit.blockingCount} → ${nextAssessment.blockingCount}), exiting loop`,
        });
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pick the best scoring snapshot for final output
  // ---------------------------------------------------------------------------
  const bestSnapshot = snapshots.reduce((best, snap) => {
    if (snap.lengthInRange !== best.lengthInRange) return snap.lengthInRange ? snap : best;
    if (snap.criticalCount !== best.criticalCount) {
      return snap.criticalCount < best.criticalCount ? snap : best;
    }
    if (snap.blockingCount !== best.blockingCount) {
      return snap.blockingCount < best.blockingCount ? snap : best;
    }
    return snap.score > best.score ? snap : best;
  });

  // If best snapshot differs from current content (repair made things worse
  // but an earlier version was better), roll back to the best version.
  if (bestSnapshot.content !== finalContent) {
    params.logWarn({
      zh: `回退到质量门禁排序更优版本（分数 ${bestSnapshot.score}，critical ${bestSnapshot.criticalCount}，blocking ${bestSnapshot.blockingCount}）`,
      en: `rolling back to the best quality-gate snapshot (score ${bestSnapshot.score}, critical ${bestSnapshot.criticalCount}, blocking ${bestSnapshot.blockingCount})`,
    });
    finalContent = bestSnapshot.content;
    finalWordCount = bestSnapshot.wordCount;
    postReviseCount = bestSnapshot.content === params.initialOutput.content ? 0 : bestSnapshot.wordCount;
    currentAudit = {
      auditResult: bestSnapshot.auditResult,
      score: bestSnapshot.score,
      lengthInRange: bestSnapshot.lengthInRange,
      blockingCount: bestSnapshot.blockingCount,
      criticalCount: bestSnapshot.criticalCount,
      aiTellCount: bestSnapshot.aiTellCount,
      revisionBlockingIssues: bestSnapshot.revisionBlockingIssues,
    };
  }

  return {
    finalContent,
    finalWordCount,
    preAuditNormalizedWordCount,
    revised: snapshots.length > 1 && finalContent !== params.initialOutput.content,
    auditResult: currentAudit.auditResult,
    totalUsage,
    postReviseCount,
    normalizeApplied,
    reviewAttempts: buildReviewAttempts(bestSnapshot),
    reviewTelemetry: buildReviewTelemetry(),
  };
}

function normalizeFingerprintText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

function deduplicateIssues(issues: ReadonlyArray<AuditIssue>): AuditIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = [
      issue.severity,
      normalizeFingerprintText(issue.category),
      normalizeFingerprintText(issue.description),
      issue.repairScope ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
