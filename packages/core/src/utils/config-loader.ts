import type { ProjectConfig } from "../models/project.js";
import {
  resolveEffectiveLLMConfig,
  type LLMConfigCliOverrides,
  type LLMConsumer,
} from "./effective-llm-config.js";
import { loadLLMEnvLayers, GLOBAL_CONFIG_DIR, GLOBAL_ENV_PATH } from "./llm-env.js";
import { isApiKeyOptionalForEndpoint } from "./llm-endpoint-auth.js";
import { loadSecrets } from "../llm/secrets.js";

export { GLOBAL_CONFIG_DIR, GLOBAL_ENV_PATH, isApiKeyOptionalForEndpoint };

export async function loadProjectConfig(
  root: string,
  options?: {
    readonly requireApiKey?: boolean;
    readonly cli?: LLMConfigCliOverrides;
    readonly consumer?: LLMConsumer;
  },
): Promise<ProjectConfig> {
  const envLayers = await loadLLMEnvLayers(root);
  const result = await resolveEffectiveLLMConfig({
    consumer: options?.consumer ?? "cli",
    projectRoot: root,
    envLayers,
    cli: options?.cli,
    requireApiKey: options?.requireApiKey,
  });
  await hydrateModelOverrideApiKeys(result.config, root);
  return result.config;
}

/**
 * Full model overrides are resolved synchronously by PipelineRunner. Bridge
 * project service secrets into their declared apiKeyEnv at config-load time,
 * while keeping the secret out of inkos.json and preserving explicit env vars.
 */
async function hydrateModelOverrideApiKeys(config: ProjectConfig, root: string): Promise<void> {
  if (!config.modelOverrides && !config.contentPolicyFallback) return;

  const secrets = await loadSecrets(root);
  for (const value of Object.values(config.modelOverrides ?? {})) {
    if (typeof value === "string" || !value.apiKeyEnv) continue;
    if (process.env[value.apiKeyEnv]?.trim()) continue;

    const service = value.service ?? config.llm.service;
    const apiKey = secrets.services[service]?.apiKey?.trim();
    if (apiKey) process.env[value.apiKeyEnv] = apiKey;
  }

  const fallback = config.contentPolicyFallback;
  if (fallback && !process.env[fallback.apiKeyEnv]?.trim()) {
    const apiKey = secrets.services[fallback.service]?.apiKey?.trim();
    if (apiKey) process.env[fallback.apiKeyEnv] = apiKey;
  }
}
