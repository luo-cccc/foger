import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import {
  applyBlockingStateWarningPolicy,
  type StateValidationAuthorityContext,
  type ValidationResult,
  type StateValidatorAgent,
} from "../agents/state-validator.js";
import type { WriteEpisodeOutput, WriterAgent } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { Logger } from "../utils/logger.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import {
  buildStateDegradedIssues,
  buildStateDegradedPersistenceOutput,
  replayEpisodeStateAfterValidationFailure,
} from "./episode-state-recovery.js";
import type { EpisodeContextSnapshot } from "./episode-context.js";

export async function validateEpisodeTruthPersistence(params: {
  readonly writer: Pick<WriterAgent, "replayEpisodeState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly episodeNumber: number;
  readonly title: string;
  readonly content: string;
  readonly persistenceOutput: WriteEpisodeOutput;
  readonly episodeContextSnapshot: EpisodeContextSnapshot;
  readonly auditResult: AuditResult;
  readonly previousTruth: {
    readonly oldState: string;
    readonly oldHooks: string;
    readonly oldLedger: string;
  };
  readonly authorityContext?: StateValidationAuthorityContext;
  readonly reducedControlInput?: {
    episodeIntent: string;
    contextPackage: ContextPackage;
    ruleStack: RuleStack;
  };
  readonly language: LengthLanguage;
  readonly maxSettlementCalls?: number;
  readonly recoverAfterSettlementLimit?: (
    validation: ValidationResult,
  ) => Promise<{
    readonly output: WriteEpisodeOutput;
    readonly validation: ValidationResult;
  }>;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
}): Promise<{
  readonly validation: ValidationResult;
  readonly episodeStatus: "state-degraded" | null;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly persistenceOutput: WriteEpisodeOutput;
  readonly auditResult: AuditResult;
}> {
  let validation: ValidationResult;
  let episodeStatus: "state-degraded" | null = null;
  let degradedIssues: ReadonlyArray<AuditIssue> = [];
  let persistenceOutput = params.persistenceOutput;
  let auditResult = params.auditResult;

  // EpisodeScript is the authoritative structured source. Its state and
  // summary projections are produced by the deterministic episode reducer;
  // avoid spending another model call re-describing the same JSON. If the
  // reducer did not produce usable projections, fall through to the normal
  // validator/recovery path.
  const hasUsableDeterministicProjection = Boolean(
    persistenceOutput.episodeScript
    && persistenceOutput.runtimeStateDelta,
  );
  if (hasUsableDeterministicProjection) {
    return {
      validation: { passed: true, warnings: [] },
      episodeStatus: null,
      degradedIssues: [],
      persistenceOutput,
      auditResult,
    };
  }

  try {
    validation = applyBlockingStateWarningPolicy(await params.validator.validate(
      params.content,
      params.episodeNumber,
      params.previousTruth.oldState,
      persistenceOutput.updatedState,
      params.previousTruth.oldHooks,
      persistenceOutput.updatedHooks,
      params.language,
      params.authorityContext,
    ));
  } catch (error) {
    params.logger?.warn(`State validation error for episode ${params.episodeNumber}: ${String(error)}`);
    const errorDescription = params.language === "en"
      ? `State validation unavailable: ${String(error)}`
      : `状态校验不可用：${String(error)}`;
    const errorIssue: AuditIssue = {
      severity: "warning",
      category: "state-validation",
      description: errorDescription,
      suggestion: params.language === "en"
        ? "Repair episode state from the persisted body before continuing."
        : "请先基于已保存剧本修复本集 state，再继续后续剧集。",
    };
    return {
      validation: { passed: true, warnings: [] },
      episodeStatus: "state-degraded",
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
      zh: `状态校验：第${params.episodeNumber}集发现 ${validation.warnings.length} 条警告`,
      en: `State validation: ${validation.warnings.length} warning(s) for episode ${params.episodeNumber}`,
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
      zh: `第${params.episodeNumber}集状态投影已达到重试上限，拒绝使用旧分析器兜底`,
        en: `Episode ${params.episodeNumber} reached its state projection retry limit; deterministic replay will decide whether recovery is possible`,
      });
      try {
        const recovered = await params.recoverAfterSettlementLimit(validation);
        persistenceOutput = recovered.output;
        validation = recovered.validation;
      } catch (error) {
        params.logger?.warn(
          `Deterministic replay recovery failed for episode ${params.episodeNumber}: ${String(error)}`,
        );
      }
    } else {
      const recovery = settlementRetryAllowed
        ? await replayEpisodeStateAfterValidationFailure({
          writer: params.writer,
          validator: params.validator,
          book: params.book,
          bookDir: params.bookDir,
          episodeNumber: params.episodeNumber,
          title: params.title,
          content: params.content,
          episodeContextSnapshot: params.episodeContextSnapshot,
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
      episodeStatus = "state-degraded";
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
    episodeStatus,
    degradedIssues,
    persistenceOutput,
    auditResult,
  };
}
