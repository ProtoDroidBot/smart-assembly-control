import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { SuiObjectData, SuiObjectResponse } from "@mysten/sui/jsonRpc";
import { normalizeStructTag } from "@mysten/sui/utils";
import {
  requireObjectId,
  validateRpcUrl,
  worldTypeOrigin,
} from "./config.ts";
import { ASSEMBLY_TYPES } from "./types.ts";
import type {
  AssemblyConfig,
  AssemblyKind,
  AssemblySnapshot,
  AssemblyState,
  ConnectedAssembly,
} from "./types.ts";

type Fields = Record<string, unknown>;
export type AssemblyReader = Pick<
  SuiJsonRpcClient,
  "getObject" | "multiGetObjects"
>;
const OBJECT_OPTIONS = { showContent: true, showOwner: true, showType: true };

export function createAssemblyClient(config: AssemblyConfig): SuiJsonRpcClient {
  return new SuiJsonRpcClient({
    url: validateRpcUrl(config.rpcUrl),
    network: config.network,
  });
}

function record(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : {};
}

function fields(value: unknown): Fields {
  const object = record(value);
  return object.fields ? record(object.fields) : object;
}

function option(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  const contents = fields(value);
  return Array.isArray(contents.vec) ? contents.vec[0] : value;
}

function objectId(value: unknown, label: string): string {
  if (typeof value === "string") return requireObjectId(value, label);
  const object = fields(value);
  if (typeof object.id === "string") return requireObjectId(object.id, label);
  throw new Error(`${label} is missing from the on-chain object.`);
}

function state(value: unknown): AssemblyState {
  const object = record(value);
  const content = fields(value);
  const variant =
    typeof value === "string" ? value : (object.variant ?? content.variant);
  if (typeof variant === "string") {
    if (variant.toUpperCase() === "ONLINE") return "online";
    if (variant.toUpperCase() === "OFFLINE") return "offline";
  }
  return content.status !== undefined ? state(content.status) : "unknown";
}

function moveObject(
  response: SuiObjectResponse,
  label: string,
): { data: SuiObjectData; values: Fields; type: string } {
  if (
    response.error ||
    !response.data ||
    response.data.content?.dataType !== "moveObject"
  ) {
    throw new Error(
      `${label} could not be read from this Sui network. Check the object ID and world deployment.`,
    );
  }
  return {
    data: response.data,
    values: fields(response.data.content.fields),
    type: response.data.content.type,
  };
}

export function assemblyKind(
  type: string,
  config: AssemblyConfig,
): AssemblyKind {
  const normalizedType = normalizeStructTag(type);
  const worldPackage = worldTypeOrigin(config);
  for (const [kind, suffix] of Object.entries(ASSEMBLY_TYPES)) {
    if (normalizedType === `${worldPackage}::${suffix}`)
      return kind as AssemblyKind;
    if (normalizedType.endsWith(`::${suffix}`)) {
      throw new Error(
        `World package mismatch: this ${suffix.split("::")[1]} belongs to ${normalizedType.split("::")[0]}, but the dApp is configured for ${worldPackage}. Reload the page to sync the current deployment after efctl env up.`,
      );
    }
  }
  throw new Error(
    `Unsupported assembly type: ${type}. Use an Assembly, StorageUnit, Gate, Turret, or NetworkNode from the configured world.`,
  );
}

function name(values: Fields, fallback: string): string {
  const metadataName = fields(option(values.metadata)).name;
  return typeof metadataName === "string" && metadataName.trim()
    ? metadataName
    : fallback;
}

function extensionTypes(
  values: Fields,
  kind: AssemblyKind,
): string[] | undefined {
  if (kind !== "storage_unit" && kind !== "gate" && kind !== "turret")
    return undefined;

  let entries: unknown[];
  if (values.extension !== undefined) {
    const extension = values.extension;
    if (extension === null) return [];
    const contents = fields(extension);
    entries = Array.isArray(extension)
      ? extension
      : Array.isArray(contents.vec)
        ? contents.vec
        : [extension];
    if (entries.length > 1) return undefined;
  } else if (
    kind === "storage_unit" &&
    values.allowed_extensions !== undefined
  ) {
    // Older worlds store the storage unit's extensions in a VecSet<TypeName>.
    const contents = fields(values.allowed_extensions).contents;
    if (!Array.isArray(contents)) return undefined;
    entries = contents;
  } else {
    return undefined;
  }

  const types: string[] = [];
  for (const entry of entries) {
    const typeName = typeof entry === "string" ? entry : fields(entry).name;
    // Do not mistake an unreadable extension for the default behaviour.
    if (typeof typeName !== "string" || !typeName.trim()) return undefined;
    types.push(typeName);
  }
  return types;
}

function energySource(values: Fields): string | undefined {
  const source = option(values.energy_source_id);
  return source === undefined || source === null
    ? undefined
    : objectId(source, "Energy source ID");
}

