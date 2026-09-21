import { normalizeSuiAddress } from "@mysten/sui/utils";
import { loadAssembly } from "../assembly/client.ts";
import { createIndustryClient, industryItemId, industryStartRequest, validateIndustryStatus, INDUSTRY_TRANSFER_MAX } from "../industry/client.ts";
import type { IndustrySession, IndustryStartRequest, IndustryStatus, IndustryStorageUnit, IndustryTransferRequest } from "../industry/client.ts";
import type { TaskDraft, TaskExecutionContext, TaskResult } from "./types.ts";

/** Capture recipe/job identity now; queued prerequisites may supply inputs or bring the facility online. */
export function queuedIndustryStartRequest(status: IndustryStatus, runs: string | null): IndustryStartRequest {
  validateIndustryStatus(status, industryItemId(status?.facility?.itemId));
  return industryStartRequest({
    ...status,
    facility: {
      ...status.facility,
      status: 2,
      snapshot: {
        ...status.facility.snapshot,
        inputs: status.facility.snapshot.blueprint_inputs.map(({ type_id, quantity }) => ({ type_id, quantity })),
        outputs: [],
      },
    },
  }, runs);
}

interface IndustryTaskDependencies {
  api: Pick<ReturnType<typeof createIndustryClient>, "authenticate" | "status" | "storage" | "start" | "transfer">;
  loadAssembly: typeof loadAssembly;
}

function checkStatus(task: TaskDraft, session: IndustrySession, status: IndustryStatus) {
  validateIndustryStatus(status, industryItemId(task.assembly.itemId || ""));
  if (status.facility.snapshot.owner_id !== String(session.characterID) ||
      (status.chain.assemblyObjectID && normalizeSuiAddress(status.chain.assemblyObjectID) !== normalizeSuiAddress(task.assembly.id)))
    throw new Error("The Industry status belongs to a different assembly or owner. Remove this task and reload the assembly.");
}

function checkTransfer(request: IndustryTransferRequest, status: IndustryStatus, units: IndustryStorageUnit[]) {
  const unit = units.find(entry => String(entry.storageUnitID) === request.storageUnitID);
  if (!unit) throw new Error("The queued storage unit is no longer accessible nearby. Check its range and online status.");
  if (!/^[1-9]\d*$/.test(request.quantity) || !Number.isSafeInteger(Number(request.quantity)) || Number(request.quantity) > INDUSTRY_TRANSFER_MAX)
    throw new Error("The queued transfer quantity must be a whole number from 1 to 4294967295.");
  const quantity = BigInt(request.quantity);
  const snapshot = status.facility.snapshot;
  if (request.direction === "deposit") {
    const slot = snapshot.blueprint_inputs.find(entry => entry.type_id === request.typeID);
    if (!slot) throw new Error("The facility's current blueprint does not accept the queued item type.");
    const available = unit.items.filter(item => String(item.typeID) === request.typeID)
      .reduce((sum, item) => sum + BigInt(item.quantity), 0n);
    if (available < quantity) throw new Error("The storage unit no longer has enough items for the queued transfer.");
    const stored = BigInt(snapshot.inputs.find(item => item.type_id === request.typeID)?.quantity || "0");
    if (stored + quantity > BigInt(slot.max_quantity)) throw new Error("The Industry input slot no longer has room for the queued transfer.");
  } else {
    const available = BigInt(snapshot[request.side].find(item => item.type_id === request.typeID)?.quantity || "0");
    if (available < quantity) throw new Error("The Industry inventory no longer has enough items for the queued transfer.");
  }
}

