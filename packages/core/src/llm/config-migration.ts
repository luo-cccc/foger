import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { saveSecrets, loadSecrets } from "./secrets.js";
import { guessServiceFromBaseUrl } from "./service-presets.js";
import { mutateProjectConfig } from "../utils/project-config-mutation.js";

export interface MigrationResult {
  migrated: boolean;
}

export async function migrateConfig(projectRoot: string): Promise<MigrationResult> {
  const configPath = join(projectRoot, "inkos.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return { migrated: false };
  }

  JSON.parse(raw);
  return await mutateProjectConfig(projectRoot, async (config) => {
    const llm = config.llm as Record<string, unknown> | undefined;
    if (!llm || Array.isArray(llm.services)) return { migrated: false };

    const { provider, model, baseUrl, apiKey, ...restLlm } = llm;
    if (!model && !provider) return { migrated: false };

    const guessedService = typeof baseUrl === "string" ? guessServiceFromBaseUrl(baseUrl) : null;
    const service = guessedService ?? "custom";
    const serviceEntry: Record<string, string> = { service };
    if (service === "custom") {
      serviceEntry.name = "Custom";
      if (typeof baseUrl === "string") serviceEntry.baseUrl = baseUrl;
    }

    config.llm = {
      ...restLlm,
      services: [serviceEntry],
      defaultModel: model,
    };

    if (typeof apiKey === "string" && apiKey) {
      const secrets = await loadSecrets(projectRoot);
      const secretKey = service === "custom" ? `custom:${serviceEntry.name}` : service;
      secrets.services[secretKey] = { apiKey };
      await saveSecrets(projectRoot, secrets);
    }

    return { migrated: true };
  });
}
