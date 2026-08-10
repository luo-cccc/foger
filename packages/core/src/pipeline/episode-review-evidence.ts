import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AuditIssue } from "../agents/continuity.js";
import { EPISODE_DURATION_TARGET_SECONDS, EpisodeScriptSchema } from "../models/episode-script.js";
import { buildSettingsEntityIndex } from "../state/settings-index.js";
import { auditEpisodeScript } from "./episode-quality-gate.js";

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
  /**
   * Provenance borrowed from the drama-skills review contract: the write
   * pipeline is a self-check and can only produce PROVISIONAL evidence.
   * Final approval requires an independent reviewer context; recording the
   * requested/effective mode keeps that distinction auditable.
   */
  readonly requestedReviewMode: "self_check" | "unattested" | "independent_agent";
  readonly effectiveReviewMode: "self_check" | "unattested" | "independent_agent";
  readonly reviewer: {
    readonly owner: string;
    readonly kind: "self_check" | "unattested" | "independent_agent";
    readonly independence: boolean;
    readonly excludedSourceOwner: string;
  };
  readonly reviewedArtifacts: ReadonlyArray<{ readonly artifact: string; readonly sha256: string }>;
  readonly findings: ReadonlyArray<EpisodeReviewFinding>;
}

export const EpisodeReviewEvidenceSchema = z.object({
  mode: z.literal("evidence"),
  independent: z.literal(false),
  status: z.enum(["PROVISIONAL", "REVISE"]),
  requestedReviewMode: z.enum(["self_check", "unattested", "independent_agent"]).default("self_check"),
  effectiveReviewMode: z.enum(["self_check", "unattested", "independent_agent"]).default("self_check"),
  reviewer: z.object({
    owner: z.string().min(1).default("pipeline"),
    kind: z.enum(["self_check", "unattested", "independent_agent"]).default("self_check"),
    independence: z.boolean().default(false),
    excludedSourceOwner: z.string().min(1).default("writer"),
  }).default({}),
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

// ---------------------------------------------------------------------------
// Finding owner routing (P0-2)
//
// Borrowed from the drama-skills review contract: every finding routes to the
// owner that can legitimately fix it, and the owner decides the disposition
// path — the writer reviser must never patch decisions owned upstream (the
// memo alignment contract forbids execution-layer edits to planner choices).
//
// Mapping is deliberately conservative: only deterministic categories whose
// fix is provably outside the screenplay are routed away from "writer";
// LLM-auditor free-text categories and ambiguous cases default to "writer"
// so the auto-repair loop keeps its current resilience (see the 20-episode
// zero-failure baseline).
// ---------------------------------------------------------------------------

export type AuditIssueOwner = "writer" | "planner" | "canon";

/**
 * Categories whose resolution belongs to the planner (hook-ledger decisions
 * originate in the episode memo). hook-state-contradiction fires on the hook
 * state ledger, which the writer cannot repair by editing the screenplay.
 */
const PLANNER_OWNED_CATEGORIES: ReadonlySet<string> = new Set([
  "hook-state-contradiction",
]);

/**
 * Reserved for future canon-conflict categories. Today no deterministic
 * category routes here: unknown-character-reference stays writer-owned
 * because the in-script fix (reuse a registered name) preserves the
 * pipeline's self-healing behavior.
 */
const CANON_OWNED_CATEGORIES: ReadonlySet<string> = new Set([]);

export function resolveAuditIssueOwner(issue: Pick<AuditIssue, "category">): AuditIssueOwner {
  const category = issue.category.trim().toLowerCase();
  if (PLANNER_OWNED_CATEGORIES.has(category)) return "planner";
  if (CANON_OWNED_CATEGORIES.has(category)) return "canon";
  return "writer";
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
    owner: resolveAuditIssueOwner(issue),
    status: "open" as const,
  }));
  return {
    mode: "evidence",
    independent: false,
    status: params.issues.some((issue) => issue.severity === "critical") ? "REVISE" : "PROVISIONAL",
    requestedReviewMode: "self_check",
    effectiveReviewMode: "self_check",
    reviewer: {
      owner: "pipeline",
      kind: "self_check",
      independence: false,
      excludedSourceOwner: "writer",
    },
    reviewedArtifacts: [{ artifact: params.artifact, sha256: hashEpisodeArtifact(params.content) }],
    findings,
  };
}

/**
 * Rebuild a missing review sidecar from the authoritative persisted episode
 * JSON. Review evidence is a derived artifact: the screenplay JSON is the
 * source of truth, so a lost review.json must never block continuity or
 * leave an episode with audit results but no evidence file. Existing files
 * are never overwritten — the write and audit paths may produce richer
 * evidence than this deterministic rebuild.
 */
export async function ensureEpisodeReviewSidecar(params: {
  readonly bookDir: string;
  readonly episode: number;
  readonly targetDurationSeconds?: number;
}): Promise<boolean> {
  if (params.episode < 1) return false;
  const episodesDir = join(params.bookDir, "episodes");
  const paddedNum = String(params.episode).padStart(4, "0");
  const prefix = `${paddedNum}_`;
  const reviewPath = join(episodesDir, `${paddedNum}_review.json`);
  if (await readFile(reviewPath, "utf8").then(() => true).catch(() => false)) {
    return false;
  }

  const files = await readdir(episodesDir).catch(() => []);
  const filename = files.find((file) =>
    file.startsWith(prefix) && file.endsWith(".json") && !file.endsWith("_review.json"),
  );
  if (!filename) return false;

  try {
    const sourceContent = await readFile(join(episodesDir, filename), "utf8");
    const script = EpisodeScriptSchema.parse(JSON.parse(sourceContent));
    const previousScript = params.episode > 1
      ? await loadEpisodeScriptForSidecar(params.bookDir, params.episode - 1)
      : undefined;
    const settingsIndex = await buildSettingsEntityIndex(params.bookDir, params.episode);
    const issues = auditEpisodeScript(
      script,
      previousScript,
      params.targetDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
      settingsIndex,
    );
    const evidence = buildEpisodeReviewEvidence({
      artifact: `episodes/${filename}`,
      content: sourceContent,
      issues,
    });
    await writeFile(reviewPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function loadEpisodeScriptForSidecar(
  bookDir: string,
  episode: number,
): Promise<ReturnType<typeof EpisodeScriptSchema.parse> | undefined> {
  if (episode < 1) return undefined;
  const episodesDir = join(bookDir, "episodes");
  const prefix = `${String(episode).padStart(4, "0")}_`;
  const files = await readdir(episodesDir).catch(() => []);
  const filename = files.find((file) =>
    file.startsWith(prefix) && file.endsWith(".json") && !file.endsWith("_review.json"),
  );
  if (!filename) return undefined;
  try {
    const content = await readFile(join(episodesDir, filename), "utf8");
    return EpisodeScriptSchema.parse(JSON.parse(content));
  } catch {
    return undefined;
  }
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
