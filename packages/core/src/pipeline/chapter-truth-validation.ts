import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import {
  applyBlockingStateWarningPolicy,
  type StateValidationAuthorityContext,
  type ValidationResult,
  type StateValidatorAgent,
} from "../agents/state-validator.js";
import type { WriteChapterOutput, WriterAgent } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { Logger } from "../utils/logger.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import {
  buildStateDegradedIssues,
  buildStateDegradedPersistenceOutput,
  retrySettlementAfterValidationFailure,
} from "./chapter-state-recovery.js";

export async function validateChapterTruthPersistence(params: {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly persistenceOutput: WriteChapterOutput;
  readonly auditResult: AuditResult;
  readonly previousTruth: {
    readonly oldState: string;
    readonly oldHooks: string;
    readonly oldLedger: string;
  };
  readonly authorityContext?: StateValidationAuthorityContext;
  readonly reducedControlInput?: {
    chapterIntent: string;
    contextPackage: ContextPackage;
    ruleStack: RuleStack;
  };
  readonly language: LengthLanguage;
  readonly maxSettlementCalls?: number;
  readonly recoverAfterSettlementLimit?: (
    validation: ValidationResult,
  ) => Promise<{
    readonly output: WriteChapterOutput;
    readonly validation: ValidationResult;
  }>;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
}): Promise<{
  readonly validation: ValidationResult;
  readonly chapterStatus: "state-degraded" | null;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly persistenceOutput: WriteChapterOutput;
  readonly auditResult: AuditResult;
}> {
  let validation: ValidationResult;
  let chapterStatus: "state-degraded" | null = null;
  let degradedIssues: ReadonlyArray<AuditIssue> = [];
  let persistenceOutput = params.persistenceOutput;
  let auditResult = params.auditResult;

  try {
    validation = applyBlockingStateWarningPolicy(await params.validator.validate(
      params.content,
      params.chapterNumber,
      params.previousTruth.oldState,
      persistenceOutput.updatedState,
      params.previousTruth.oldHooks,
      persistenceOutput.updatedHooks,
      params.language,
      params.authorityContext,
    ));
  } catch (error) {
    params.logger?.warn(`State validation error for chapter ${params.chapterNumber}: ${String(error)}`);
    const errorDescription = params.language === "en"
      ? `State validation unavailable: ${String(error)}`
      : `状态校验不可用：${String(error)}`;
    const errorIssue: AuditIssue = {
      severity: "warning",
      category: "state-validation",
      description: errorDescription,
      suggestion: params.language === "en"
        ? "Repair chapter state from the persisted body before continuing."
        : "请先基于已保存正文修复本章 state，再继续后续章节。",
    };
    return {
      validation: { passed: true, warnings: [] },
      chapterStatus: "state-degraded",
      degradedIssues: [errorIssue],
      persistenceOutput: buildStateDegradedPersistenceOutput({
        output: persistenceOutput,
        oldState: params.previousTruth.oldState,
        oldHooks: params.previousTruth.oldHooks,
        oldLedger: params.previousTruth.oldLedger,
      }),
      auditResult: {
        ...params.auditResult,
        issues: [...params.auditResult.issues, errorIssue],
      },
    };
  }

  if (validation.warnings.length > 0) {
    params.logWarn({
      zh: `状态校验：第${params.chapterNumber}章发现 ${validation.warnings.length} 条警告`,
      en: `State validation: ${validation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
    });
    for (const warning of validation.warnings) {
      params.logger?.warn(`  [${warning.category}] ${warning.description}`);
    }
  }

  if (!validation.passed) {
    const settlementRetryAllowed = params.maxSettlementCalls === undefined
      || params.maxSettlementCalls > 1;
    if (!settlementRetryAllowed && params.recoverAfterSettlementLimit) {
      params.logWarn({
        zh: `第${params.chapterNumber}章结算调用已达到上限，跳过 Settler 重试并改用章节分析器`,
        en: `Chapter ${params.chapterNumber} reached its settlement call limit; skipping the Settler retry and using the chapter analyzer`,
      });
      try {
        const recovered = await params.recoverAfterSettlementLimit(validation);
        persistenceOutput = recovered.output;
        validation = recovered.validation;
      } catch (error) {
        params.logger?.warn(
          `Chapter analyzer recovery failed for chapter ${params.chapterNumber}: ${String(error)}`,
        );
      }
    } else {
      const recovery = settlementRetryAllowed
        ? await retrySettlementAfterValidationFailure({
          writer: params.writer,
          validator: params.validator,
          book: params.book,
          bookDir: params.bookDir,
          chapterNumber: params.chapterNumber,
          title: params.title,
          content: params.content,
          reducedControlInput: params.reducedControlInput,
          oldState: params.previousTruth.oldState,
          oldHooks: params.previousTruth.oldHooks,
          originalValidation: validation,
          language: params.language,
          logWarn: params.logWarn,
          logger: params.logger,
        })
        : {
          kind: "degraded" as const,
          issues: buildStateDegradedIssues(validation.warnings, params.language),
        };

      if (recovery.kind === "recovered") {
        persistenceOutput = recovery.output;
        validation = recovery.validation;
      } else {
        degradedIssues = recovery.issues;
      }
    }

    if (!validation.passed) {
      chapterStatus = "state-degraded";
      if (degradedIssues.length === 0) {
        degradedIssues = buildStateDegradedIssues(validation.warnings, params.language);
      }
      persistenceOutput = buildStateDegradedPersistenceOutput({
        output: persistenceOutput,
        oldState: params.previousTruth.oldState,
        oldHooks: params.previousTruth.oldHooks,
        oldLedger: params.previousTruth.oldLedger,
      });
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, ...degradedIssues],
      };
    }
  }

  return {
    validation,
    chapterStatus,
    degradedIssues,
    persistenceOutput,
    auditResult,
  };
}
