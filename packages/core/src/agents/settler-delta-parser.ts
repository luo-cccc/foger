import {
  RuntimeStateDeltaSchema,
  type RuntimeStateDelta,
} from "../models/runtime-state.js";
import {
  normalizeHookStatusAlias,
  normalizeHookTypeLabel,
} from "../utils/hook-governance.js";

export interface SettlerDeltaOutput {
  readonly postSettlement: string;
  readonly runtimeStateDelta: RuntimeStateDelta;
}

function sanitizeJSON(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseSettlerDeltaOutput(content: string): SettlerDeltaOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const rawDelta = extract("RUNTIME_STATE_DELTA");
  if (!rawDelta) {
    throw new Error("runtime state delta block is missing");
  }

  const jsonPayload = stripCodeFence(rawDelta);
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitizeJSON(jsonPayload));
  } catch (error) {
    throw new Error(`runtime state delta is not valid JSON: ${String(error)}`);
  }

  try {
    return {
      postSettlement: extract("POST_SETTLEMENT"),
      runtimeStateDelta: RuntimeStateDeltaSchema.parse(normalizeHookAliases(parsed)),
    };
  } catch (error) {
    throw new Error(`runtime state delta failed schema validation: ${String(error)}`);
  }
}

function normalizeHookAliases(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const hookOps = isRecord(value.hookOps) ? value.hookOps : undefined;
  const upsert = Array.isArray(hookOps?.upsert)
    ? hookOps.upsert.map((hook) => normalizeHookRecordAliases(hook))
    : hookOps?.upsert;
  const newHookCandidates = Array.isArray(value.newHookCandidates)
    ? value.newHookCandidates.map((candidate) => normalizeHookCandidateAliases(candidate))
    : value.newHookCandidates;

  return {
    ...value,
    ...(hookOps ? { hookOps: { ...hookOps, upsert } } : {}),
    newHookCandidates,
  };
}

function normalizeHookRecordAliases(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(typeof value.type === "string" ? { type: normalizeHookTypeLabel(value.type) } : {}),
    status: normalizeHookStatusAlias(value.status),
  };
}

function normalizeHookCandidateAliases(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== "string") return value;
  return { ...value, type: normalizeHookTypeLabel(value.type) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}