async function loadConnections(
  reader: AssemblyReader,
  ids: string[],
  config: AssemblyConfig,
  networkNodeId: string,
): Promise<ConnectedAssembly[]> {
  const results: SuiObjectResponse[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    results.push(
      ...(await reader.multiGetObjects({
        ids: ids.slice(offset, offset + 50),
        options: OBJECT_OPTIONS,
      })),
    );
  }
  if (results.length !== ids.length)
    throw new Error(
      "The network node's connected assemblies could not all be loaded.",
    );
  return results.map((response, index) => {
    const loaded = moveObject(response, "Connected assembly");
    const id = requireObjectId(loaded.data.objectId, "Connected assembly ID");
    if (id !== ids[index])
      throw new Error(
        "Connected assembly response does not match the requested object.",
      );
    const kind = assemblyKind(loaded.type, config);
    if (kind === "network_node")
      throw new Error(
        "A connected network node cannot be handled as an assembly.",
      );
    const source = energySource(loaded.values);
    if (source !== networkNodeId)
      throw new Error(
        "A connected assembly's energy source does not match this network node. Refresh the chain state.",
      );
    return {
      id,
      kind,
      name: name(loaded.values, ASSEMBLY_TYPES[kind].split("::")[1]),
      state: state(loaded.values.status),
      networkNodeId: source,
    };
  });
}

/** Read fresh objects from RPC, including the Receiving reference of the character-held OwnerCap. */
export async function loadAssembly(
  config: AssemblyConfig,
  id: string,
  reader: AssemblyReader = createAssemblyClient(config),
): Promise<AssemblySnapshot> {
  const assemblyId = requireObjectId(id, "Assembly object ID");
  const worldPackage = worldTypeOrigin(config);
  const loaded = moveObject(
    await reader.getObject({ id: assemblyId, options: OBJECT_OPTIONS }),
    "Assembly",
  );
  if (
    requireObjectId(loaded.data.objectId, "Assembly object ID") !== assemblyId
  )
    throw new Error("Assembly response does not match the requested object.");
  const kind = assemblyKind(loaded.type, config);
  const ownerCapId = objectId(
    loaded.values.owner_cap_id,
    "Owner capability ID",
  );
  const cap = moveObject(
    await reader.getObject({ id: ownerCapId, options: OBJECT_OPTIONS }),
    "Owner capability",
  );
  if (requireObjectId(cap.data.objectId, "Owner capability ID") !== ownerCapId)
    throw new Error(
      "Owner capability response does not match the requested object.",
    );
  if (
    normalizeStructTag(cap.type) !==
      `${worldPackage}::access::OwnerCap<${worldPackage}::${ASSEMBLY_TYPES[kind]}>` ||
    objectId(cap.values.authorized_object_id, "Authorized assembly ID") !==
      assemblyId
  ) {
    throw new Error("The owner capability does not authorize this assembly.");
  }
  // transfer-to-object is represented as AddressOwner by Sui RPC; ObjectOwner is also accepted.
  const owner = record(cap.data.owner);
  const characterId = objectId(
    owner.AddressOwner ?? owner.ObjectOwner,
    "Owner character ID",
  );
  const character = moveObject(
    await reader.getObject({ id: characterId, options: OBJECT_OPTIONS }),
    "Owner character",
  );
  if (
    requireObjectId(character.data.objectId, "Owner character ID") !==
    characterId
  )
    throw new Error(
      "Owner character response does not match the requested object.",
    );
  if (
    normalizeStructTag(character.type) !==
    `${worldPackage}::character::Character`
  )
    throw new Error(
      "The owner capability is not held by a Character from this world.",
    );
  const ownerAddress = objectId(
    character.values.character_address,
    "Character wallet address",
  );
  const networkNodeId =
    kind === "network_node" ? undefined : energySource(loaded.values);
  let networkNodeState: AssemblyState | undefined;
  if (networkNodeId) {
    const node = moveObject(
      await reader.getObject({ id: networkNodeId, options: OBJECT_OPTIONS }),
      "Energy source network node",
    );
    if (
      requireObjectId(node.data.objectId, "Network node ID") !== networkNodeId
    )
      throw new Error(
        "Network node response does not match the requested object.",
      );
    if (assemblyKind(node.type, config) !== "network_node")
      throw new Error("The assembly's energy source is not a NetworkNode.");
    networkNodeState = state(node.values.status);
  }
  let connectedAssemblies: ConnectedAssembly[] = [];
  if (kind === "network_node") {
    if (!Array.isArray(loaded.values.connected_assembly_ids))
      throw new Error("The network node's connection list is missing.");
    const ids = loaded.values.connected_assembly_ids.map((value) =>
      objectId(value, "Connected assembly ID"),
    );
    if (new Set(ids).size !== ids.length)
      throw new Error(
        "The network node's connection list contains duplicate IDs.",
      );
    connectedAssemblies = await loadConnections(
      reader,
      ids,
      config,
      assemblyId,
    );
  }
  const key = fields(loaded.values.key);
  const metadata = fields(option(loaded.values.metadata));
  // Deployed worlds use item_id; older scaffold fixtures use id. Both are BCS u64.
  const itemId = key.item_id ?? key.id;
  return {
    id: assemblyId,
    kind,
    name: name(loaded.values, ASSEMBLY_TYPES[kind].split("::")[1]),
    description:
      typeof metadata.description === "string"
        ? metadata.description
        : undefined,
    url: typeof metadata.url === "string" ? metadata.url : undefined,
    extensionTypes: extensionTypes(loaded.values, kind),
    state: state(loaded.values.status),
    ownerCapId,
    ownerCapRef: {
      objectId: ownerCapId,
      version: cap.data.version,
      digest: cap.data.digest,
    },
    characterId,
    ownerAddress,
    ownerName: name(character.values, ""),
    networkNodeId,
    networkNodeState,
    connectedAssemblies,
    observedAt: new Date().toISOString(),
    itemId: typeof itemId === "string" ? itemId : undefined,
    tenant: typeof key.tenant === "string" ? key.tenant : undefined,
  };
}
