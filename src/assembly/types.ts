export type AssemblyKind =
  | "assembly"
  | "storage_unit"
  | "gate"
  | "turret"
  | "network_node";
export type AssemblyState = "online" | "offline" | "unknown";
export type AssemblyAction = "online" | "offline";
export type SuiNetwork = "localnet" | "devnet" | "testnet" | "mainnet";

export const FEATURE_PACKAGES = [
  "npc",
  "catapult",
  "smartIndustry",
  "transponder",
  "assemblyAccess",
  "actionQueue",
  "industryActions",
  "logisticsActions",
  "infrastructureActions",
  "automation",
] as const;
export type FeaturePackageName = (typeof FEATURE_PACKAGES)[number];

/** Calls target packageId; struct tags and derived keys use typeOrigin. */
export interface MovePackageBinding {
  packageId: string;
  typeOrigin: string;
  registryId: string;
}
export type FeaturePackageBindings = Record<
  FeaturePackageName,
  MovePackageBinding
>;

export interface AssemblyConfig {
  network: SuiNetwork;
  rpcUrl: string;
  packageId: string;
  /** Original core-world package address. Falls back to packageId for old configs. */
  worldTypeOrigin?: string;
  objectRegistryId: string;
  adminAclId?: string;
  energyConfigId: string;
  fuelConfigId: string;
  chainId?: string;
  /** Split feature deployments. Optional only for old/test fixtures. */
  features?: FeaturePackageBindings;
  defaultObjectId?: string;
  defaultItemId?: string;
  defaultTenant?: string;
}

export interface OwnerCapRef {
  objectId: string;
  version: string;
  digest: string;
}

export interface ConnectedAssembly {
  id: string;
  kind: Exclude<AssemblyKind, "network_node">;
  name: string;
  state: AssemblyState;
  networkNodeId?: string;
}

/** Observed chain state. Never mutate this to represent an unconfirmed action. */
export interface AssemblySnapshot {
  id: string;
  itemId?: string;
  tenant?: string;
  kind: AssemblyKind;
  name: string;
  description?: string;
  url?: string;
  /** Undefined when unavailable; an empty array confirms no configured extensions. */
  extensionTypes?: string[];
  state: AssemblyState;
  ownerCapId: string;
  ownerCapRef: OwnerCapRef;
  characterId: string;
  ownerAddress: string;
  ownerName?: string;
  networkNodeId?: string;
  networkNodeState?: AssemblyState;
  connectedAssemblies: ConnectedAssembly[];
  observedAt: string;
}

export const ASSEMBLY_TYPES: Record<AssemblyKind, string> = {
  assembly: "assembly::Assembly",
  storage_unit: "storage_unit::StorageUnit",
  gate: "gate::Gate",
  turret: "turret::Turret",
  network_node: "network_node::NetworkNode",
};
