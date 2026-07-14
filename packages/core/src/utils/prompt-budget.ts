import { estimateTextTokens } from "../llm/provider.js";

export function resolvePromptCompactionTarget(explicitLimit?: number): number | undefined {
  const raw = process.env.INKOS_MAX_PROMPT_ESTIMATED_TOKENS_PER_CALL?.trim();
  const limit = typeof explicitLimit === "number" && Number.isFinite(explicitLimit)
    ? Math.floor(explicitLimit)
    : (raw && /^\d+$/.test(raw) ? Number(raw) : undefined);
  if (limit === undefined || !Number.isSafeInteger(limit) || limit <= 0) return undefined;
  return Math.max(1, limit - Math.max(256, Math.floor(limit * 0.03)));
}

export function truncatePromptBlock(
  value: string,
  maximumTokens: number,
  marker: string,
): string {
  if (estimateTextTokens(value) <= maximumTokens) return value;
  const contentBudget = maximumTokens - estimateTextTokens(marker);
  if (contentBudget <= 0) return "";

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(value.slice(0, middle)) <= contentBudget) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low).trimEnd()}${marker}`;
}
