import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { createAssemblyClient } from "../assembly/client.ts";
import { listDynamicFields } from "../assembly/dynamic-fields.ts";
import {
  deriveObjectID,
  normalizeSuiAddress,
  normalizeStructTag,
  fromBase64,
  SUI_CLOCK_OBJECT_ID,
} from "@mysten/sui/utils";
import {
  packageTarget,
  requireFeaturePackage,
  requireObjectId,
  worldTypeOrigin,
} from "../assembly/config.ts";
import type { AssemblyConfig, AssemblySnapshot } from "../assembly/types.ts";
import type { RemoteScanRequest } from "../energy/client.ts";

export const REMOTE_SCAN_ACTION_TYPE = "intelligence.remote-scan.execute";
export const REMOTE_SCAN_ALERT_ACTION_TYPE = "intelligence.remote-scan.detected";
export const ASSEMBLY_ACTION_PRIORITY = Object.freeze({ NORMAL: 100, HIGH: 200 });
export const ASSEMBLY_ACTION_FLAG = Object.freeze({
  PLAYER_INITIATED: 1 << 1,
  INTELLIGENCE: 1 << 8,
});
const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface QueuedChainAction {
  actionID: string;
  actionObjectID: string;
  actionType: string;
  payload: RemoteScanRequest;
  expiresAtMs: number;
  transaction: Transaction;
}

export interface RemoteScanAlertAction {
  actionID: string;
  actionObjectID: string;
  sourceAssemblyObjectID: string;
  targetAssemblyObjectID: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: number;
  priority: number;
  priorityFlags: number;
  payload: {
    version: number;
    event: "remote_scan.detected";
    scanID: string;
    detectedAtMs: number;
    sourceSystemID: number;
    targetSystemID: number;
    neighboringSystemID: number;
    mode: string;
    layers: string[];
  };
}

export interface RemoteScanQueueAction {
  actionID: string;
  actionObjectID: string;
  sourceAssemblyObjectID: string;
  targetAssemblyObjectID: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: number;
  priority: number;
  priorityFlags: number;
  payload: RemoteScanRequest;
}

interface LoadedRemoteAction {
  actionID: string;
  actionObjectID: string;
  sourceAssemblyObjectID: string;
  targetAssemblyObjectID: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: number;
  priority: number;
  priorityFlags: number;
  serverAction: boolean;
  payload: unknown;
}

function actionBinding(config: AssemblyConfig) {
  const action = requireFeaturePackage(config, "actionQueue");
  const access = requireFeaturePackage(config, "assemblyAccess");
  const legacy = action.packageId === access.packageId &&
    action.typeOrigin === access.typeOrigin && action.registryId === access.registryId;
  return legacy
    ? { feature: action, module: "assembly_access", object: "AssemblyAction", key: "AssemblyActionKey", perAssembly: false }
    : { feature: action, module: "action_queue", object: "Action", key: "ActionKey", perAssembly: true };
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().toLowerCase();
  throw new Error("Secure random action IDs are unavailable in this browser.");
}

function uuidBytes(value: string) {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized))
    throw new Error("The generated assembly action ID is invalid.");
  return Uint8Array.from(normalized.split("-").join("").match(/../g)!.map(
    (pair: string) => Number.parseInt(pair, 16),
  ));
}

function pureBytes(transaction: Transaction, value: Uint8Array) {
  return transaction.pure(bcs.vector(bcs.u8()).serialize([...value]).toBytes());
}

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return record.fields && typeof record.fields === "object" && !Array.isArray(record.fields)
    ? record.fields as Record<string, unknown> : record;
}

function fieldID(value: unknown): string {
  const record = fields(value);
  return requireObjectId(typeof value === "string" ? value : String(record.id || ""), "Action assembly ID");
}

function integer(value: unknown, label: string) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`${label} is invalid.`);
  return numeric;
}

