/**
 * Phase 1 — Canon storage layer.
 *
 * Reads/writes the four machine-checkable canon files under `story/canon/`
 * (design doc §4). These are the structured authority layer; prose foundation
 * in `story/outline` / `story/roles` remains the human-readable source.
 *
 * Layout on disk:
 *   story/canon/claims.json
 *   story/canon/world_system.json
 *   story/canon/protagonist_system.json
 *   story/canon/system_relations.json
 *
 * Everything is Zod-validated on load. Missing files resolve to empty defaults
 * so callers (and books that predate canon governance) never hard-fail. This
 * is what lets Phase 1 "allow hand-written or fixture claims" without touching
 * the writer / auditor path yet.
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import {
  AssetRegistrySchema,
  UnclaimedFactsFileSchema,
  CanonClaimSchema,
  ClaimsFileSchema,
  ProtagonistSystemSchema,
  SystemRelationSchema,
  WorldSystemSchema,
  emptyAssetRegistry,
  emptyWorldSystem,
  type AssetRegistry,
  type UnclaimedFactsFile,
  type CanonBundle,
  type CanonClaim,
  type ClaimsFile,
  type ProtagonistSystem,
  type SystemRelation,
  type WorldSystem,
} from "../models/canon.js";

const CLAIMS_FILE = "claims.json";
const WORLD_SYSTEM_FILE = "world_system.json";
const PROTAGONIST_SYSTEM_FILE = "protagonist_system.json";
const SYSTEM_RELATIONS_FILE = "system_relations.json";
const ASSET_REGISTRY_FILE = "asset_registry.json";
const UNCLAIMED_FACTS_FILE = "unclaimed_facts.json";

export function canonDir(bookDir: string): string {
  return join(bookDir, "story", "canon");
}

export async function hasCanon(bookDir: string): Promise<boolean> {
  try {
    await access(join(canonDir(bookDir), CLAIMS_FILE));
    return true;
  } catch {
    return false;
  }
}

async function readJsonOrNull<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export async function saveClaimsFile(bookDir: string, claims: ClaimsFile): Promise<void> {
  const dir = canonDir(bookDir);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, CLAIMS_FILE), ClaimsFileSchema.parse(claims));
}

export async function loadClaimsFile(bookDir: string): Promise<ClaimsFile> {
  const parsed = await readJsonOrNull(join(canonDir(bookDir), CLAIMS_FILE), ClaimsFileSchema);
  return parsed ?? { claims: [] };
}

export async function saveClaims(bookDir: string, claims: ReadonlyArray<CanonClaim>): Promise<void> {
  await saveClaimsFile(bookDir, { claims: [...claims] });
}

// ---------------------------------------------------------------------------
// World system
// ---------------------------------------------------------------------------

export async function saveWorldSystem(bookDir: string, worldSystem: WorldSystem): Promise<void> {
  const dir = canonDir(bookDir);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, WORLD_SYSTEM_FILE), WorldSystemSchema.parse(worldSystem));
}

export async function loadWorldSystem(bookDir: string): Promise<WorldSystem> {
  const parsed = await readJsonOrNull(join(canonDir(bookDir), WORLD_SYSTEM_FILE), WorldSystemSchema);
  return parsed ?? emptyWorldSystem();
}

// ---------------------------------------------------------------------------
// Protagonist system
// ---------------------------------------------------------------------------

export async function saveProtagonistSystem(
  bookDir: string,
  protagonistSystem: ProtagonistSystem,
): Promise<void> {
  const dir = canonDir(bookDir);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, PROTAGONIST_SYSTEM_FILE), ProtagonistSystemSchema.parse(protagonistSystem));
}

export async function loadProtagonistSystem(bookDir: string): Promise<ProtagonistSystem | null> {
  return readJsonOrNull(join(canonDir(bookDir), PROTAGONIST_SYSTEM_FILE), ProtagonistSystemSchema);
}

// ---------------------------------------------------------------------------
// System relations
// ---------------------------------------------------------------------------

export async function saveSystemRelations(bookDir: string, relations: SystemRelation): Promise<void> {
  const dir = canonDir(bookDir);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, SYSTEM_RELATIONS_FILE), SystemRelationSchema.parse(relations));
}

export async function loadSystemRelations(bookDir: string): Promise<SystemRelation | null> {
  return readJsonOrNull(join(canonDir(bookDir), SYSTEM_RELATIONS_FILE), SystemRelationSchema);
}

// ---------------------------------------------------------------------------
// Bundle convenience
// ---------------------------------------------------------------------------

export async function saveCanonBundle(bookDir: string, bundle: CanonBundle): Promise<void> {
  await Promise.all([
    saveClaimsFile(bookDir, bundle.claims),
    saveWorldSystem(bookDir, bundle.worldSystem),
    bundle.protagonistSystem ? saveProtagonistSystem(bookDir, bundle.protagonistSystem) : Promise.resolve(),
    bundle.systemRelations ? saveSystemRelations(bookDir, bundle.systemRelations) : Promise.resolve(),
  ]);
}

export async function loadCanonBundle(bookDir: string): Promise<CanonBundle> {
  const [claims, worldSystem, protagonistSystem, systemRelations] = await Promise.all([
    loadClaimsFile(bookDir),
    loadWorldSystem(bookDir),
    loadProtagonistSystem(bookDir),
    loadSystemRelations(bookDir),
  ]);
  return { claims, worldSystem, protagonistSystem, systemRelations };
}

// ---------------------------------------------------------------------------
// Asset registry (structure-only; not consumed by generation this round)
// ---------------------------------------------------------------------------

export async function loadAssetRegistry(bookDir: string): Promise<AssetRegistry> {
  const parsed = await readJsonOrNull(join(canonDir(bookDir), ASSET_REGISTRY_FILE), AssetRegistrySchema);
  return parsed ?? emptyAssetRegistry();
}

export async function saveAssetRegistry(bookDir: string, registry: AssetRegistry): Promise<string> {
  const dir = canonDir(bookDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, ASSET_REGISTRY_FILE);
  await writeJson(path, AssetRegistrySchema.parse(registry));
  return path;
}

// ---------------------------------------------------------------------------
// Unclaimed episode facts — deterministic candidates for a later canon refresh
// ---------------------------------------------------------------------------

export async function loadUnclaimedFacts(bookDir: string): Promise<UnclaimedFactsFile> {
  const parsed = await readJsonOrNull(join(canonDir(bookDir), UNCLAIMED_FACTS_FILE), UnclaimedFactsFileSchema);
  return parsed ?? { version: 1, updatedAt: "", facts: [] };
}

export async function saveUnclaimedFacts(
  bookDir: string,
  facts: UnclaimedFactsFile,
): Promise<string> {
  const dir = canonDir(bookDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, UNCLAIMED_FACTS_FILE);
  await writeJson(path, UnclaimedFactsFileSchema.parse(facts));
  return path;
}

export { CanonClaimSchema };
