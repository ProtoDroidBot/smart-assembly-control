import {
  requireFeaturePackage,
  requireObjectId,
  worldTypeOrigin,
} from "../assembly/config.ts";
import type {
  AssemblyConfig,
  AssemblyKind,
  AssemblySnapshot,
  AssemblyState,
  ConnectedAssembly,
} from "../assembly/types.ts";
import { FEATURE_PACKAGES } from "../assembly/types.ts";
import type {
  IndustryBlueprint,
  IndustryBlueprintExpectation,
  IndustryRecipeSlot,
} from "../industry/client.ts";
import { MAX_QUEUE_TASKS, type QueuedTask } from "./queue.ts";
import type { TaskDraft, TaskOperation } from "./types.ts";

export const TASK_QUEUE_FILE_FORMAT = "eve-frontier-task-queue";
export const TASK_QUEUE_FILE_VERSION = 2;
export const MAX_IMPORTED_QUEUE_BYTES = 1_000_000;

interface QueueDeployment {
  network: AssemblyConfig["network"];
  chainId: string;
  packageId: string;
  worldTypeOrigin: string;
  objectRegistryId: string;
  energyConfigId: string;
  fuelConfigId: string;
  features: Record<
    (typeof FEATURE_PACKAGES)[number],
    { packageId: string; typeOrigin: string; registryId: string }
  >;
}

function requiresAssemblyOwner(operation: TaskOperation) {
  return !["storage-transfer", "inventory-listener", "queue-delay", "queue-timeout", "queue-repeat"]
    .includes(operation.kind);
}

export interface PortableTaskQueue {
  format: typeof TASK_QUEUE_FILE_FORMAT;
  version: typeof TASK_QUEUE_FILE_VERSION;
  exportedAt: string;
  walletAddress: string;
  deployment: QueueDeployment;
  tasks: TaskDraft[];
}

