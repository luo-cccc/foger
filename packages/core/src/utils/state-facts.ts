/**
 * Shared semantic helpers for structured state facts (handoff / incoming
 * buckets). Used by the deterministic quality gate and the tool diagnostics
 * so both layers agree on what "the previous fact is carried forward" means.
 */

export function normalizeFacts(facts: ReadonlyArray<string>): string[] {
  return facts.map((fact) => fact.trim()).filter(Boolean).sort();
}

/**
 * Is `expected` semantically present in `actualFacts`? Accepts exact
 * containment (either direction) or a term-overlap majority (>= 1/3 of
 * salient CJK/ASCII terms), so a paraphrase of a carried fact counts.
 */
export function factEquivalent(expected: string, actualFacts: ReadonlyArray<string>): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  if (!normalizedExpected) return true;
  return actualFacts.some((actual) => {
    const normalizedActual = actual.trim().toLowerCase();
    if (!normalizedActual) return false;
    if (normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual)) return true;
    const terms = normalizedExpected.match(/[\u3400-\u9fff]{2,}|[a-z][a-z0-9'-]{2,}/giu) ?? [];
    if (terms.length === 0) return false;
    const hits = terms.filter((term) => normalizedActual.includes(term)).length;
    return hits >= Math.max(1, Math.ceil(terms.length / 3));
  });
}

/** Facts from `expected` that are not semantically present in `actualFacts`. */
export function factsMissingFrom(
  expected: ReadonlyArray<string>,
  actualFacts: ReadonlyArray<string>,
): string[] {
  return normalizeFacts(expected).filter((fact) => !factEquivalent(fact, actualFacts));
}
