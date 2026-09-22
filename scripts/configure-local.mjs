import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const defaultRpcUrls = {
  localnet: "http://127.0.0.1:9000",
  testnet: "https://fullnode.testnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
};
const worldIds = {
  packageId: "VITE_EVE_WORLD_PACKAGE_ID",
  objectRegistry: "VITE_OBJECT_REGISTRY_ID",
  adminAcl: "VITE_ADMIN_ACL_ID",
  energyConfig: "VITE_ENERGY_CONFIG_ID",
  fuelConfig: "VITE_FUEL_CONFIG_ID",
};
const features = {
  npc: {
    prefix: "NPC",
    manifestPackage: "packageId",
    manifestOrigin: "typeOrigin",
    manifestRegistry: "npcRegistryId",
  },
  catapult: {
    prefix: "CATAPULT",
    manifestPackage: "catapultPackageId",
    manifestOrigin: "catapultTypeOrigin",
    manifestRegistry: "catapultRegistryId",
  },
  smartIndustry: {
    prefix: "SMART_INDUSTRY",
    manifestPackage: "industryPackageId",
    manifestOrigin: "industryTypeOrigin",
    manifestRegistry: "industryRegistryId",
  },
  transponder: {
    prefix: "TRANSPONDER",
    manifestPackage: "transponderPackageId",
    manifestOrigin: "transponderTypeOrigin",
    manifestRegistry: "transponderRegistryId",
  },
  assemblyAccess: {
    prefix: "ASSEMBLY_ACCESS",
    manifestPackage: "accessPackageId",
    manifestOrigin: "accessTypeOrigin",
    manifestRegistry: "accessRegistryId",
  },
  actionQueue: {
    prefix: "ACTION_QUEUE",
    manifestPackage: "actionPackageId",
    manifestOrigin: "actionTypeOrigin",
    manifestRegistry: "actionRegistryId",
    legacyFeature: "assemblyAccess",
  },
  industryActions: {
    prefix: "INDUSTRY_ACTIONS",
    manifestPackage: "industryActionsPackageId",
    manifestOrigin: "industryActionsTypeOrigin",
    manifestRegistry: "industryActionsRegistryId",
    legacyFeature: "smartIndustry",
  },
  logisticsActions: {
    prefix: "LOGISTICS_ACTIONS",
    manifestPackage: "logisticsPackageId",
    manifestOrigin: "logisticsTypeOrigin",
    manifestRegistry: "logisticsRegistryId",
    legacyFeature: "actionQueue",
  },
  infrastructureActions: {
    prefix: "INFRASTRUCTURE_ACTIONS",
    manifestPackage: "infrastructurePackageId",
    manifestOrigin: "infrastructureTypeOrigin",
    manifestRegistry: "infrastructureRegistryId",
    legacyFeature: "actionQueue",
  },
  automation: {
    prefix: "AUTOMATION",
    manifestPackage: "automationPackageId",
    manifestOrigin: "automationTypeOrigin",
    manifestRegistry: "automationRegistryId",
    legacyFeature: "actionQueue",
  },
};

function objectId(value, label) {
  if (typeof value !== "string" || !/^0x[a-f\d]{1,64}$/iu.test(value))
    throw new Error(`Deployment is missing a valid ${label} object ID.`);
  return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

function matchingId(left, right, label) {
  const a = objectId(left, label);
  const b = objectId(right, label);
  if (a !== b)
    throw new Error(
      `${label} differs between extracted-object-ids.json and npc-deployment.json.`,
    );
  return a;
}

// This is the only data returned by /assembly-config.json. Keep the allowlist
// explicit so private keys and admin capabilities cannot leak to the browser.
export function publicEnvironmentEntries(artifact, options = {}) {
  const network = options.network || "localnet";
  if (!Object.hasOwn(defaultRpcUrls, network))
    throw new Error("Network must be localnet, testnet, devnet, or mainnet.");
  if (artifact.network && artifact.network !== network)
    throw new Error(
      `Deployment network ${artifact.network} does not match ${network}.`,
    );
  const tenant = options.tenant || "dev";
  if (!/^[a-z\d_.-]{1,64}$/iu.test(tenant))
    throw new Error(
      "Tenant must contain 1–64 letters, digits, underscores, dots, or hyphens.",
    );
  const rpcUrl = options.rpcUrl || defaultRpcUrls[network];
  const url = new URL(rpcUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\r\n$]/u.test(rpcUrl)
  )
    throw new Error(
      "Use a public HTTP(S) RPC URL without credentials, query strings, or fragments.",
    );

  const manifest = options.featureDeployment;
  if (!manifest || typeof manifest !== "object")
    throw new Error(
      "Feature deployment manifest is required for split-package configuration.",
    );
  const entries = {
    VITE_SUI_NETWORK: network,
    VITE_SUI_RPC_URL: rpcUrl,
    VITE_SUI_CHAIN_ID:
      typeof manifest.chainId === "string" ? manifest.chainId : "",
    VITE_TENANT: tenant,
  };
  for (const [field, variable] of Object.entries(worldIds))
    entries[variable] = objectId(artifact.world?.[field], `world.${field}`);
  entries.VITE_EVE_WORLD_TYPE_ORIGIN = matchingId(
    artifact.world?.packageId,
    manifest.worldPackageId,
    "world package ID",
  );
  matchingId(
    artifact.world?.objectRegistry,
    manifest.objectRegistryId,
    "ObjectRegistry ID",
  );
  matchingId(artifact.world?.adminAcl, manifest.adminAclId, "AdminACL ID");

  for (const [name, definition] of Object.entries(features)) {
    const legacy = definition.legacyFeature
      ? features[definition.legacyFeature]
      : undefined;
    const extracted = artifact.features?.[name] ||
      (definition.legacyFeature ? artifact.features?.[definition.legacyFeature] : undefined);
    const manifestPackage = manifest[definition.manifestPackage] ??
      (legacy ? manifest[legacy.manifestPackage] : undefined);
    const manifestOrigin = manifest[definition.manifestOrigin] ??
      (legacy ? manifest[legacy.manifestOrigin] : undefined);
    const manifestRegistry = manifest[definition.manifestRegistry] ??
      (legacy ? manifest[legacy.manifestRegistry] : undefined);
    entries[`VITE_${definition.prefix}_PACKAGE_ID`] = matchingId(
      extracted?.packageId,
      manifestPackage,
      `${name} package ID`,
    );
    entries[`VITE_${definition.prefix}_TYPE_ORIGIN`] = objectId(
      manifestOrigin,
      `${name} type origin`,
    );
    entries[`VITE_${definition.prefix}_REGISTRY_ID`] = matchingId(
      extracted?.registryId,
      manifestRegistry,
      `${name} registry ID`,
    );
  }
  return entries;
}