function invalid(detail: string): never {
  throw new Error(`The queue file is invalid: ${detail}.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number, empty = false) {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim()))
    return invalid(`${label} must be a${empty ? "" : " non-empty"} string no longer than ${maximum} characters`);
  return value;
}

function optionalText(value: unknown, label: string, maximum: number) {
  return value === undefined ? undefined : text(value, label, maximum, true);
}

function oneOf<const T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T))
    return invalid(`${label} is not supported`);
  return value as T;
}

function objectId(value: unknown, label: string) {
  if (typeof value !== "string") return invalid(`${label} must be a Sui object ID`);
  try {
    return requireObjectId(value, label);
  } catch {
    return invalid(`${label} must be a Sui object ID`);
  }
}

const U64_MAX = 18_446_744_073_709_551_615n;
function decimal(value: unknown, label: string, zero = false, safe = false) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || (!zero && value === "0") ||
      value.length > 20 || BigInt(value) > U64_MAX || (safe && !Number.isSafeInteger(Number(value))))
    return invalid(`${label} must be a valid ${zero ? "unsigned" : "positive"} decimal integer`);
  return value;
}

function optionalDecimal(value: unknown, label: string, zero = false, safe = false) {
  return value === undefined ? undefined : decimal(value, label, zero, safe);
}

function nullableDecimal(value: unknown, label: string, safe = false): string | null {
  return value === null ? null : decimal(value, label, false, safe);
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    return invalid(`${label} must be a positive integer no greater than ${maximum}`);
  return value;
}

function uint32Decimal(value: unknown, label: string) {
  const result = decimal(value, label, false, true);
  if (Number(result) > 0xffff_ffff)
    return invalid(`${label} must be no greater than 4294967295`);
  return result;
}

function hash(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    return invalid(`${label} must be a 64-character lowercase hexadecimal hash`);
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function requestId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    return invalid(`${label} must be a version 4 UUID`);
  return value;
}

function parseConnectedAssembly(value: unknown, index: number): ConnectedAssembly {
  const item = record(value, `connected assembly ${index + 1}`);
  return {
    id: objectId(item.id, `connected assembly ${index + 1} ID`),
    kind: oneOf(item.kind, ["assembly", "storage_unit", "gate", "turret"] as const, `connected assembly ${index + 1} kind`),
    name: text(item.name, `connected assembly ${index + 1} name`, 300, true),
    state: oneOf(item.state, ["online", "offline", "unknown"] as const, `connected assembly ${index + 1} state`),
    networkNodeId: item.networkNodeId === undefined ? undefined : objectId(item.networkNodeId, `connected assembly ${index + 1} network node ID`),
  };
}

function parseAssembly(value: unknown, label: string): AssemblySnapshot {
  const item = record(value, label);
  const ownerCap = record(item.ownerCapRef, `${label} owner capability reference`);
  if (!Array.isArray(item.connectedAssemblies) || item.connectedAssemblies.length > 10_000)
    return invalid(`${label} connected assemblies must be an array with at most 10000 entries`);
  let extensionTypes: string[] | undefined;
  if (item.extensionTypes !== undefined) {
    if (!Array.isArray(item.extensionTypes) || item.extensionTypes.length > 1000)
      return invalid(`${label} extension types must be an array with at most 1000 entries`);
    extensionTypes = item.extensionTypes.map((entry, index) => text(entry, `${label} extension type ${index + 1}`, 500));
  }
  const id = objectId(item.id, `${label} ID`);
  const ownerCapId = objectId(item.ownerCapId, `${label} owner capability ID`);
  const ownerCapObjectId = objectId(ownerCap.objectId, `${label} owner capability reference ID`);
  if (ownerCapId !== ownerCapObjectId)
    return invalid(`${label} owner capability IDs do not match`);
  const observedAt = text(item.observedAt, `${label} observation time`, 100);
  if (!Number.isFinite(Date.parse(observedAt))) return invalid(`${label} observation time is not a date`);
  return {
    id,
    itemId: optionalDecimal(item.itemId, `${label} item ID`, true),
    tenant: optionalText(item.tenant, `${label} tenant`, 300),
    kind: oneOf(item.kind, ["assembly", "storage_unit", "gate", "turret", "network_node"] as const satisfies readonly AssemblyKind[], `${label} kind`),
    name: text(item.name, `${label} name`, 300, true),
    description: optionalText(item.description, `${label} description`, 5000),
    url: optionalText(item.url, `${label} URL`, 2000),
    extensionTypes,
    state: oneOf(item.state, ["online", "offline", "unknown"] as const satisfies readonly AssemblyState[], `${label} state`),
    ownerCapId,
    ownerCapRef: {
      objectId: ownerCapObjectId,
      version: decimal(ownerCap.version, `${label} owner capability version`, true),
      digest: text(ownerCap.digest, `${label} owner capability digest`, 200),
    },
    characterId: objectId(item.characterId, `${label} character ID`),
    ownerAddress: objectId(item.ownerAddress, `${label} owner address`),
    ownerName: optionalText(item.ownerName, `${label} owner name`, 300),
    networkNodeId: item.networkNodeId === undefined ? undefined : objectId(item.networkNodeId, `${label} network node ID`),
    networkNodeState: item.networkNodeState === undefined ? undefined :
      oneOf(item.networkNodeState, ["online", "offline", "unknown"] as const, `${label} network node state`),
    connectedAssemblies: item.connectedAssemblies.map(parseConnectedAssembly),
    observedAt,
  };
}

function expectation(value: Record<string, unknown>, label: string): IndustryBlueprintExpectation {
  const expectedBlueprintID = decimal(value.expectedBlueprintID, `${label} expected blueprint ID`, true, true);
  const expectedBlueprintHash = nullableHash(value.expectedBlueprintHash, `${label} expected blueprint hash`);
  if ((expectedBlueprintID === "0") !== (expectedBlueprintHash === null))
    return invalid(`${label} expected blueprint ID and hash are inconsistent`);
  return {
    expectedBlueprintID,
    expectedBlueprintHash,
    expectedJobID: nullableDecimal(value.expectedJobID, `${label} expected job ID`, true),
  };
}

function recipeSlots(value: unknown, label: string): IndustryRecipeSlot[] {
  if (!Array.isArray(value) || value.length > 256)
    return invalid(`${label} must be an array with at most 256 entries`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const slot = record(entry, `${label} entry ${index + 1}`);
    const type_id = decimal(slot.type_id, `${label} entry ${index + 1} type ID`);
    if (seen.has(type_id)) return invalid(`${label} contains a duplicate type ID`);
    seen.add(type_id);
    const quantity = decimal(slot.quantity, `${label} entry ${index + 1} quantity`);
    const max_quantity = decimal(slot.max_quantity, `${label} entry ${index + 1} maximum quantity`);
    if (BigInt(quantity) > BigInt(max_quantity))
      return invalid(`${label} entry ${index + 1} exceeds its maximum quantity`);
    return { type_id, quantity, max_quantity };
  });
}

function blueprint(value: unknown, label: string): IndustryBlueprint {
  const item = record(value, label);
  return {
    blueprintID: decimal(item.blueprintID, `${label} ID`, false, true),
    blueprintHash: hash(item.blueprintHash, `${label} hash`),
    name: text(item.name, `${label} name`, 300, true),
    runTime: decimal(item.runTime, `${label} run time`),
    inputs: recipeSlots(item.inputs, `${label} inputs`),
    outputs: recipeSlots(item.outputs, `${label} outputs`),
  };
}

function parseOperation(value: unknown, assembly: AssemblySnapshot, label: string): TaskOperation {
  const item = record(value, `${label} operation`);
  const kind = text(item.kind, `${label} operation kind`, 100);
  switch (kind) {
    case "assembly-state": {
      const snapshot = parseAssembly(item.snapshot, `${label} reviewed assembly`);
      if (snapshot.id !== assembly.id || snapshot.kind !== assembly.kind || snapshot.itemId !== assembly.itemId ||
          snapshot.ownerAddress !== assembly.ownerAddress)
        return invalid(`${label} reviewed assembly does not match the task assembly`);
      return { kind, action: oneOf(item.action, ["online", "offline"] as const, `${label} assembly action`), snapshot };
    }
    case "storage-transfer":
      if (assembly.kind !== "storage_unit")
        return invalid(`${label} storage transfer requires a storage unit`);
      return {
        kind,
        direction: oneOf(item.direction, ["deposit", "withdraw"] as const, `${label} storage direction`),
        selected: positiveInteger(item.selected, `${label} selected item`),
        quantity: uint32Decimal(item.quantity, `${label} storage quantity`),
      };
    case "industry-start": {
      if (assembly.kind !== "assembly")
        return invalid(`${label} Industry action requires an Industry assembly`);
      const request = record(item.request, `${label} production request`);
      return { kind, request: {
        blueprintID: decimal(request.blueprintID, `${label} blueprint ID`, false, true),
        blueprintHash: hash(request.blueprintHash, `${label} blueprint hash`),
        runs: nullableDecimal(request.runs, `${label} production runs`, true),
        expectedJobID: nullableDecimal(request.expectedJobID, `${label} expected job ID`, true),
      } };
    }
    case "industry-transfer": {
      if (assembly.kind !== "assembly")
        return invalid(`${label} Industry action requires an Industry assembly`);
      const request = record(item.request, `${label} Industry transfer request`);
      const direction = oneOf(request.direction, ["deposit", "withdraw"] as const, `${label} Industry transfer direction`);
      const side = oneOf(request.side, ["inputs", "outputs"] as const, `${label} Industry inventory side`);
      if (direction === "deposit" && side !== "inputs")
        return invalid(`${label} Industry deposits must target inputs`);
      return { kind, request: {
        requestID: requestId(request.requestID, `${label} Industry transfer request ID`),
        storageUnitID: decimal(request.storageUnitID, `${label} storage unit ID`, false, true),
        direction,
        side,
        typeID: uint32Decimal(request.typeID, `${label} type ID`),
        quantity: uint32Decimal(request.quantity, `${label} Industry quantity`),
      } };
    }
    case "industry-blueprint": {
      if (assembly.kind !== "assembly")
        return invalid(`${label} Industry action requires an Industry assembly`);
      const request = record(item.request, `${label} blueprint request`);
      return { kind, request: {
        requestID: requestId(request.requestID, `${label} blueprint request ID`),
        ...expectation(request, `${label} blueprint request`),
        blueprintID: decimal(request.blueprintID, `${label} new blueprint ID`, false, true),
        blueprintHash: hash(request.blueprintHash, `${label} new blueprint hash`),
      }, blueprint: item.blueprint === undefined ? undefined : blueprint(item.blueprint, `${label} blueprint`) };
    }
    case "industry-empty": {
      if (assembly.kind !== "assembly")
        return invalid(`${label} Industry action requires an Industry assembly`);
      const request = record(item.request, `${label} empty request`);
      return { kind, request: {
        requestID: requestId(request.requestID, `${label} empty request ID`),
        ...expectation(request, `${label} empty request`),
        storageUnitID: decimal(request.storageUnitID, `${label} empty destination storage ID`, false, true),
      } };
    }
    case "gate-link":
    case "gate-unlink":
      if (assembly.kind !== "gate")
        return invalid(`${label} gate action requires a Smart Gate`);
      return { kind, targetID: positiveInteger(item.targetID, `${label} target assembly ID`) };
    case "energy-connect":
    case "energy-disconnect":
      if (assembly.kind !== "network_node")
        return invalid(`${label} energy action requires a Network Node`);
      return { kind, targetID: positiveInteger(item.targetID, `${label} target assembly ID`) };
    case "inventory-listener": {
      const request = record(item.request, `${label} listener request`);
      const targetKind = oneOf(request.targetKind, ["smart-assembly", "cargo"] as const, `${label} listener target kind`);
      const inventory = oneOf(request.inventory, ["storage", "inputs", "outputs", "cargo"] as const, `${label} listener inventory`);
      if ((targetKind === "cargo") !== (inventory === "cargo"))
        return invalid(`${label} listener target kind and inventory do not match`);
      if (!Array.isArray(request.requested) || !request.requested.length || request.requested.length > 100)
        return invalid(`${label} listener requested items must contain between 1 and 100 entries`);
      const seen = new Set<number>();
      const requested = request.requested.map((entry, index) => {
        const value = record(entry, `${label} listener item ${index + 1}`);
        const typeID = positiveInteger(value.typeID, `${label} listener item ${index + 1} type ID`, 0xffff_ffff);
        if (seen.has(typeID)) return invalid(`${label} listener contains a duplicate type ID`);
        seen.add(typeID);
        return { typeID, quantity: positiveInteger(value.quantity, `${label} listener item ${index + 1} quantity`, 0xffff_ffff) };
      });
      return { kind, request: {
        targetKind,
        targetID: positiveInteger(request.targetID, `${label} listener target ID`),
        inventory,
        requested,
      }, retryAfterSeconds: positiveInteger(item.retryAfterSeconds, `${label} listener retry delay`, 86400),
      timeoutSeconds: item.timeoutSeconds === null ? null :
        positiveInteger(item.timeoutSeconds, `${label} listener maximum wait`, 604800) };
    }
    case "queue-delay":
      return { kind, seconds: positiveInteger(item.seconds, `${label} retry delay`, 86400) };
    case "queue-timeout":
      return { kind, seconds: positiveInteger(item.seconds, `${label} overall queue timer`, 604800) };
    case "queue-repeat":
      return { kind };
    default:
      return invalid(`${label} operation kind is not supported`);
  }
}

function parseTask(value: unknown, index: number): TaskDraft {
  const label = `task ${index + 1}`;
  const item = record(value, label);
  const assembly = parseAssembly(item.assembly, `${label} assembly`);
  return {
    title: text(item.title, `${label} title`, 300),
    details: text(item.details, `${label} details`, 5000, true),
    assembly,
    operation: parseOperation(item.operation, assembly, label),
  };
}

function deployment(config: AssemblyConfig): QueueDeployment {
  if (!config.chainId || !/^[\da-f]{8,64}$/i.test(config.chainId))
    throw new Error("A valid Sui chain ID is required to export a task queue.");
  return {
    network: config.network,
    chainId: config.chainId.toLowerCase(),
    packageId: requireObjectId(config.packageId, "World package ID"),
    worldTypeOrigin: worldTypeOrigin(config),
    objectRegistryId: requireObjectId(config.objectRegistryId, "Object registry ID"),
    energyConfigId: requireObjectId(config.energyConfigId, "Energy configuration ID"),
    fuelConfigId: requireObjectId(config.fuelConfigId, "Fuel configuration ID"),
    features: Object.fromEntries(
      FEATURE_PACKAGES.map((name) => {
        const feature = requireFeaturePackage(config, name);
        return [
          name,
          {
            packageId: requireObjectId(feature.packageId, `${name} package ID`),
            typeOrigin: requireObjectId(feature.typeOrigin, `${name} type origin`),
            registryId: requireObjectId(feature.registryId, `${name} registry ID`),
          },
        ];
      }),
    ) as QueueDeployment["features"],
  };
}

/** Serialize only pending intents. Results, failure state, wallet objects, and recovery records never leave the page. */
export function serializeTaskQueue(tasks: readonly QueuedTask[], config: AssemblyConfig, walletAddress: string) {
  const queueWallet = objectId(walletAddress, "Queue wallet address");
  const pending = tasks.filter(task => task.status === "queued").map(({ title, details, assembly, operation }) => ({
    title,
    details,
    assembly: structuredClone(assembly),
    operation: structuredClone(operation),
  }));
  if (!pending.length) throw new Error("There are no pending tasks to export.");
  if (pending.length > MAX_QUEUE_TASKS) throw new Error(`A queue file can contain at most ${MAX_QUEUE_TASKS} tasks.`);
  if (tasks.some(task => task.status === "queued" &&
      (objectId(task.walletAddress, "Task wallet address") !== queueWallet ||
       (requiresAssemblyOwner(task.operation) && objectId(task.assembly.ownerAddress, "Task owner address") !== queueWallet))))
    throw new Error("Every pending owner-scoped task must belong to the connected wallet before this queue can be exported.");
  const file: PortableTaskQueue = {
    format: TASK_QUEUE_FILE_FORMAT,
    version: TASK_QUEUE_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    walletAddress: queueWallet,
    deployment: deployment(config),
    tasks: pending,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Parse untrusted JSON into newly constructed task data and bind it to the active deployment and owner wallet. */
export function parseTaskQueue(source: string, config: AssemblyConfig, walletAddress: string): TaskDraft[] {
  if (typeof source !== "string" || new TextEncoder().encode(source).byteLength > MAX_IMPORTED_QUEUE_BYTES)
    throw new Error(`Queue files must be no larger than ${MAX_IMPORTED_QUEUE_BYTES.toLocaleString()} bytes.`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  const file = record(decoded, "top level");
  if (file.format !== TASK_QUEUE_FILE_FORMAT)
    return invalid(`format must be ${TASK_QUEUE_FILE_FORMAT}`);
  if (file.version !== TASK_QUEUE_FILE_VERSION)
    throw new Error(`Queue file version ${String(file.version)} is not supported. This dApp supports version ${TASK_QUEUE_FILE_VERSION}.`);
  const exportedAt = text(file.exportedAt, "export time", 100);
  if (!Number.isFinite(Date.parse(exportedAt))) return invalid("export time is not a date");
  const expectedWallet = objectId(walletAddress, "Connected wallet address");
  if (objectId(file.walletAddress, "Queue wallet address") !== expectedWallet)
    throw new Error("This queue belongs to a different wallet. Connect the wallet that exported it before importing.");
  const expectedDeployment = deployment(config);
  const importedDeployment = record(file.deployment, "deployment");
  const importedFeatures = record(
    importedDeployment.features,
    "deployment features",
  );
  if (importedDeployment.network !== expectedDeployment.network ||
      importedDeployment.chainId !== expectedDeployment.chainId ||
      objectId(importedDeployment.packageId, "Queue world package ID") !== expectedDeployment.packageId ||
      objectId(importedDeployment.worldTypeOrigin, "Queue world type origin") !== expectedDeployment.worldTypeOrigin ||
      objectId(importedDeployment.objectRegistryId, "Queue object registry ID") !== expectedDeployment.objectRegistryId ||
      objectId(importedDeployment.energyConfigId, "Queue energy configuration ID") !== expectedDeployment.energyConfigId ||
      objectId(importedDeployment.fuelConfigId, "Queue fuel configuration ID") !== expectedDeployment.fuelConfigId)
    throw new Error("This queue was exported for a different network or world deployment.");
  for (const name of FEATURE_PACKAGES) {
    const imported = record(importedFeatures[name], `${name} deployment`);
    const expected = expectedDeployment.features[name];
    if (
      objectId(imported.packageId, `${name} queue package ID`) !==
        expected.packageId ||
      objectId(imported.typeOrigin, `${name} queue type origin`) !==
        expected.typeOrigin ||
      objectId(imported.registryId, `${name} queue registry ID`) !==
        expected.registryId
    )
      throw new Error(
        "This queue was exported for a different network or world deployment.",
      );
  }
  if (!Array.isArray(file.tasks) || !file.tasks.length || file.tasks.length > MAX_QUEUE_TASKS)
    return invalid(`tasks must contain between 1 and ${MAX_QUEUE_TASKS} entries`);
  const tasks = file.tasks.map(parseTask);
  const repeat = tasks.findIndex(task => task.operation.kind === "queue-repeat");
  if ((repeat >= 0 && repeat !== tasks.length - 1) || tasks.filter(task => task.operation.kind === "queue-repeat").length > 1)
    return invalid("a queue can contain one repeat action, and it must be last");
  if (tasks.every(task => task.operation.kind === "queue-repeat"))
    return invalid("a repeat action requires at least one executable task");
  if (tasks.filter(task => task.operation.kind === "queue-timeout").length > 1)
    return invalid("a queue can contain only one overall timer");
  if (tasks.every(task => task.operation.kind === "queue-repeat" || task.operation.kind === "queue-timeout"))
    return invalid("queue controls require at least one listener, delay, or executable action");
  if (tasks.some(task => requiresAssemblyOwner(task.operation) && task.assembly.ownerAddress !== expectedWallet))
    throw new Error("Every imported owner-scoped task must belong to the connected wallet.");
  return tasks;
}
