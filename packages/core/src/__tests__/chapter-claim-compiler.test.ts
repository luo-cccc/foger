import { describe, expect, it } from "vitest";
import {
  compileChapterClaims,
  renderClaimBrief,
  saveChapterClaimArtifacts,
  type ChapterClaimContext,
} from "../utils/chapter-claim-compiler.js";
import type { CanonClaim } from "../models/canon.js";

function claim(overrides: Partial<CanonClaim> & Pick<CanonClaim, "id">): CanonClaim {
  return {
    domain: "world",
    claimType: "objective_rule",
    content: "一个客观规则。",
    scope: { appliesTo: ["all"] },
    authority: { source: "story_frame", priority: "hard" },
    visibility: { characterKnownBy: [], hiddenFrom: [] },
    constraints: { requiresCost: [], forbiddenUses: [] },
    ...overrides,
  };
}

const SECRET_BEFORE_CH30 = claim({
  id: "s-1",
  claimType: "secret_truth",
  content: "宗门高层早已知道真相。",
  visibility: { readerKnownFrom: 30, characterKnownBy: ["宗主"], hiddenFrom: ["主角"] },
});

const PROTAGONIST_EXCEPTION = claim({
  id: "p-1",
  domain: "protagonist",
  claimType: "character_exception",
  content: "主角能听到器物低语。",
  scope: { appliesTo: ["主角"] },
  authority: { source: "roles/主角", priority: "strong" },
  constraints: { nonGeneralizable: true, requiresCost: [], forbiddenUses: ["不得给配角"] },
});

const COST_CLAIM = claim({
  id: "c-1",
  domain: "power",
  claimType: "objective_rule",
  content: "施法消耗寿元。",
  constraints: { requiresCost: ["寿元"], forbiddenUses: [] },
});

