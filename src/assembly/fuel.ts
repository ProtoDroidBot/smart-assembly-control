import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { SuiClientTypes } from "@mysten/sui/client";
import { bcs } from "@mysten/sui/bcs";
import { normalizeStructTag } from "@mysten/sui/utils";
import { assemblyKind, createAssemblyClient } from "./client.ts";
import { requireObjectId, worldTypeOrigin } from "./config.ts";
import { listDynamicFields } from "./dynamic-fields.ts";
import type { AssemblyConfig } from "./types.ts";

export interface NetworkNodeFuelSnapshot {
  typeId: string | null;
  quantity: string;
  isBurning: boolean;
  burnRateMs: string;
  efficiency: string | null;
  previousCycleElapsedMs: string;
  burnStartTimeMs: string;
  chainNowMs: string;
  observedAtMs: number;
}

export interface FuelProjection {
  typeId: string | null;
  typeName: string;
  state: "burning" | "paused" | "empty" | "unavailable";
  remainingUnitMs: number | null;
  unitDurationMs: number | null;
}

export type FuelReader = Pick<SuiGrpcClient, "getObject" | "getDynamicField" | "listDynamicFields">;
const U64_MAX = (1n << 64n) - 1n;
const CLOCK_ID = requireObjectId("0x6", "Clock ID");
const INCLUDE = { json: true } as const;

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  return object.fields ? fields(object.fields) : object;
}

function u64(value: unknown, label: string): bigint {
  if ((typeof value !== "string" || !/^\d+$/.test(value)) &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0))
    throw new Error(`${label} is not an unsigned 64-bit integer.`);
  const integer = BigInt(value as string | number);
  if (integer > U64_MAX) throw new Error(`${label} exceeds the unsigned 64-bit range.`);
  return integer;
}

function fuelType(value: unknown): string | null {
  if (value === null) return null;
  const contents = typeof value === "string" || typeof value === "number"
    ? [value]
    : Array.isArray(value) ? value : fields(value).vec;
  if (!Array.isArray(contents) || contents.length > 1)
    throw new Error("The fuel type could not be read from the network node.");
  if (!contents.length) return null;
  const typeId = u64(contents[0], "Fuel type");
  if (typeId === 0n) throw new Error("The network node has an invalid fuel type.");
  return String(typeId);
}

function moveObject(response: SuiClientTypes.GetObjectResponse<typeof INCLUDE>, label: string, expectedId?: string) {
  if (!response.object?.json || !response.object.type?.includes("::"))
    throw new Error(`${label} could not be read from this Sui network.`);
  if (expectedId && requireObjectId(response.object.objectId, label) !== expectedId)
    throw new Error(`${label} response does not match the requested object.`);
  return { values: fields(response.object.json), type: response.object.type };
}