function actionUuid(value: unknown) {
  const raw = bytes(value);
  if (raw.length !== 16) throw new Error("Action ID is invalid.");
  const hex = [...raw].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bytes(value: unknown) {
  if (typeof value === "string") return fromBase64(value);
  if (!Array.isArray(value) || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))
    throw new Error("Action bytes are invalid.");
  return Uint8Array.from(value as number[]);
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function claimedObjectIds(reader: Pick<SuiGrpcClient, "listDynamicFields">, parentId: string) {
  const claims = await listDynamicFields(reader, parentId);
  return claims.flatMap(field => {
    if (!field.name.type.includes("::") ||
        normalizeStructTag(field.name.type) !== normalizeStructTag("0x2::derived_object::Claimed")) return [];
    if (field.name.bcs.length !== 32) throw new Error("The action queue contains an invalid claimed object ID.");
    return [bcs.Address.parse(field.name.bcs)];
  });
}

async function loadRemoteActions(
  config: AssemblyConfig,
  assembly: AssemblySnapshot,
  actionType: string,
  reader: Pick<SuiGrpcClient, "getObjects" | "listDynamicFields">,
): Promise<LoadedRemoteAction[]> {
  if (assembly.kind !== "network_node") return [];
  const binding = actionBinding(config);
  const feature = binding.feature;
  const typeOrigin = requireObjectId(feature.typeOrigin, "Assembly action type origin");
  const targetID = requireObjectId(assembly.id, "Network Node ID");
  const registryId = requireObjectId(feature.registryId, "Action queue registry");
  const queueFor = (assemblyId: string) => binding.perAssembly
    ? deriveObjectID(registryId, `${typeOrigin}::action_queue::AssemblyQueueKey`,
        bcs.struct("AssemblyQueueKey", { assembly_id: bcs.Address })
          .serialize({ assembly_id: assemblyId }).toBytes())
    : registryId;
  const queues = new Map([[queueFor(targetID), targetID]]);
  if (binding.perAssembly && actionType === REMOTE_SCAN_ALERT_ACTION_TYPE) {
    // Incoming alerts live in the scanner's queue, not the recipient's queue.
    const roots = [...new Set(await claimedObjectIds(reader, registryId))];
    queues.clear();
    if (roots.length) {
      const { objects } = await reader.getObjects({ objectIds: roots, include: { json: true } });
      if (objects.length !== roots.length) throw new Error("The action queue registry could not be fully loaded.");
      for (const [index, object] of objects.entries()) {
        if (object instanceof Error || !object.json || object.type !== `${typeOrigin}::action_queue::AssemblyActionQueue`) continue;
        const value = fields(object.json);
        const sourceId = fieldID(value.assembly_id);
        if (object.objectId !== roots[index] || object.objectId !== queueFor(sourceId) || fieldID(value.registry_id) !== registryId)
          throw new Error("The action queue root does not match its registry and source assembly.");
        queues.set(object.objectId, sourceId);
      }
    }
  }
  // derived_object::claim records Claimed(ID) fields even though the actions
  // themselves are shared. These claims survive action state transitions.
  const candidates = new Map<string, string>();
  for (const queueId of queues.keys()) {
    for (const actionId of await claimedObjectIds(reader, queueId)) candidates.set(actionId, queueId);
  }
  if (!candidates.size) return [];
  const objectIds = [...candidates.keys()];
  const { objects } = await reader.getObjects({
    objectIds,
    include: { json: true },
  });
  const expectedType = `${typeOrigin}::${binding.module}::${binding.object}`;
  if (objects.length !== objectIds.length) throw new Error("The action queue could not be fully loaded.");
  const loaded = await Promise.all(objects.map(async (object, index) => {
    if (object instanceof Error || !object.json || object.type !== expectedType)
      return null;
    try {
      if (requireObjectId(object.objectId, "Scan action") !== objectIds[index])
        throw new Error("The action response does not match the requested object.");
      const value = fields(object.json);
      const queueId = candidates.get(object.objectId)!;
      const payloadBytes = bytes(value.payload);
      const commitment = bytes(value.payload_commitment);
      if (new TextDecoder().decode(bytes(value.action_type)) !== actionType ||
          fieldID(value.target_assembly_id) !== targetID ||
          fieldID(value.registry_id) !== registryId ||
          (binding.perAssembly && fieldID(value.queue_id) !== queueId) ||
          (binding.perAssembly && fieldID(value.source_assembly_id) !== queues.get(queueId)) ||
          commitment.length !== 32 ||
          !sameBytes(await sha256(payloadBytes), commitment)) return null;
      return {
        actionID: actionUuid(value.action_id),
        actionObjectID: requireObjectId(object.objectId, "Scan action"),
        sourceAssemblyObjectID: fieldID(value.source_assembly_id),
        targetAssemblyObjectID: fieldID(value.target_assembly_id),
        createdAtMs: integer(value.created_at_ms, "Action creation time"),
        expiresAtMs: integer(value.expires_at_ms, "Action expiry"),
        status: integer(value.status, "Action status"),
        priority: integer(value.priority, "Action priority"),
        priorityFlags: integer(value.priority_flags, "Action priority flags"),
        serverAction: value.server_action === true,
        payload: JSON.parse(new TextDecoder().decode(payloadBytes)),
      } satisfies LoadedRemoteAction;
    } catch {
      return null;
    }
  }));
  return loaded.filter((action): action is LoadedRemoteAction => action !== null)
    .sort((left, right) => right.createdAtMs - left.createdAtMs);
}

/** Read the same shared Sui actions that the server projects into its journal. */
export async function loadRemoteScanAlerts(
  config: AssemblyConfig,
  assembly: AssemblySnapshot,
  reader: Pick<SuiGrpcClient, "getObjects" | "listDynamicFields"> = createAssemblyClient(config),
): Promise<RemoteScanAlertAction[]> {
  const actions = await loadRemoteActions(
    config,
    assembly,
    REMOTE_SCAN_ALERT_ACTION_TYPE,
    reader,
  );
  return actions.flatMap(action => {
    const payload = action.payload as RemoteScanAlertAction["payload"];
    if (!action.serverAction || payload?.event !== "remote_scan.detected") return [];
    return [{ ...action, payload }];
  });
}

/** Recover owner-authored scan actions after a reload or local queue eviction. */
export async function loadRemoteScanQueueActions(
  config: AssemblyConfig,
  assembly: AssemblySnapshot,
  reader: Pick<SuiGrpcClient, "getObjects" | "listDynamicFields"> = createAssemblyClient(config),
): Promise<RemoteScanQueueAction[]> {
  const actions = await loadRemoteActions(config, assembly, REMOTE_SCAN_ACTION_TYPE, reader);
  return actions.flatMap(action => {
    const payload = action.payload as RemoteScanRequest;
    if (action.serverAction || action.sourceAssemblyObjectID !== action.targetAssemblyObjectID ||
        payload?.operationKey !== `sui-action/${action.actionID}` ||
        !Number.isSafeInteger(payload.targetSystemID) ||
        !Number.isSafeInteger(payload.rangeJumps) ||
        !["survey", "deep"].includes(payload.mode) || !Array.isArray(payload.layers)) return [];
    return [{ ...action, payload }];
  });
}

async function sha256(value: Uint8Array) {
  // Copy into a concrete ArrayBuffer so this remains compatible with the
  // browser BufferSource definition even when TypeScript models the input as
  // potentially backed by SharedArrayBuffer.
  const bytes = Uint8Array.from(value);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer));
}

