import {
  configFromEnv,
  requireFeaturePackage,
  requireObjectId,
  validateRpcUrl,
  worldTypeOrigin,
} from "./config.ts";
import { FEATURE_PACKAGES } from "./types.ts";

export type AssemblyEnvironment = Record<string, string | undefined>;

const runtimeKeys = [
  "VITE_SUI_NETWORK",
  "VITE_SUI_RPC_URL",
  "VITE_SUI_CHAIN_ID",
  "VITE_TENANT",
  "VITE_EVE_WORLD_PACKAGE_ID",
  "VITE_EVE_WORLD_TYPE_ORIGIN",
  "VITE_OBJECT_REGISTRY_ID",
  "VITE_ADMIN_ACL_ID",
  "VITE_ENERGY_CONFIG_ID",
  "VITE_FUEL_CONFIG_ID",
  "VITE_NPC_PACKAGE_ID",
  "VITE_NPC_TYPE_ORIGIN",
  "VITE_NPC_REGISTRY_ID",
  "VITE_CATAPULT_PACKAGE_ID",
  "VITE_CATAPULT_TYPE_ORIGIN",
  "VITE_CATAPULT_REGISTRY_ID",
  "VITE_SMART_INDUSTRY_PACKAGE_ID",
  "VITE_SMART_INDUSTRY_TYPE_ORIGIN",
  "VITE_SMART_INDUSTRY_REGISTRY_ID",
  "VITE_TRANSPONDER_PACKAGE_ID",
  "VITE_TRANSPONDER_TYPE_ORIGIN",
  "VITE_TRANSPONDER_REGISTRY_ID",
  "VITE_ASSEMBLY_ACCESS_PACKAGE_ID",
  "VITE_ASSEMBLY_ACCESS_TYPE_ORIGIN",
  "VITE_ASSEMBLY_ACCESS_REGISTRY_ID",
] as const;

const optionalRuntimeKeys = [
  "VITE_ACTION_QUEUE_PACKAGE_ID",
  "VITE_ACTION_QUEUE_TYPE_ORIGIN",
  "VITE_ACTION_QUEUE_REGISTRY_ID",
  "VITE_INDUSTRY_ACTIONS_PACKAGE_ID",
  "VITE_INDUSTRY_ACTIONS_TYPE_ORIGIN",
  "VITE_INDUSTRY_ACTIONS_REGISTRY_ID",
  "VITE_LOGISTICS_ACTIONS_PACKAGE_ID",
  "VITE_LOGISTICS_ACTIONS_TYPE_ORIGIN",
  "VITE_LOGISTICS_ACTIONS_REGISTRY_ID",
  "VITE_INFRASTRUCTURE_ACTIONS_PACKAGE_ID",
  "VITE_INFRASTRUCTURE_ACTIONS_TYPE_ORIGIN",
  "VITE_INFRASTRUCTURE_ACTIONS_REGISTRY_ID",
  "VITE_AUTOMATION_PACKAGE_ID",
  "VITE_AUTOMATION_TYPE_ORIGIN",
  "VITE_AUTOMATION_REGISTRY_ID",
] as const;

export type RuntimeConfiguration = {
  env: AssemblyEnvironment;
  error: string;
};

function mergeRuntimeConfig(
  bakedEnv: AssemblyEnvironment,
  payload: unknown,
): AssemblyEnvironment {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("The deployed world configuration must be a JSON object.");
  }
  const values = payload as Record<string, unknown>;
  const runtimeEnv: AssemblyEnvironment = {};
  for (const key of runtimeKeys) {
    const value = values[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`The deployed world configuration is missing ${key}.`);
    }
    runtimeEnv[key] = value.trim();
  }
  for (const key of optionalRuntimeKeys) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`The deployed world configuration contains an invalid ${key}.`);
    }
    runtimeEnv[key] = value.trim();
  }
  const config = configFromEnv(runtimeEnv);
  validateRpcUrl(config.rpcUrl);
  requireObjectId(config.packageId, "Deployed world package ID");
  worldTypeOrigin(config);
  requireObjectId(config.objectRegistryId, "Deployed Object Registry ID");
  requireObjectId(config.adminAclId, "Deployed Admin ACL ID");
  requireObjectId(config.energyConfigId, "Deployed Energy Config ID");
  requireObjectId(config.fuelConfigId, "Deployed Fuel Config ID");
  for (const name of FEATURE_PACKAGES) requireFeaturePackage(config, name);
  return { ...bakedEnv, ...runtimeEnv };
}

/** Read the current local deployment before any chain or wallet operation. */
export async function loadRuntimeConfig(
  bakedEnv: AssemblyEnvironment,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<RuntimeConfiguration> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Loading the deployed world configuration timed out."));
    }, timeoutMs);
  });
  try {
    const env = await Promise.race([
      (async () => {
        const response = await fetcher("/assembly-config.json", {
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (response.status === 204 || response.status === 404) {
          return bakedEnv;
        }
        if (!response.ok) {
          throw new Error(
            `Loading the deployed world configuration failed (HTTP ${response.status}).`,
          );
        }
        const body = await response.text();
        // Static SPA hosts may serve index.html for this absent endpoint.
        if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(body)) {
          return bakedEnv;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          throw new Error(
            "The deployed world configuration is not valid JSON.",
          );
        }
        return mergeRuntimeConfig(bakedEnv, payload);
      })(),
      timeout,
    ]);
    return { env, error: "" };
  } catch (error) {
    return {
      env: {},
      error: `${error instanceof Error ? error.message : String(error)} Check the local deployment and reload this page.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