export function buildPublicEnvironment(artifact, options = {}) {
  const entries = publicEnvironmentEntries(artifact, options);
  return [
    "# Public browser configuration generated from extracted-object-ids.json",
    "# and npc-deployment.json. Local hosting also reloads them at page load.",
    ...Object.entries(entries).map(
      ([name, value]) => `${name}=${JSON.stringify(value)}`,
    ),
    "# Optional fixed selection; URL objectId/itemId takes precedence in the app.",
    "VITE_OBJECT_ID=",
    "VITE_ITEM_ID=",
    "",
  ].join("\n");
}

async function readJson(filename, label) {
  const raw = await readFile(filename, "utf8");
  if (raw.length > 1_048_576)
    throw new Error(`${label} is unexpectedly large.`);
  return JSON.parse(raw);
}

async function main() {
  const options = {
    worldDir: path.resolve(appDirectory, "../3502403/world-contracts"),
    network: "localnet",
  };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      console.log(
        "Usage: node scripts/configure-local.mjs [--world-dir PATH] [--network localnet|testnet|devnet|mainnet] [--rpc-url URL] [--tenant dev] [--force]",
      );
      return;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    const fields = {
      "--world-dir": "worldDir",
      "--network": "network",
      "--rpc-url": "rpcUrl",
      "--tenant": "tenant",
    };
    const field = fields[argument];
    if (!field || !args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error(
        `Unknown or incomplete argument: ${argument}. Use --help for usage.`,
      );
    options[field] = args[++index];
  }
  if (!Object.hasOwn(defaultRpcUrls, options.network))
    throw new Error("Network must be localnet, testnet, devnet, or mainnet.");
  const deploymentDirectory = path.resolve(
    options.worldDir,
    "deployments",
    options.network,
  );
  const artifact = await readJson(
    path.join(deploymentDirectory, "extracted-object-ids.json"),
    "Deployment artifact",
  );
  const featureDeployment = await readJson(
    path.join(deploymentDirectory, "npc-deployment.json"),
    "Feature deployment manifest",
  );
  const buildOptions = { ...options, featureDeployment };
  const output = buildPublicEnvironment(artifact, buildOptions);
  const destination = path.join(appDirectory, ".env.local");
  await writeFile(destination, output, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
  });
  const entries = publicEnvironmentEntries(artifact, buildOptions);
  await writeFile(
    path.join(appDirectory, ".deployment-source.json"),
    `${JSON.stringify(
      {
        worldDir: path.resolve(options.worldDir),
        network: entries.VITE_SUI_NETWORK,
        rpcUrl: entries.VITE_SUI_RPC_URL,
        tenant: entries.VITE_TENANT,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `Wrote ${destination} and enabled split-package deployment sync. Local hosting reads the current public deployment IDs on every page load.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    const message =
      error.code === "EEXIST"
        ? ".env.local already exists. Review it before using --force to replace the public configuration."
        : error.code === "ENOENT"
          ? "Deployment artifacts not found. Deploy world-contracts first, or provide --world-dir PATH."
          : error.message;
    console.error(`Unable to configure the dApp: ${message}`);
    process.exitCode = 1;
  });
}