export async function buildRemoteScanActionTransaction(
  config: AssemblyConfig,
  assembly: AssemblySnapshot,
  sender: string,
  input: Omit<RemoteScanRequest, "operationKey">,
  settings: { actionID?: string; now?: number } = {},
): Promise<QueuedChainAction> {
  if (assembly.kind !== "network_node")
    throw new Error("Remote scans must be queued from a Network Node.");
  if (requireObjectId(sender, "Connected wallet") !==
      requireObjectId(assembly.ownerAddress, "Network Node owner"))
    throw new Error("Connect the wallet that owns this Network Node.");
  const actionID = settings.actionID || uuid();
  const idBytes = uuidBytes(actionID);
  const payload: RemoteScanRequest = {
    operationKey: `sui-action/${actionID}`,
    targetSystemID: input.targetSystemID,
    mode: input.mode,
    rangeJumps: input.rangeJumps,
    layers: [...input.layers],
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const commitment = await sha256(payloadBytes);
  const typeBytes = new TextEncoder().encode(REMOTE_SCAN_ACTION_TYPE);
  const expiresAtMs = (settings.now ?? Date.now()) + ACTION_TTL_MS;
  const binding = actionBinding(config);
  const feature = binding.feature;
  const transaction = new Transaction();
  transaction.setSender(requireObjectId(sender, "Connected wallet"));
  const worldPackage = requireObjectId(config.packageId, "World package ID");
  const networkNodeType = `${worldTypeOrigin(config)}::network_node::NetworkNode`;
  const [ownerCap, receipt] = transaction.moveCall({
    target: `${worldPackage}::character::borrow_owner_cap`,
    typeArguments: [networkNodeType],
    arguments: [
      transaction.object(assembly.characterId),
      transaction.receivingRef(assembly.ownerCapRef),
    ],
  });
  const queueObjectID = binding.perAssembly
    ? deriveObjectID(
        requireObjectId(feature.registryId, "Action queue registry"),
        `${requireObjectId(feature.typeOrigin, "Action queue type origin")}::action_queue::AssemblyQueueKey`,
        bcs.struct("AssemblyQueueKey", { assembly_id: bcs.Address })
          .serialize({ assembly_id: requireObjectId(assembly.id, "Assembly object ID") })
          .toBytes(),
      )
    : requireObjectId(feature.registryId, "Assembly action registry");
  transaction.moveCall({
    target: packageTarget(feature, binding.module, "queue_action"),
    typeArguments: [networkNodeType],
    arguments: [
      transaction.object(queueObjectID),
      ...(binding.perAssembly ? [] : [transaction.pure.address(assembly.id)]),
      transaction.pure.address(assembly.id),
      ownerCap,
      pureBytes(transaction, idBytes),
      pureBytes(transaction, typeBytes),
      pureBytes(transaction, payloadBytes),
      pureBytes(transaction, commitment),
      transaction.pure.u64(ASSEMBLY_ACTION_PRIORITY.NORMAL),
      transaction.pure.u64(
        ASSEMBLY_ACTION_FLAG.PLAYER_INITIATED | ASSEMBLY_ACTION_FLAG.INTELLIGENCE,
      ),
      transaction.pure.u64(expiresAtMs),
      transaction.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  transaction.moveCall({
    target: `${worldPackage}::character::return_owner_cap`,
    typeArguments: [networkNodeType],
    arguments: [transaction.object(assembly.characterId), ownerCap, receipt],
  });
  const actionObjectID = deriveObjectID(
    queueObjectID,
    `${requireObjectId(feature.typeOrigin, "Assembly action type origin")}::${binding.module}::${binding.key}`,
    bcs.struct(binding.key, {
      action_id: bcs.vector(bcs.u8()),
    }).serialize({ action_id: [...idBytes] }).toBytes(),
  );
  return {
    actionID,
    actionObjectID: normalizeSuiAddress(actionObjectID),
    actionType: REMOTE_SCAN_ACTION_TYPE,
    payload,
    expiresAtMs,
    transaction,
  };
}
