import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { AssemblySnapshot } from "../assembly/types.ts";
import { INDUSTRY_TRANSFER_MAX, industryStartRequest, validateIndustryBlueprintExpectation, validateIndustryStatus } from "../industry/client.ts";
import type { IndustryBlueprint, IndustryItemStack, IndustryStatus, IndustryStorageItem, IndustryStorageUnit, IndustryTransferRequest } from "../industry/client.ts";
import type { QueuedTask } from "./queue.ts";

export interface IndustryQueueProjection {
  status: IndustryStatus;
  storageUnits: IndustryStorageUnit[] | null;
  pendingCount: number;
  error: string;
  productionQueued: boolean;
}

function sameAssembly(left: AssemblySnapshot, right: AssemblySnapshot) {
  try {
    return left.itemId === right.itemId && normalizeSuiAddress(left.id) === normalizeSuiAddress(right.id);
  } catch {
    return false;
  }
}

function quantity(value: string) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > INDUSTRY_TRANSFER_MAX)
    throw new Error("The queued transfer quantity must be a whole number from 1 to 4294967295. Remove it and queue it again.");
  return BigInt(value);
}

function adjustInventory(stacks: IndustryItemStack[], typeID: string, delta: bigint) {
  const existing = stacks.find(stack => stack.type_id === typeID);
  const total = BigInt(existing?.quantity ?? "0") + delta;
  if (total < 0n) throw new Error("The projected Industry inventory does not have enough items for this transfer.");
  if (total === 0n) return stacks.filter(stack => stack.type_id !== typeID);
  if (existing) existing.quantity = String(total);
  else stacks.push({ type_id: typeID, quantity: String(total) });
  return stacks;
}

function storageUnit(units: IndustryStorageUnit[] | null, id: string) {
  if (!units) throw new Error("Load nearby storage inventories to account for the queued inventory actions.");
  const unit = units.find(entry => String(entry.storageUnitID) === id);
  if (!unit) throw new Error("A queued storage unit is no longer accessible. Reload nearby storage or remove the task.");
  return unit;
}

