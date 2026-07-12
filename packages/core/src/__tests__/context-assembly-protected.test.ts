import { describe, expect, it } from "vitest";
import { getContextSourceTier, isProtectedContextSource } from "../utils/context-assembly.js";

/**
 * Contract guard for the protected context-source list.
 *
 * Governance runtime sources injected by the Composer carry "must be honored
 * before drafting" constraints and must never be compressed out under
 * context-budget pressure. This test pins that contract so a newly-injected
 * governance source that forgets to register in isProtectedContextSource fails
 * loudly (that omission is exactly how runtime/canon_validator was once missed).
 *
 * When adding a new `runtime/*` governance source, add it to BOTH
 * isProtectedContextSource and GOVERNANCE_RUNTIME_SOURCES below.
 */

// Every governance runtime source the Composer injects. Keep in sync with the
// `source: "runtime/..."` entries produced in agents/composer.ts.
const VERBATIM_RUNTIME_SOURCES = [
  "runtime/chapter_memo",
  "runtime/chapter_claim_brief",
  "runtime/canon_validator",
  "runtime/pre_write_claim_gate",
  "runtime/volume_gate",
] as const;

const SEMANTIC_RUNTIME_SOURCES = [
  "runtime/current_arc",
  "runtime/volume_contract",
  "runtime/volume_progress",
] as const;

// Derived/summary sources that are intentionally compressible — recent titles,
// mood trail, and endings are best-effort context, not hard constraints.
const COMPRESSIBLE_DERIVED_SOURCES = [
  "story/chapter_summaries.md#recent_titles",
  "story/chapter_summaries.md#recent_mood_type_trail",
  "story/chapters#recent_endings",
] as const;

describe("isProtectedContextSource contract", () => {
  it("keeps byte-sensitive governance sources verbatim", () => {
    for (const source of VERBATIM_RUNTIME_SOURCES) {
      expect(isProtectedContextSource(source), `${source} must be protected`).toBe(true);
      expect(getContextSourceTier(source)).toBe("verbatim");
    }
  });

  it("allows binding semantic sources to be compiled without making them optional", () => {
    for (const source of SEMANTIC_RUNTIME_SOURCES) {
      expect(isProtectedContextSource(source), `${source} must not require verbatim retention`).toBe(false);
      expect(getContextSourceTier(source)).toBe("semantic");
    }
  });

  it("keeps derived summary sources compressible", () => {
    for (const source of COMPRESSIBLE_DERIVED_SOURCES) {
      expect(isProtectedContextSource(source), `${source} must stay compressible`).toBe(false);
      expect(getContextSourceTier(source)).toBe("compressible");
    }
  });

  it("protects the hook-debt prefix variant", () => {
    expect(isProtectedContextSource("runtime/hook_debt#H001")).toBe(true);
  });

  it("treats selected state, hook, outline, and canon evidence as semantic", () => {
    for (const source of [
      "story/current_state.md#current-goal",
      "story/pending_hooks.md#H001",
      "story/outline/story_frame.md#world",
      "story/outline/volume_map.md#volume-1",
      "story/parent_canon.md",
    ]) {
      expect(getContextSourceTier(source)).toBe("semantic");
    }
  });

  it("does not protect unknown sources by default", () => {
    expect(isProtectedContextSource("runtime/something_new")).toBe(false);
    expect(isProtectedContextSource("story/random_note.md")).toBe(false);
  });
});
