import { normalizeSuiAddress } from "@mysten/sui/utils";
import { loadAssembly } from "../assembly/client.ts";
import { createIndustryClient, industryItemId, validateIndustryBlueprintExpectation, validateIndustryStatus } from "../industry/client.ts";
import type { TaskDraft, TaskExecutionContext, TaskResult } from "./types.ts";

interface Dependencies {
  api: Pick<ReturnType<typeof createIndustryClient>, "authenticate" | "status" | "storage" | "blueprints" | "changeBlueprint" | "emptyBlueprint">;
  loadAssembly: typeof loadAssembly;
}

export async function executeIndustryBlueprintTask(task: TaskDraft, context: TaskExecutionContext,
  dependencies: Dependencies = { api: createIndustryClient(), loadAssembly }): Promise<TaskResult> {
  const { operation, assembly } = task;
  if (operation.kind !== "industry-empty" && operation.kind !== "industry-blueprint") throw new Error("This is not a blueprint task.");
  const { config, wallet, assertCurrent, progress } = context;
  assertCurrent();
  if (config.network !== "localnet") throw new Error("Blueprint operations require the game's localnet deployment.");
  const itemID = industryItemId(assembly.itemId || "");
  const guardedWallet = { ...wallet, async signTransaction(...args: Parameters<typeof wallet.signTransaction>) {
    assertCurrent();
    const signed = await wallet.signTransaction(...args);
    assertCurrent();
    return signed;
  } };
  progress("Authorizing Industry access");
  const session = await dependencies.api.authenticate(guardedWallet, config);
  assertCurrent();
  if (normalizeSuiAddress(session.walletAddress) !== normalizeSuiAddress(wallet.address)) throw new Error("Industry access belongs to a different wallet.");
  progress("Checking the active blueprint and production");
  const status = await dependencies.api.status(itemID, session.token);
  assertCurrent();
  validateIndustryStatus(status, itemID);
  if (status.facility.snapshot.owner_id !== String(session.characterID) ||
      (status.chain.assemblyObjectID && normalizeSuiAddress(status.chain.assemblyObjectID) !== normalizeSuiAddress(assembly.id)))
    throw new Error("The Industry status belongs to a different assembly or owner.");
  validateIndustryBlueprintExpectation(status, operation.request);
  if (operation.kind === "industry-blueprint") {
    if (status.facility.snapshot.inputs.length || status.facility.snapshot.outputs.length)
      throw new Error("Empty all inputs and outputs before changing the active blueprint. Queue Empty active blueprint before this task.");
    const catalog = await dependencies.api.blueprints(itemID, session.token);
    assertCurrent();
    const target = catalog.blueprints.find(blueprint => blueprint.blueprintID === operation.request.blueprintID);
    if (!target || target.blueprintHash !== operation.request.blueprintHash)
      throw new Error("The selected blueprint is no longer available or its recipe changed. Load available blueprints and queue it again.");
  } else {
    const storage = await dependencies.api.storage(itemID, session.token);
    assertCurrent();
    if (!storage.storageUnits.some(unit => String(unit.storageUnitID) === operation.request.storageUnitID))
      throw new Error("The destination storage unit is no longer accessible nearby. Check its range and online state.");
  }
  const fresh = await dependencies.loadAssembly(config, assembly.id);
  assertCurrent();
  if (normalizeSuiAddress(fresh.id) !== normalizeSuiAddress(assembly.id) || fresh.itemId !== itemID || fresh.kind !== assembly.kind ||
      normalizeSuiAddress(fresh.ownerAddress) !== normalizeSuiAddress(wallet.address))
    throw new Error("The Industry assembly or its owner changed. Reload the assembly before continuing.");
  if (new Date(session.expiresAt).getTime() <= Date.now()) throw new Error("Industry access expired before this task could execute.");
  assertCurrent();
  if (operation.kind === "industry-blueprint") {
    progress("Changing the active blueprint");
    const result = await dependencies.api.changeBlueprint(itemID, session.token, operation.request);
    if (result.gameCommitted !== true) throw new Error("The blueprint change could not be confirmed. Refresh before trying again.");
    return { message: `Blueprint #${result.selectedBlueprintID} selected. Blockchain synchronization is ${result.chain.status}.` };
  }
  progress("Moving all blueprint inputs and outputs to storage");
  const result = await dependencies.api.emptyBlueprint(itemID, session.token, operation.request);
  if (result.gameCommitted !== true) throw new Error("Emptying could not be confirmed. Check both inventories before trying again.");
  const total = [...Object.values(result.inputs), ...Object.values(result.outputs)].reduce((sum, quantity) => sum + BigInt(quantity), 0n);
  return { message: `Moved all ${total.toLocaleString()} input and output items to storage #${result.storageUnitID}. Blockchain synchronization is ${result.chain.status}.`,
    industryTransfer: result };
}