function adjustStorage(unit: IndustryStorageUnit, typeID: string, delta: bigint,
  metadata: Map<string, IndustryStorageItem>, volumes: Map<number, number>) {
  const matching = unit.items.filter(item => String(item.typeID) === typeID);
  const total = matching.reduce((sum, item) => sum + BigInt(item.quantity), 0n);
  if (total + delta < 0n) throw new Error("The projected storage inventory does not have enough items for this transfer.");
  if (total + delta > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("The projected storage quantity is too large to represent. Remove this task and refresh storage.");
  const known = matching[0] ?? metadata.get(typeID);
  let volumeDelta = 0;
  if (delta > 0n) {
    volumeDelta = Number(delta) * (known?.unitVolume ?? 0);
    const projectedVolume = (volumes.get(unit.storageUnitID) ?? unit.usedVolume) + volumeDelta;
    if (projectedVolume > unit.capacity + 1e-9)
      throw new Error("The destination storage unit does not have room for the queued items. Free space or choose another storage unit.");
    if (matching.length) matching[0].quantity += Number(delta);
    else unit.items.push({ itemID: -Number(typeID), typeID: Number(typeID), name: known?.name ?? `Type #${typeID}`,
      quantity: Number(delta), unitVolume: known?.unitVolume ?? 0 });
  } else {
    let remaining = -delta;
    for (const item of matching) {
      const removed = remaining < BigInt(item.quantity) ? remaining : BigInt(item.quantity);
      item.quantity -= Number(removed);
      volumeDelta -= Number(removed) * item.unitVolume;
      remaining -= removed;
    }
    unit.items = unit.items.filter(item => item.quantity > 0);
  }
  // Keep the displayed volume authoritative: unknown item types have no reliable volume metadata.
  volumes.set(unit.storageUnitID, Math.max(0, (volumes.get(unit.storageUnitID) ?? unit.usedVolume) + volumeDelta));
}

function transfer(status: IndustryStatus, units: IndustryStorageUnit[] | null, request: IndustryTransferRequest,
  metadata: Map<string, IndustryStorageItem>, volumes: Map<number, number>) {
  if (!/^[1-9]\d*$/.test(request.typeID) || Number(request.typeID) > INDUSTRY_TRANSFER_MAX ||
      !["deposit", "withdraw"].includes(request.direction) || !["inputs", "outputs"].includes(request.side) ||
      (request.direction === "deposit" && request.side !== "inputs"))
    throw new Error("The queued inventory action has an invalid item or direction. Remove it and queue it again.");
  const amount = quantity(request.quantity);
  const unit = storageUnit(units, request.storageUnitID);
  const snapshot = status.facility.snapshot;
  if (request.direction === "deposit") {
    const slot = snapshot.blueprint_inputs.find(entry => entry.type_id === request.typeID);
    if (!slot) throw new Error("The projected blueprint does not accept this queued item. Reorder the blueprint change or remove and queue this transfer again.");
    const stored = BigInt(snapshot.inputs.find(item => item.type_id === request.typeID)?.quantity ?? "0");
    if (stored + amount > BigInt(slot.max_quantity))
      throw new Error("The projected Industry input slot does not have room for this transfer. Reduce the quantity or reorder the tasks.");
    adjustStorage(unit, request.typeID, -amount, metadata, volumes);
    snapshot.inputs = adjustInventory(snapshot.inputs, request.typeID, amount);
  } else {
    snapshot[request.side] = adjustInventory(snapshot[request.side], request.typeID, -amount);
    adjustStorage(unit, request.typeID, amount, metadata, volumes);
  }
}

function applyBlueprint(status: IndustryStatus, blueprint: IndustryBlueprint | undefined, blueprintID: string, blueprintHash: string) {
  const invalid = (): never => { throw new Error("The queued blueprint recipe is missing or inconsistent. Remove this blueprint change and queue it again from the available recipes."); };
  if (!blueprint || blueprint.blueprintID !== blueprintID || blueprint.blueprintHash !== blueprintHash ||
      !/^[1-9]\d*$/.test(blueprintID) || !Number.isSafeInteger(Number(blueprintID)) ||
      typeof blueprint.name !== "string" || !Array.isArray(blueprint.inputs) ||
      !Array.isArray(blueprint.outputs) || !/^[1-9]\d*$/.test(blueprint.runTime)) invalid();
  const selected = blueprint!;
  const snapshot = status.facility.snapshot;
  snapshot.blueprint_id = selected.blueprintID;
  snapshot.run_time = selected.runTime;
  snapshot.blueprint_inputs = structuredClone(selected.inputs);
  snapshot.blueprint_outputs = structuredClone(selected.outputs);
  status.blueprintHash = selected.blueprintHash;
  try {
    validateIndustryStatus(status, status.facility.itemId);
    if ([...snapshot.blueprint_inputs, ...snapshot.blueprint_outputs].some(slot => BigInt(slot.quantity) > BigInt(slot.max_quantity))) invalid();
  } catch {
    invalid();
  }
}

/** Replay this session's remaining Industry intents without modifying live data or captured requests. */
export function projectIndustryQueue(status: IndustryStatus, storageUnits: IndustryStorageUnit[] | null,
  tasks: readonly QueuedTask[], assembly: AssemblySnapshot, walletIdentity: object | null): IndustryQueueProjection {
  const pending = tasks.filter(task => walletIdentity !== null && task.walletIdentity === walletIdentity &&
    (task.status === "queued" || task.status === "running") && sameAssembly(task.assembly, assembly) &&
    ["industry-empty", "industry-blueprint", "industry-transfer", "industry-start"].includes(task.operation.kind));
  const result: IndustryQueueProjection = { status: structuredClone(status), storageUnits: structuredClone(storageUnits),
    pendingCount: pending.length, error: "", productionQueued: false };
  const metadata = new Map((storageUnits ?? []).flatMap(unit => unit.items.map(item => [String(item.typeID), item] as const)));
  let volumes = new Map((storageUnits ?? []).map(unit => [unit.storageUnitID, unit.usedVolume]));
  for (const task of pending) {
    // Each intent commits atomically to the projection, just like its execution on the server.
    const next = structuredClone(result.status);
    const units = structuredClone(result.storageUnits);
    const nextVolumes = new Map(volumes);
    try {
      const { operation } = task;
      const snapshot = next.facility.snapshot;
      if (operation.kind === "industry-empty" || operation.kind === "industry-blueprint") {
        if (result.productionQueued) throw new Error("A preceding production task creates a new job. Run it and refresh before emptying or changing the blueprint.");
        validateIndustryBlueprintExpectation(next, operation.request);
        if (operation.kind === "industry-empty") {
          const unit = storageUnit(units, operation.request.storageUnitID);
          const totals = new Map<string, bigint>();
          for (const stack of [...snapshot.inputs, ...snapshot.outputs])
            totals.set(stack.type_id, (totals.get(stack.type_id) ?? 0n) + BigInt(stack.quantity));
          for (const [typeID, amount] of totals) adjustStorage(unit, typeID, quantity(String(amount)), metadata, nextVolumes);
          snapshot.inputs = [];
          snapshot.outputs = [];
        } else {
          if (snapshot.inputs.length || snapshot.outputs.length)
            throw new Error("Empty all inputs and outputs before the queued blueprint change. Move an empty action before this task, or remove this change and queue the empty action first.");
          if (operation.request.blueprintID === snapshot.blueprint_id)
            throw new Error("This queued blueprint is already selected. Remove the redundant blueprint change.");
          applyBlueprint(next, operation.blueprint, operation.request.blueprintID, operation.request.blueprintHash);
        }
      } else if (operation.kind === "industry-transfer") {
        transfer(next, units, operation.request, metadata, nextVolumes);
      } else if (operation.kind === "industry-start") {
        if (result.productionQueued) throw new Error("A preceding production task creates a new job. Run it and refresh before queueing another production start.");
        // An assembly-state task may bring the facility online before production executes.
        const expected = industryStartRequest({ ...next, facility: { ...next.facility, status: 2 } }, operation.request.runs);
        if (expected.blueprintID !== operation.request.blueprintID || expected.blueprintHash !== operation.request.blueprintHash ||
            expected.expectedJobID !== operation.request.expectedJobID)
          throw new Error("The projected blueprint or production job differs from this queued start. Remove it and queue production again.");
        // Starting consumes one run immediately. Completion timing and the new job are resolved only by the server.
        for (const slot of snapshot.blueprint_inputs)
          snapshot.inputs = adjustInventory(snapshot.inputs, slot.type_id, -BigInt(slot.quantity));
        result.productionQueued = true;
      }
      result.status = next;
      result.storageUnits = units;
      volumes = nextVolumes;
    } catch (cause) {
      result.error = `Task #${task.id}: ${cause instanceof Error ? cause.message : String(cause)}`;
      break;
    }
  }
  return result;
}