export async function executeIndustryTask(
  task: TaskDraft,
  context: TaskExecutionContext,
  dependencies: IndustryTaskDependencies = { api: createIndustryClient(), loadAssembly },
): Promise<TaskResult> {
  const { operation } = task;
  if (operation.kind !== "industry-start" && operation.kind !== "industry-transfer")
    throw new Error("This task is not an Industry operation.");
  const { config, wallet, assertCurrent, progress } = context;
  assertCurrent();
  if (config.network !== "localnet") throw new Error("Industry operations require the game's localnet deployment.");
  const itemID = industryItemId(task.assembly.itemId || "");
  progress("Authorizing Industry access…");
  // Authentication awaits a server challenge before signing, so check the session at that boundary too.
  const guardedWallet = {
    ...wallet,
    async signTransaction(...args: Parameters<typeof wallet.signTransaction>) {
      assertCurrent();
      const result = await wallet.signTransaction(...args);
      assertCurrent();
      return result;
    },
  };
  const session = await dependencies.api.authenticate(guardedWallet, config);
  assertCurrent();
  if (normalizeSuiAddress(session.walletAddress) !== normalizeSuiAddress(wallet.address))
    throw new Error("Industry access belongs to a different wallet. Reconnect before executing tasks.");
  progress("Checking the current facility, owner, and inventory…");
  const status = await dependencies.api.status(itemID, session.token);
  assertCurrent();
  checkStatus(task, session, status);
  if (operation.kind === "industry-transfer") {
    const storage = await dependencies.api.storage(itemID, session.token);
    assertCurrent();
    checkTransfer(operation.request, status, storage.storageUnits);
  } else {
    const fresh = industryStartRequest(status, operation.request.runs);
    if (fresh.blueprintID !== operation.request.blueprintID || fresh.blueprintHash !== operation.request.blueprintHash ||
        fresh.expectedJobID !== operation.request.expectedJobID)
      throw new Error("The facility's blueprint or production job changed after this task was queued. Review and queue production again.");
  }
  // Loading from the configured world revalidates the deployment and current chain owner before the write.
  const assembly = await dependencies.loadAssembly(config, task.assembly.id);
  assertCurrent();
  if (normalizeSuiAddress(assembly.id) !== normalizeSuiAddress(task.assembly.id) || assembly.itemId !== itemID ||
      assembly.kind !== task.assembly.kind || normalizeSuiAddress(assembly.ownerAddress) !== normalizeSuiAddress(wallet.address))
    throw new Error("The Industry assembly or its owner changed after this task was queued. Reload the assembly.");
  if (new Date(session.expiresAt).getTime() <= Date.now()) throw new Error("Industry access expired before this task could execute.");
  assertCurrent();
  if (operation.kind === "industry-start") {
    progress("Starting queued production…");
    const result = await dependencies.api.start(itemID, session.token, operation.request);
    // A wallet change cannot undo an already committed write. Keep its receipt;
    // the queue checks the active session again before starting another task.
    if (result.gameCommitted !== true) throw new Error("Production could not be confirmed. Check the facility before queueing it again.");
    checkStatus(task, session, result);
    const chain = result.chain.status === "synced" ? "The blockchain is synchronized."
      : result.chain.status === "disabled" ? "Blockchain synchronization is disabled on the server."
        : result.chain.status === "error" ? "Blockchain synchronization needs attention." : "Blockchain synchronization is pending.";
    return { message: `Job #${result.startedJobID} started on the server. ${chain}` };
  }
  progress("Moving queued Industry items…");
  const result = await dependencies.api.transfer(itemID, session.token, operation.request);
  if (result.gameCommitted !== true) throw new Error("The transfer could not be confirmed. Check both inventories before queueing it again.");
  const chain = result.chain.status === "synced" ? "Both blockchain inventories are synchronized."
    : result.chain.status === "disabled" ? "Blockchain synchronization is disabled on the server."
      : `Blockchain synchronization ${result.chain.status === "error" ? "needs attention" : "is pending"} (Industry: ${result.chain.industryStatus}; storage: ${result.chain.storageStatus}).`;
  return {
    message: `${BigInt(operation.request.quantity).toLocaleString()} items moved ${operation.request.direction === "deposit" ? "from storage to Industry inputs" : `from Industry ${operation.request.side} to storage`} on the server. ${chain}`,
    industryTransfer: result,
  };
}
