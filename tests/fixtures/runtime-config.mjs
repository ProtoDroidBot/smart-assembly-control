export function deployedRuntimeFixture(config) {
  const env = {
    VITE_SUI_NETWORK: config.network,
    VITE_SUI_RPC_URL: config.rpcUrl,
    VITE_SUI_CHAIN_ID: config.chainId,
    VITE_TENANT: "dev",
    VITE_EVE_WORLD_PACKAGE_ID: config.packageId,
    VITE_EVE_WORLD_TYPE_ORIGIN: config.packageId,
    VITE_OBJECT_REGISTRY_ID: config.objectRegistryId,
    VITE_ADMIN_ACL_ID: config.adminAclId,
    VITE_ENERGY_CONFIG_ID: config.energyConfigId,
    VITE_FUEL_CONFIG_ID: config.fuelConfigId,
  };
  const features = ["NPC", "CATAPULT", "SMART_INDUSTRY", "TRANSPONDER", "ASSEMBLY_ACCESS"];
  for (const [index, feature] of features.entries()) {
    const packageId = `0x${index + 1}1`;
    env[`VITE_${feature}_PACKAGE_ID`] = packageId;
    env[`VITE_${feature}_TYPE_ORIGIN`] = packageId;
    env[`VITE_${feature}_REGISTRY_ID`] = `0x${index + 1}2`;
  }
  return env;
}
