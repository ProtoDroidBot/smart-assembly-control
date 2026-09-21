import { requireObjectId } from "../assembly/config.ts";
import { loadAssembly } from "../assembly/client.ts";
import { createEnergyClient, energyItemId, gridConnectionBlockReason } from "../energy/client.ts";
import { createGateClient, gateItemId, gateLinkBlockReason } from "../gate/client.ts";
import type { GateStatus } from "../gate/client.ts";
import type { WalletSession } from "../wallet.ts";
import type { TaskDraft, TaskExecutionContext, TaskResult } from "./types.ts";

function checkGateObject(status: GateStatus, assemblyID: string) {
  if (status.chain.gateObjectID &&
      requireObjectId(status.chain.gateObjectID, "Gate chain object") !== requireObjectId(assemblyID, "Queued gate object"))
    throw new Error("This game gate is linked to a different chain object. Reload the assembly before queueing it again.");
}

interface InfrastructureTaskDependencies {
  loadAssembly: typeof loadAssembly;
}

/** Rebuild each action from current server state; no queued session or approval is reused. */
export async function executeInfrastructureTask(
  task: TaskDraft,
  context: TaskExecutionContext,
  dependencies: InfrastructureTaskDependencies = { loadAssembly },
): Promise<TaskResult> {
  const { config, wallet, assertCurrent, progress } = context;
  const { operation, assembly } = task;
  assertCurrent();
  if (config.network !== "localnet") throw new Error("Gate and energy tasks require the game's localnet deployment.");
  if (requireObjectId(assembly.ownerAddress, "Assembly owner") !== requireObjectId(wallet.address, "Connected wallet"))
    throw new Error("Connect the wallet that owns this queued assembly.");
  async function checkSource(sourceID: string, expiresAt: string | number) {
    // Game item IDs can be reused after a deployment reset. Read the queued
    // chain object from the configured world immediately before the mutation.
    const fresh = await dependencies.loadAssembly(config, assembly.id);
    assertCurrent();
    if (requireObjectId(fresh.id, "Current assembly object") !== requireObjectId(assembly.id, "Queued assembly object") ||
        fresh.itemId !== sourceID || fresh.kind !== assembly.kind ||
        requireObjectId(fresh.ownerAddress, "Current assembly owner") !== requireObjectId(wallet.address, "Connected wallet"))
      throw new Error("The queued assembly, game identity, or owner changed. Reload the assembly before queueing this task again.");
    if (new Date(expiresAt).getTime() <= Date.now())
      throw new Error("Access expired before this queued task could execute. Authorize the task again.");
  }
  const guardedWallet: WalletSession = {
    ...wallet,
    async signTransaction(transaction, settings) {
      assertCurrent();
      const signed = await wallet.signTransaction(transaction, settings);
      assertCurrent();
      return signed;
    },
  };
  if (operation.kind === "gate-link" || operation.kind === "gate-unlink") {
    if (assembly.kind !== "gate") throw new Error("This queued task requires a Smart Gate.");
    const sourceID = gateItemId(assembly.itemId || "");
    const targetID = Number(gateItemId(operation.targetID));
    if (sourceID === String(targetID)) throw new Error("A gate cannot link to itself.");
    const api = createGateClient();
    progress("Awaiting wallet approval for queued gate access");
    const session = await api.authenticate(guardedWallet, config);
    assertCurrent();
    progress("Checking current gate destinations");
    const status = await api.status(sourceID, session.token);
    assertCurrent();
    checkGateObject(status, assembly.id);
    if (operation.kind === "gate-link") {
      const target = status.candidates.find(candidate => candidate.itemID === targetID);
      if (!target) throw new Error("The queued destination is no longer an available owned gate. Refresh gate links.");
      const reason = gateLinkBlockReason(status, target);
      if (reason) throw new Error(reason);
    } else if (status.gate.destinationGateID !== targetID) {
      throw new Error("The gate destination changed since this unlink was queued. Refresh gate links before queueing it again.");
    }
    await checkSource(sourceID, session.expiresAt);
    assertCurrent();
    progress(operation.kind === "gate-link" ? "Linking queued gates" : "Unlinking queued gates");
    const result = operation.kind === "gate-link"
      ? await api.link(sourceID, session.token, targetID)
      : await api.unlink(sourceID, session.token, targetID);
    checkGateObject(result, assembly.id);
    if (operation.kind === "gate-link" ? result.gate.destinationGateID !== targetID : !!result.gate.destinationGateID)
      throw new Error("The server did not confirm the requested destination change. Refresh gate links before trying again.");
    const action = operation.kind === "gate-link" ? `Linked to gate #${targetID}` : `Unlinked from gate #${targetID}`;
    return { message: `${action} in game. ${result.chain.status === "synced" ? "The blockchain is synchronized." : `Blockchain synchronization is ${result.chain.status}; check gate status before dependent tasks.`}` };
  }
  if (operation.kind === "energy-connect" || operation.kind === "energy-disconnect") {
    if (assembly.kind !== "network_node") throw new Error("This queued task requires a Network Node.");
    const sourceID = energyItemId(assembly.itemId || "");
    const targetID = Number(energyItemId(operation.targetID));
    if (sourceID === String(targetID)) throw new Error("A network node cannot connect to itself.");
    const action = operation.kind === "energy-connect" ? "connect" : "disconnect";
    const api = createEnergyClient();
    progress("Awaiting wallet approval for queued energy grid access");
    const session = await api.authenticate(guardedWallet, config);
    assertCurrent();
    progress("Checking current energy connections");
    const status = await api.status(sourceID, session.token);
    assertCurrent();
    const connected = status.connectedAssemblies.find(candidate => candidate.itemID === targetID);
    if (action === "connect" && connected) throw new Error("The queued assembly is already connected to this node. Refresh the grid.");
    const target = action === "disconnect" ? connected : status.nearbyAssemblies.find(candidate => candidate.itemID === targetID);
    if (!target) throw new Error("The queued assembly is no longer available for this connection change. Refresh the grid.");
    const reason = gridConnectionBlockReason(target, action, status.networkNodeID);
    if (reason) throw new Error(reason);
    await checkSource(sourceID, session.expiresAt);
    assertCurrent();
    progress(`${action === "connect" ? "Connecting" : "Disconnecting"} queued assembly #${targetID}`);
    const result = await api[action](sourceID, session.token, targetID);
    const nowConnected = result.connectedAssemblies.some(candidate => candidate.itemID === targetID);
    if (nowConnected !== (action === "connect"))
      throw new Error("The server did not confirm the requested connection change. Refresh the grid before trying again.");
    return { message: `Assembly #${targetID} ${action === "connect" ? "connected to" : "disconnected from"} ${assembly.name}.` };
  }
  throw new Error("This task is not a gate or energy connection action.");
}
