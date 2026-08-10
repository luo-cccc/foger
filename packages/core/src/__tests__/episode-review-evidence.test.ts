import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEpisodeReviewEvidence,
  ensureEpisodeReviewSidecar,
  hashEpisodeArtifact,
  resolveAuditIssueOwner,
} from "../pipeline/episode-review-evidence.js";
import { createEpisodeScript } from "./episode-test-fixtures.js";

describe("resolveAuditIssueOwner (P0-2)", () => {
  it("routes hook-ledger contradictions to the planner", () => {
    expect(resolveAuditIssueOwner({ category: "hook-state-contradiction" })).toBe("planner");
  });

  it("keeps screenplay-level and unknown categories writer-owned", () => {
    expect(resolveAuditIssueOwner({ category: "unknown-character-reference" })).toBe("writer");
    expect(resolveAuditIssueOwner({ category: "dialogue-length" })).toBe("writer");
    expect(resolveAuditIssueOwner({ category: "伏笔检查" })).toBe("writer");
  });

  it("stamps the routed owner on persisted findings", () => {
    const evidence = buildEpisodeReviewEvidence({
      artifact: "episodes/0001_archive.json",
      content: "content",
      issues: [
        { severity: "critical", category: "hook-state-contradiction", description: "d", suggestion: "s" },
        { severity: "warning", category: "dialogue-length", description: "d", suggestion: "s" },
      ],
    });
    expect(evidence.findings[0]?.owner).toBe("planner");
    expect(evidence.findings[1]?.owner).toBe("writer");
  });
});

async function seedEpisode(bookDir: string, episode: number): Promise<string> {
  const episodesDir = join(bookDir, "episodes");
  await mkdir(episodesDir, { recursive: true });
  const script = createEpisodeScript(episode);
  const content = `${JSON.stringify(script, null, 2)}\n`;
  await writeFile(
    join(episodesDir, `${String(episode).padStart(4, "0")}_archive.json`),
    content,
    "utf-8",
  );
  return content;
}

describe("ensureEpisodeReviewSidecar", () => {
  it("rebuilds a missing review sidecar from the authoritative episode JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-review-sidecar-"));
    try {
      const bookDir = join(root, "book");
      const content = await seedEpisode(bookDir, 1);

      const rebuilt = await ensureEpisodeReviewSidecar({ bookDir, episode: 1 });
      expect(rebuilt).toBe(true);

      const evidence = JSON.parse(
        await readFile(join(bookDir, "episodes", "0001_review.json"), "utf-8"),
      );
      expect(evidence.reviewedArtifacts).toHaveLength(1);
      expect(evidence.reviewedArtifacts[0].sha256).toBe(hashEpisodeArtifact(content));
      expect(evidence.status).toBe("PROVISIONAL");
      expect(evidence.requestedReviewMode).toBe("self_check");
      expect(evidence.effectiveReviewMode).toBe("self_check");
      expect(evidence.reviewer).toMatchObject({
        owner: "pipeline",
        kind: "self_check",
        independence: false,
        excludedSourceOwner: "writer",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing review sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-review-sidecar-"));
    try {
      const bookDir = join(root, "book");
      await seedEpisode(bookDir, 1);
      const reviewPath = join(bookDir, "episodes", "0001_review.json");
      await writeFile(reviewPath, "{ \"keep\": true }\n", "utf-8");

      const rebuilt = await ensureEpisodeReviewSidecar({ bookDir, episode: 1 });
      expect(rebuilt).toBe(false);
      await expect(readFile(reviewPath, "utf-8")).resolves.toContain("\"keep\": true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns false when no episode JSON exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-review-sidecar-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(join(bookDir, "episodes"), { recursive: true });
      await expect(ensureEpisodeReviewSidecar({ bookDir, episode: 1 })).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