describe("compileChapterClaims", () => {
  it("hides a secret_truth not yet revealed to the reader", () => {
    const ctx: ChapterClaimContext = { chapterNumber: 10 };
    const compiled = compileChapterClaims([SECRET_BEFORE_CH30], ctx);
    expect(compiled.usable).toHaveLength(0);
    expect(compiled.mustHide.map((c) => c.id)).toContain("s-1");
  });

  it("reveals a secret_truth once readerKnownFrom is reached", () => {
    const ctx: ChapterClaimContext = { chapterNumber: 30 };
    const compiled = compileChapterClaims([SECRET_BEFORE_CH30], ctx);
    expect(compiled.usable.map((c) => c.id)).toContain("s-1");
  });

  it("treats previously revealed claims as reader-visible before their static chapter threshold", () => {
    const ctx: ChapterClaimContext = { chapterNumber: 10, revealedClaimIds: ["s-1"] };
    const compiled = compileChapterClaims([SECRET_BEFORE_CH30], ctx);
    expect(compiled.usable.map((c) => c.id)).toContain("s-1");
    expect(compiled.mustHide.map((c) => c.id)).not.toContain("s-1");
  });

  it("keeps a protagonist exception in noGeneralize and never leaks it to other POVs", () => {
    const ctx: ChapterClaimContext = { chapterNumber: 5, pov: "配角A" };
    const compiled = compileChapterClaims([PROTAGONIST_EXCEPTION], ctx);
    // protagonist-only scope means it is out of scope for a different POV.
    expect(compiled.usable).toHaveLength(0);
    expect(compiled.mustHide.map((c) => c.id)).toContain("p-1");
  });

  it("includes a protagonist exception when POV is the protagonist", () => {
    const ctx: ChapterClaimContext = { chapterNumber: 5, pov: "主角" };
    const compiled = compileChapterClaims([PROTAGONIST_EXCEPTION], ctx);
    expect(compiled.usable.map((c) => c.id)).toContain("p-1");
    expect(compiled.noGeneralize.map((c) => c.id)).toContain("p-1");
    expect(compiled.costRequired).toHaveLength(0);
  });

  it("flags cost-required claims separately", () => {
    const ctx: ChapterClaimContext = { chapterNumber: 5 };
    const compiled = compileChapterClaims([COST_CLAIM], ctx);
    expect(compiled.costRequired.map((c) => c.id)).toContain("c-1");
  });

  it("surfaces a hidden claim when the memo names it for revelation", () => {
    const ctx: ChapterClaimContext = { chapterNumber: 10, memo: "本章揭晓 s-1 宗门真相" };
    const compiled = compileChapterClaims([SECRET_BEFORE_CH30], ctx);
    expect(compiled.usable.map((c) => c.id)).toContain("s-1");
    expect(compiled.revealNow.map((c) => c.id)).toContain("s-1");
    expect(compiled.mustHide.map((c) => c.id)).not.toContain("s-1");
  });

  it("surfaces a hidden claim committed via paraphrase reveal intent in the memo", () => {
    const ctx: ChapterClaimContext = {
      chapterNumber: 10,
      memo: "本章要揭示七号门背后的真相，让主角终于得知高层知情。",
    };
    const compiled = compileChapterClaims([SECRET_BEFORE_CH30], ctx);
    expect(compiled.revealNow.map((c) => c.id)).toContain("s-1");
    expect(compiled.mustHide.map((c) => c.id)).not.toContain("s-1");
  });

  it("does not force a reveal when the memo only mentions the subject without a reveal cue", () => {
    const ctx: ChapterClaimContext = {
      chapterNumber: 10,
      memo: "主角仍在猜七号门真相，但本章只是铺垫。",
    };
    const compiled = compileChapterClaims([SECRET_BEFORE_CH30], ctx);
    expect(compiled.revealNow.map((c) => c.id)).toEqual([]);
  });

  it("respects an explicit deferral and keeps the claim hidden", () => {
    const ctx: ChapterClaimContext = {
      chapterNumber: 10,
      memo: "本章暂不揭示七号门真相，保留悬念。",
    };
    const compiled = compileChapterClaims([SECRET_BEFORE_CH30], ctx);
    expect(compiled.revealNow.map((c) => c.id)).toEqual([]);
    expect(compiled.mustHide.map((c) => c.id)).toContain("s-1");
  });

  it("records conflict resolution edges", () => {
    const a = claim({ id: "w-a", relations: { conflictsWith: ["w-b"], resolvesBy: "w-b 优先" } });
    const b = claim({ id: "w-b" });
    const ctx: ChapterClaimContext = { chapterNumber: 5 };
    const compiled = compileChapterClaims([a, b], ctx);
    expect(compiled.conflictResolve).toEqual([
      expect.objectContaining({ resolvesBy: "w-b 优先" }),
    ]);
  });
});

describe("renderClaimBrief", () => {
  it("renders sections with usable / mustHide / noGeneralize", () => {
    const ctx: ChapterClaimContext = { chapterNumber: 5, pov: "主角" };
    const compiled = compileChapterClaims([PROTAGONIST_EXCEPTION, SECRET_BEFORE_CH30], ctx);
    const brief = renderClaimBrief(compiled, ctx);
    expect(brief).toContain("本章可用设定");
    expect(brief).toContain("不可泛化");
    expect(brief).toContain("必须隐藏");
    expect(brief).toContain("[p-1]");
    expect(brief).toContain("主角能听到器物低语");
  });
});

describe("saveChapterClaimArtifacts", () => {
  it("writes claims.json and claim-brief.md", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-claims-"));
    try {
      const ctx: ChapterClaimContext = { chapterNumber: 5, pov: "主角" };
      const compiled = compileChapterClaims([PROTAGONIST_EXCEPTION], ctx);
      const paths = await saveChapterClaimArtifacts(tmp, compiled, ctx);
      expect(fs.existsSync(paths.claimsPath)).toBe(true);
      expect(fs.existsSync(paths.briefPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(paths.claimsPath, "utf-8"));
      expect(written.usable[0].id).toBe("p-1");
      expect(written.revealNow).toEqual([]);
      expect(written.noGeneralize[0].id).toBe("p-1");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
