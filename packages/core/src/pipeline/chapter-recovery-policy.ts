import { createHash } from "node:crypto";
import type { AuditIssue } from "../agents/continuity.js";
import type {
  ChapterMeta,
  ChapterRecoveryIssue,
  ChapterRecoveryState,
} from "../models/chapter.js";

export type ChapterRecoveryAction =
  | "repair-state"
  | "resync-state"
  | "revise"
  | "rewrite"
  | "pause";

export interface ChapterRecoveryAttemptCounts {
  readonly global?: Readonly<Record<string, number>>;
  readonly currentContent?: Readonly<Record<string, number>>;
}

export interface ChapterRecoveryDecision {
  readonly action: ChapterRecoveryAction;
  readonly reason: string;
}

export function fingerprintChapterContent(content: string): string {
  const normalized = content
    .replace(/^\uFEFF/u, "")
    .replace(/^#{1,6}[^\r\n]*\r?\n(?:\s*\r?\n)?/u, "")
    .replace(/\r\n/g, "\n")
    .trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24);
}

export function buildChapterRecoveryState(params: {
  readonly content: string;
  readonly issues: ReadonlyArray<AuditIssue>;
  readonly operationId?: string;
  readonly terminationReason?: string;
  readonly now?: () => string;
}): ChapterRecoveryState {
  return {
    version: 1,
    contentFingerprint: fingerprintChapterContent(params.content),
    blockingIssues: params.issues
      .filter((issue) => issue.severity !== "info")
      .map(toChapterRecoveryIssue),
    ...(params.operationId ? { sourceOperationId: params.operationId } : {}),
    ...(params.terminationReason ? { terminationReason: params.terminationReason } : {}),
    updatedAt: params.now?.() ?? new Date().toISOString(),
  };
}

export function auditIssuesFromChapterRecovery(
  chapter: Pick<ChapterMeta, "auditIssues" | "recoveryState">,
  currentContent?: string,
): AuditIssue[] {
  if (
    currentContent !== undefined
    && chapter.recoveryState
    && chapter.recoveryState.contentFingerprint !== fingerprintChapterContent(currentContent)
  ) {
    return [{
      severity: "critical",
      category: "recovery-evidence-stale",
      description: "The persisted audit evidence belongs to a different chapter body.",
      suggestion: "Re-audit the current chapter body before attempting another recovery mutation.",
      repairScope: "unknown",
    }];
  }

  if (chapter.recoveryState) {
    const structured = chapter.recoveryState.blockingIssues.map(toAuditIssue);
    if (structured.length > 0) return structured;
  }

  const legacy = chapter.auditIssues
    .map(parseLegacyAuditIssue)
    .filter((issue): issue is AuditIssue => issue !== null);
  if (legacy.length > 0) return legacy;

  return [{
    severity: "critical",
    category: "audit-evidence-missing",
    description: "The persisted audit-failed chapter has no structured blocking evidence.",
    suggestion: "Re-audit the current chapter body before attempting another recovery mutation.",
    repairScope: "unknown",
  }];
}

export function decideChapterRecovery(params: {
  readonly status: "state-degraded" | "audit-failed";
  readonly issues?: ReadonlyArray<Pick<AuditIssue, "severity" | "repairScope">>;
  readonly attempts?: ChapterRecoveryAttemptCounts;
}): ChapterRecoveryDecision {
  const global = params.attempts?.global ?? {};
  const currentContent = params.attempts?.currentContent ?? {};

  if (params.status === "state-degraded") {
    if ((currentContent["repair-state"] ?? 0) < 1) {
      return { action: "repair-state", reason: "State truth has not been repaired for the current chapter body." };
    }
    if ((currentContent["resync-state"] ?? 0) < 1) {
      return { action: "resync-state", reason: "State repair did not converge; resync the current chapter body once." };
    }
    return {
      action: "pause",
      reason: "State repair and resync were already attempted for the current chapter body.",
    };
  }

  const blocking = (params.issues ?? []).filter((issue) => issue.severity !== "info");
  const structural = blocking.some((issue) => issue.repairScope === "structural");
  if (structural) {
    if ((global.rewrite ?? 0) < 1) {
      return { action: "rewrite", reason: "A structural audit issue requires one bounded rewrite." };
    }
    return { action: "pause", reason: "The rewritten chapter still has structural audit issues." };
  }

  if ((global.revise ?? 0) < 1) {
    return { action: "revise", reason: "Attempt one evidence-based local revision." };
  }
  if ((global.rewrite ?? 0) < 1) {
    return { action: "rewrite", reason: "Revision did not converge; attempt one bounded rewrite." };
  }
  return { action: "pause", reason: "Revision and rewrite were already attempted for this chapter." };
}

function toChapterRecoveryIssue(issue: AuditIssue): ChapterRecoveryIssue {
  return {
    severity: issue.severity,
    category: issue.category,
    description: issue.description,
    suggestion: issue.suggestion,
    ...(issue.repairScope ? { repairScope: issue.repairScope } : {}),
  };
}

function toAuditIssue(issue: ChapterRecoveryIssue): AuditIssue {
  return {
    severity: issue.severity,
    category: issue.category,
    description: issue.description,
    suggestion: issue.suggestion,
    ...(issue.repairScope ? { repairScope: issue.repairScope } : {}),
  };
}

function parseLegacyAuditIssue(value: string): AuditIssue | null {
  const match = value.match(/^\[(critical|warning|info)\]\s*(.+)$/u);
  if (!match?.[1] || !match[2] || match[1] === "info") return null;
  return {
    severity: match[1] as "critical" | "warning",
    category: "persisted-audit",
    description: match[2].trim(),
    suggestion: "Re-audit the current chapter body before choosing another recovery action.",
    repairScope: "unknown",
  };
}