/** Public chain reads require no wallet approval or energy-grid session. */
export async function loadNetworkNodeFuel(
  config: AssemblyConfig,
  assemblyId: string,
  reader: FuelReader = createAssemblyClient(config),
): Promise<NetworkNodeFuelSnapshot> {
  const nodeId = requireObjectId(assemblyId, "Network node ID");
  const [nodeResponse, clock] = await Promise.all([
    reader.getObject({ objectId: nodeId, include: INCLUDE }),
    reader.getObject({ objectId: CLOCK_ID, include: INCLUDE }).then(response => ({ response, observedAtMs: Date.now() })),
  ]);
  const node = moveObject(nodeResponse, "Network node", nodeId);
  if (assemblyKind(node.type, config) !== "network_node")
    throw new Error("Fuel monitoring requires a NetworkNode.");
  const clockObject = moveObject(clock.response, "Chain clock", CLOCK_ID);
  if (normalizeStructTag(clockObject.type) !== normalizeStructTag("0x2::clock::Clock"))
    throw new Error("The chain clock has an unexpected object type.");
  const fuel = fields(node.values.fuel);
  const typeId = fuelType(fuel.type_id);
  const quantity = u64(fuel.quantity, "Fuel quantity");
  if (typeof fuel.is_burning !== "boolean" || (!typeId && (quantity > 0n || fuel.is_burning)))
    throw new Error("The network node returned incomplete fuel readings.");
  const snapshot: NetworkNodeFuelSnapshot = {
    typeId,
    quantity: String(quantity),
    isBurning: fuel.is_burning,
    burnRateMs: String(u64(fuel.burn_rate_in_ms, "Fuel burn interval")),
    efficiency: null,
    previousCycleElapsedMs: String(u64(fuel.previous_cycle_elapsed_time, "Previous fuel cycle")),
    burnStartTimeMs: String(u64(fuel.burn_start_time, "Fuel burn start")),
    chainNowMs: String(u64(clockObject.values.timestamp_ms, "Chain time")),
    observedAtMs: clock.observedAtMs,
  };
  if (!typeId) return snapshot;

  const configId = requireObjectId(config.fuelConfigId, "Fuel Config ID");
  const fuelConfig = moveObject(await reader.getObject({ objectId: configId, include: INCLUDE }), "Fuel configuration", configId);
  const packageId = worldTypeOrigin(config);
  if (normalizeStructTag(fuelConfig.type) !== `${packageId}::fuel::FuelConfig`)
    throw new Error("The fuel configuration belongs to a different world deployment.");
  const tableUid = fields(fuelConfig.values.fuel_efficiency).id;
  const tableId = requireObjectId(typeof tableUid === "string" ? tableUid : fields(tableUid).id as string, "Fuel efficiency table ID");
  const entries = await listDynamicFields(reader, tableId);
  const matching = entries.filter(entry => entry.name.type === "u64" &&
    entry.name.bcs.length === 8 && bcs.u64().parse(entry.name.bcs) === typeId);
  // An absent efficiency entry makes the timer unavailable; transport failures remain errors.
  if (!matching.length) return snapshot;
  if (matching.length !== 1) throw new Error("The fuel efficiency table contains duplicate fuel types.");
  const { dynamicField } = await reader.getDynamicField({
    parentId: tableId, name: { type: "u64", bcs: bcs.u64().serialize(typeId).toBytes() },
  });
  if (dynamicField.fieldId !== matching[0].fieldId ||
      normalizeStructTag(dynamicField.type) !== normalizeStructTag("0x2::dynamic_field::Field<u64,u64>") ||
      dynamicField.name.type !== "u64" || dynamicField.name.bcs.length !== 8 ||
      bcs.u64().parse(dynamicField.name.bcs) !== typeId ||
      dynamicField.value.type !== "u64" || dynamicField.value.bcs.length !== 8)
    throw new Error("The fuel efficiency response does not match the current fuel type.");
  const efficiency = u64(bcs.u64().parse(dynamicField.value.bcs), "Fuel efficiency");
  if (efficiency === 0n || efficiency > 100n)
    throw new Error("The current fuel efficiency is outside the supported range.");
  snapshot.efficiency = String(efficiency);
  return snapshot;
}

export function fuelTypeName(typeId: string | null): string {
  if (!typeId) return "No fuel";
  const names: Record<string, string> = {
    "77818": "Unstable Fuel",
    "88319": "D2 Fuel",
    "88335": "D1 Fuel",
  };
  return names[typeId] || `Fuel type ${typeId}`;
}

/** Mirror fuel.move's clock arithmetic without mutating confirmed fuel quantities. */
export function projectFuel(snapshot: NetworkNodeFuelSnapshot, elapsedSinceObservationMs = 0): FuelProjection {
  const result: FuelProjection = {
    typeId: snapshot.typeId,
    typeName: fuelTypeName(snapshot.typeId),
    state: "unavailable",
    remainingUnitMs: null,
    unitDurationMs: null,
  };
  const empty = (): FuelProjection => ({ ...result, typeId: null, typeName: fuelTypeName(null), state: "empty", remainingUnitMs: 0 });
  try {
    const quantity = u64(snapshot.quantity, "Fuel quantity");
    const previous = u64(snapshot.previousCycleElapsedMs, "Previous fuel cycle");
    if (!snapshot.isBurning && quantity === 0n && previous === 0n) return empty();
    if (!snapshot.typeId || !snapshot.efficiency) return result;
    const efficiency = u64(snapshot.efficiency, "Fuel efficiency");
    const duration = u64(snapshot.burnRateMs, "Fuel burn interval") * efficiency / 100n;
    if (efficiency === 0n || efficiency > 100n || duration === 0n || duration > BigInt(Number.MAX_SAFE_INTEGER)) return result;
    result.unitDurationMs = Number(duration);
    if (!snapshot.isBurning) return { ...result, state: "paused", remainingUnitMs: Number(duration - previous % duration) };
    const start = u64(snapshot.burnStartTimeMs, "Fuel burn start");
    if (start === 0n || !Number.isFinite(elapsedSinceObservationMs) ||
        Math.abs(elapsedSinceObservationMs) > Number.MAX_SAFE_INTEGER) return result;
    const now = u64(snapshot.chainNowMs, "Chain time") + BigInt(Math.floor(Math.max(0, elapsedSinceObservationMs)));
    const elapsed = (now > start ? now - start : 0n) + previous;
    // start_burning already deducted the active unit. Zero reserve still has
    // one unit burning, and each subsequent boundary consumes another reserve.
    if (elapsed / duration > quantity) return empty();
    return { ...result, state: "burning", remainingUnitMs: Number(duration - elapsed % duration) };
  } catch {
    return result;
  }
}
