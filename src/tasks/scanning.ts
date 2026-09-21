import { loadAssembly } from "../assembly/client.ts";
import { createEnergyClient } from "../energy/client.ts";
import type { TaskDraft, TaskExecutionContext, TaskResult } from "./types.ts";

const api = createEnergyClient();

export async function executeRemoteScanTask(
  task: TaskDraft,
  context: TaskExecutionContext,
): Promise<TaskResult> {
  if (task.operation.kind !== "remote-scan")
    throw new Error("This task is not a remote scan action.");
  if (task.assembly.kind !== "network_node" || !task.assembly.itemId)
    throw new Error("Remote scans require a deployed Network Node.");
  const { config, wallet, assertCurrent, progress } = context;
  progress("Verifying the queued Sui scan action");
  const fresh = await loadAssembly(config, task.assembly.id);
  assertCurrent();
  if (fresh.kind !== "network_node" || fresh.itemId !== task.assembly.itemId ||
      fresh.ownerAddress !== task.assembly.ownerAddress)
    throw new Error("The queued Network Node identity or owner changed. Queue the scan again.");
  progress("Awaiting wallet approval for Network Node access");
  const session = await api.authenticate(wallet, config);
  assertCurrent();
  progress("Executing the blockchain-queued remote scan");
  const job = await api.startScan(task.assembly.itemId, session.token, {
    actionObjectID: task.operation.actionObjectID,
  });
  assertCurrent();
  try {
    sessionStorage.setItem(
      `evejs.remote-scan.latest:${task.assembly.itemId}:${wallet.address.toLowerCase()}`,
      job.scanID,
    );
  } catch {
    /* The durable Sui action and server scan remain authoritative. */
  }
  return {
    message: `Remote ${task.operation.request.mode} scan queued from Sui action ${task.operation.actionID}.`,
    remoteScanID: job.scanID,
  };
}
