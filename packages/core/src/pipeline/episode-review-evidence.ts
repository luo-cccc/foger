import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AuditIssue } from "../agents/continuity.js";

export type EpisodeReviewStatus = "PROVISIONAL" | "REVISE";
export type EpisodeReviewFindingStatus = "open" | "fixed" | "stale";

export interface EpisodeReviewFinding {
  readonly id: string;
  readonly severity: "critical" | "warning" | "note";
  readonly ruleClass:
    | "structural_invariant"
    | "reviewed_invariant"
    | "craft_default"
    | "taste_option";
  readonly description: string;
  readonly suggestion: string;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly owner: string;
  readonly status: EpisodeReviewFindingStatus;
}

export interface EpisodeReviewEvidence {
  readonly mode: "evidence";
  readonly independent: false;
  readonly status: EpisodeReviewStatus;
  readonly reviewedArtifacts: ReadonlyArray<{ readonly artifact: string; readonly sha256: string }>;
  readonly findings: ReadonlyArray<EpisodeReviewFinding>;
}

export const EpisodeReviewEvidenceSchema = z.object({
  mode: z.literal("evidence"),
  independent: z.literal(false),
  status: z.enum(["PROVISIONAL", "REVISE"]),
  reviewedArtifacts: z.array(z.object({
    artifact: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })),
  findings: z.array(z.object({
    id: z.string().min(1),
    severity: z.enum(["critical", "warning", "note"]),
    ruleClass: z.enum(["structural_invariant", "reviewed_invariant", "craft_default", "taste_option"]),
    description: z.string(),
    suggestion: z.string(),
    evidenceRefs: z.array(z.string()),
    owner: z.string().min(1),
    status: z.enum(["open", "fixed", "stale"]),
  })),
});

function issueRuleClass(issue: AuditIssue): EpisodeReviewFinding["ruleClass"] {
  return issue.ruleClass ?? (issue.severity === "critical" ? "structural_invariant" : "craft_default");
}

function issueSeverity(issue: AuditIssue): EpisodeReviewFinding["severity"] {
  if (issue.severity === "critical") return "critical";
  if (issue.severity === "warning") return "warning";
  return "note";
}

export function hashEpisodeArtifact(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildEpisodeReviewEvidence(params: {
  readonly artifact: string;
  readonly content: string;
  readonly issues: ReadonlyArray<AuditIssue>;
}): EpisodeReviewEvidence {
  const findings = params.issues.map((issue, index) => ({
    id: `EP-${String(index + 1).padStart(3, "0")}-${issue.category}`,
    severity: issueSeverity(issue),
    ruleClass: issueRuleClass(issue),
    description: issue.description,
    suggestion: issue.suggestion ?? "",
    evidenceRefs: issue.evidenceRefs ?? [],
    owner: "short-drama-write",
    status: "open" as const,
  }));
  return {
    mode: "evidence",
    independent: false,
    status: params.issues.some((issue) => issue.severity === "critical") ? "REVISE" : "PROVISIONAL",
    reviewedArtifacts: [{ artifact: params.artifact, sha256: hashEpisodeArtifact(params.content) }],
    findings,
  };
}

export function markEpisodeReviewEvidenceStale(
  evidence: EpisodeReviewEvidence,
  currentContent: string,
): EpisodeReviewEvidence {
  const artifact = evidence.reviewedArtifacts[0];
  if (!artifact || artifact.sha256 === hashEpisodeArtifact(currentContent)) return evidence;
  return {
    ...evidence,
    status: "REVISE",
    findings: evidence.findings.map((finding) => ({ ...finding, status: "stale" })),
  };
}

export async function loadEpisodeReviewEvidence(params: {
  readonly bookDir: string;
  readonly episode: number;
  readonly currentContent: string;
}): Promise<EpisodeReviewEvidence | undefined> {
  const reviewPath = join(
    params.bookDir,
    "episodes",
    `${String(params.episode).padStart(4, "0")}_review.json`,
  );
  const evidence = await readFile(reviewPath, "utf8")
    .then((raw) => EpisodeReviewEvidenceSchema.parse(JSON.parse(raw)))
    .catch(() => undefined);
  if (!evidence) return undefined;
  const refreshed = markEpisodeReviewEvidenceStale(evidence, params.currentContent);
  if (refreshed !== evidence) {
    await writeFile(reviewPath, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");
  }
  return refreshed;
}
