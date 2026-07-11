import { describe, expect, it } from "vitest";
import { isProtectedContextSource } from "../utils/context-assembly.js";

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
const GOVERNANCE_RUNTIME_SOURCES = [
  "runtime/chapter_memo",
  "runtime/chapter_claim_brief",
  "runtime/canon_validator",
  "runtime/pre_write_claim_gate",
  "runtime/current_arc",
  "runtime/volume_contract",
  "runtime/volume_progress",
  "runtime/volume_gate",
] as const;

// Derived/summary sources that are intentionally compressible — recent titles,
// mood trail, and endings are best-effort context, not hard constraints.
const COMPRESSIBLE_DERIVED_SOURCES = [
  "story/chapter_summaries.md#recent_titles",
  "story/chapter_summaries.md#recent_mood_type_trail",
  "story/chapters#recent_endings",
] as const;

describe("isProtectedContextSource contract", () => {
  it("protects every governance runtime source", () => {
    for (const source of GOVERNANCE_RUNTIME_SOURCES) {
      expect(isProtectedContextSource(source), `${source} must be protected`).toBe(true);
    }
  });

  it("keeps derived summary sources compressible", () => {
    for (const source of COMPRESSIBLE_DERIVED_SOURCES) {
      expect(isProtectedContextSource(source), `${source} must stay compressible`).toBe(false);
    }
  });

  it("protects the hook-debt prefix variant", () => {
    expect(isProtectedContextSource("runtime/hook_debt#H001")).toBe(true);
  });

  it("does not protect unknown sources by default", () => {
    expect(isProtectedContextSource("runtime/something_new")).toBe(false);
    expect(isProtectedContextSource("story/random_note.md")).toBe(false);
  });
});
