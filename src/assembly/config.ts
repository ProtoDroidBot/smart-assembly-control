import { bcs } from "@mysten/sui/bcs";
import { deriveObjectID, normalizeSuiObjectId } from "@mysten/sui/utils";
import {
  FEATURE_PACKAGES,
  type AssemblyConfig,
  type FeaturePackageName,
  type MovePackageBinding,
  type SuiNetwork,
} from "./types.ts";

const RPC_URLS: Record<SuiNetwork, string> = {
  localnet: "http://127.0.0.1:9000",
  devnet: "https://fullnode.devnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
};

const FEATURE_ENV_PREFIX: Record<FeaturePackageName, string> = {
  npc: "NPC",
  catapult: "CATAPULT",
  smartIndustry: "SMART_INDUSTRY",
  transponder: "TRANSPONDER",
  assemblyAccess: "ASSEMBLY_ACCESS",
  actionQueue: "ACTION_QUEUE",
  industryActions: "INDUSTRY_ACTIONS",
  logisticsActions: "LOGISTICS_ACTIONS",
  infrastructureActions: "INFRASTRUCTURE_ACTIONS",
  automation: "AUTOMATION",
};

function featureFromEnv(
  env: Record<string, string | undefined>,
  name: FeaturePackageName,
): MovePackageBinding {
  const prefix = FEATURE_ENV_PREFIX[name];
  const packageId = env[`VITE_${prefix}_PACKAGE_ID`]?.trim() || "";
  return {
    packageId,
    typeOrigin: env[`VITE_${prefix}_TYPE_ORIGIN`]?.trim() || packageId,
    registryId: env[`VITE_${prefix}_REGISTRY_ID`]?.trim() || "",
  };
}

export function configFromEnv(
  env: Record<string, string | undefined>,
): AssemblyConfig {
  const network = env.VITE_SUI_NETWORK?.trim() || "localnet";
  if (!Object.prototype.hasOwnProperty.call(RPC_URLS, network))
    throw new Error(
      "Choose localnet, devnet, testnet, or mainnet as the Sui network.",
    );
  const packageId = env.VITE_EVE_WORLD_PACKAGE_ID?.trim() || "";
  const features = Object.fromEntries(
    FEATURE_PACKAGES.map((name) => [name, featureFromEnv(env, name)]),
  ) as AssemblyConfig["features"];
  if (features && !features.actionQueue.packageId) {
    features.actionQueue = { ...features.assemblyAccess };
  }
  if (features && !features.industryActions.packageId) {
    features.industryActions = { ...features.smartIndustry };
  }
  if (features && !features.logisticsActions.packageId) {
    features.logisticsActions = { ...features.actionQueue };
  }
  if (features && !features.infrastructureActions.packageId) {
    features.infrastructureActions = { ...features.actionQueue };
  }
  if (features && !features.automation.packageId) {
    features.automation = { ...features.actionQueue };
  }
  return {
    network: network as SuiNetwork,
    rpcUrl: env.VITE_SUI_RPC_URL?.trim() || RPC_URLS[network as SuiNetwork],
    packageId,
    worldTypeOrigin: env.VITE_EVE_WORLD_TYPE_ORIGIN?.trim() || packageId,
    objectRegistryId: env.VITE_OBJECT_REGISTRY_ID?.trim() || "",
    adminAclId: env.VITE_ADMIN_ACL_ID?.trim() || "",
    energyConfigId: env.VITE_ENERGY_CONFIG_ID?.trim() || "",
    fuelConfigId: env.VITE_FUEL_CONFIG_ID?.trim() || "",
    chainId: env.VITE_SUI_CHAIN_ID?.trim() || undefined,
    features,
    defaultObjectId: env.VITE_OBJECT_ID?.trim() || undefined,
    defaultItemId: env.VITE_ITEM_ID?.trim() || undefined,
    defaultTenant: env.VITE_TENANT?.trim() || "dev",
  };
}

export function worldTypeOrigin(config: AssemblyConfig): string {
  return requireObjectId(
    config.worldTypeOrigin || config.packageId,
    "World package type origin",
  );
}

export function packageTarget(
  binding: Pick<MovePackageBinding, "packageId">,
  module: string,
  fn: string,
): string {
  return `${requireObjectId(binding.packageId, "Package ID")}::${module}::${fn}`;
}

export function packageType(
  binding: Pick<MovePackageBinding, "typeOrigin">,
  module: string,
  struct: string,
): string {
  return `${requireObjectId(binding.typeOrigin, "Package type origin")}::${module}::${struct}`;
}

export function requireFeaturePackage(
  config: AssemblyConfig,
  name: FeaturePackageName,
): MovePackageBinding {
  const binding = config.features?.[name];
  if (!binding) throw new Error(`${name} feature package is not configured.`);
  requireObjectId(binding.packageId, `${name} package ID`);
  requireObjectId(binding.typeOrigin, `${name} type origin`);
  requireObjectId(binding.registryId, `${name} registry ID`);
  return binding;
}

export function requireObjectId(
  value: string | undefined,
  label: string,
): string {
  if (!value || !/^0x[\da-f]{1,64}$/i.test(value)) {
    throw new Error(
      `${label} must be a Sui object ID (0x followed by up to 64 hexadecimal digits).`,
    );
  }
  return normalizeSuiObjectId(value);
}

export function validateRpcUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid HTTP(S) Sui RPC URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Use an HTTP(S) Sui RPC URL without credentials.");
  }
  return value;
}

/** In-game item IDs are u64 values; keep decimal strings to avoid JS precision loss. */
export function resolveAssemblyId(
  config: AssemblyConfig,
  params: URLSearchParams,
): string {
  const explicitObjectId = params.get("objectId") || params.get("object_id");
  if (explicitObjectId)
    return requireObjectId(explicitObjectId, "Assembly object ID");
  const itemId = params.get("itemId") || params.get("item_id");
  if (!itemId && config.defaultObjectId)
    return requireObjectId(config.defaultObjectId, "Assembly object ID");
  const selectedItemId = itemId || config.defaultItemId;
  if (!selectedItemId)
    throw new Error(
      "Enter an assembly object ID, or open this dApp from a Smart Assembly.",
    );
  if (
    !/^\d+$/.test(selectedItemId) ||
    BigInt(selectedItemId) > 18446744073709551615n
  ) {
    throw new Error(
      "Assembly itemId must be an unsigned 64-bit decimal integer.",
    );
  }
  const tenant = params.get("tenant")?.trim() || config.defaultTenant;
  if (!tenant)
    throw new Error("A tenant is required to resolve an in-game item ID.");
  const registry = requireObjectId(
    config.objectRegistryId,
    "Object Registry ID",
  );
  const typeOrigin = worldTypeOrigin(config);
  const key = bcs.struct("TenantItemId", {
    id: bcs.u64(),
    tenant: bcs.string(),
  });
  return deriveObjectID(
    registry,
    `${typeOrigin}::in_game_id::TenantItemId`,
    key.serialize({ id: selectedItemId, tenant }).toBytes(),
  );
}
