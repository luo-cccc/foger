/**
 * Upstream revision feedback loop (P0-2, drama-skills review contract).
 *
 * When the review cycle stops at `requires-upstream-revision`, the remaining
 * blocking findings belong to planner/canon — the writer reviser has no
 * authority over them. Those findings must not die in a log line: they are
 * persisted here and injected into the next `inkos plan episode` call for the
 * same episode, so the planner repairs its own decisions (hook ledger, KR
 * binding, contract choices) in the memo itself.
 *
 * The file is consumed (deleted) once a new plan for that episode is
 * successfully created; if the problem persists, the next review cycle
 * re-records it.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AuditIssue } from "../agents/continuity.js";
import type { AuditIssueOwner } from "./episode-review-evidence.js";

export const UpstreamRevisionFindingSchema = z.object({
  category: z.string().min(1),
  owner: z.enum(["planner", "canon"]),
  severity: z.enum(["critical", "warning"]),
  description: z.string(),
  suggestion: z.string(),
});

export const UpstreamRevisionFeedbackSchema = z.object({
  version: z.literal(1),
  episode: z.number().int().min(1),
  recordedAt: z.string(),
  findings: z.array(UpstreamRevisionFindingSchema).min(1),
});

export type UpstreamRevisionFinding = z.infer<typeof UpstreamRevisionFindingSchema>;
export type UpstreamRevisionFeedback = z.infer<typeof UpstreamRevisionFeedbackSchema>;

function feedbackPath(bookDir: string): string {
  return join(bookDir, "story", "runtime", "upstream-revision-feedback.json");
}

export async function recordUpstreamRevisionFeedback(
  bookDir: string,
  episode: number,
  issues: ReadonlyArray<AuditIssue>,
  resolveOwner: (issue: Pick<AuditIssue, "category">) => AuditIssueOwner,
): Promise<UpstreamRevisionFeedback | undefined> {
  const findings = issues
    .filter((issue) => issue.severity === "critical" || issue.severity === "warning")
    .map((issue) => ({ issue, owner: resolveOwner(issue) }))
    .filter((entry) => entry.owner !== "writer")
    .map((entry) => ({
      category: entry.issue.category,
      owner: entry.owner as "planner" | "canon",
      severity: entry.issue.severity as "critical" | "warning",
      description: entry.issue.description,
      suggestion: entry.issue.suggestion ?? "",
    }));
  if (findings.length === 0) return undefined;

  const feedback: UpstreamRevisionFeedback = {
    version: 1,
    episode,
    recordedAt: new Date().toISOString(),
    findings,
  };
  const path = feedbackPath(bookDir);
  await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
  await writeFile(path, `${JSON.stringify(feedback, null, 2)}\n`, "utf8");
  return feedback;
}

/**
 * Load feedback recorded for `episode`. Feedback recorded for a different
 * episode is stale (the pipeline moved on) and is ignored.
 */
export async function loadUpstreamRevisionFeedback(
  bookDir: string,
  episode: number,
): Promise<UpstreamRevisionFeedback | undefined> {
  const raw = await readFile(feedbackPath(bookDir), "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const parsed = UpstreamRevisionFeedbackSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return undefined;
  return parsed.data.episode === episode ? parsed.data : undefined;
}

export async function clearUpstreamRevisionFeedback(bookDir: string): Promise<void> {
  await rm(feedbackPath(bookDir), { force: true });
}
