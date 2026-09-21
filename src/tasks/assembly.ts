import { buildAssemblyTransaction, loadAssembly, validateAssemblyAction } from "../assembly/index.ts";
import { adminItemId, adminOperationFinished, adminRecoveryKey, createAdminClient, validatePreparedAdminTransaction } from "../admin/client.ts";
import type { SignedAdminTransaction } from "../admin/client.ts";
import { TransactionSubmissionError } from "../wallet.ts";
import type { TaskDraft, TaskExecutionContext, TaskResult } from "./types.ts";

const api = createAdminClient();

export async function executeAssemblyTask(task: TaskDraft, context: TaskExecutionContext): Promise<TaskResult> {
  const { config, wallet, assertCurrent, progress } = context;
  const intent = task.operation;
  if (intent.kind !== "assembly-state") throw new Error("Unsupported assembly task.");
  assertCurrent();
  const key = adminRecoveryKey(config, task.assembly.id, wallet.address);
  if (config.network === "localnet" && sessionStorage.getItem(key))
    throw new Error("This assembly has an unresolved admin transaction. Open its controls and check the transaction before continuing.");
  progress("Checking current assembly state");
  const fresh = await loadAssembly(config, task.assembly.id);
  assertCurrent();
  if (fresh.kind !== task.assembly.kind || fresh.ownerAddress !== task.assembly.ownerAddress || fresh.itemId !== task.assembly.itemId)
    throw new Error("The assembly identity or owner changed. Remove this task and review the assembly again.");
  // A desired state already satisfied by an earlier task does not need another transaction.
  if (fresh.state === intent.action) return { message: `Assembly is already ${intent.action}; no transaction was needed.` };
  if (fresh.kind === "network_node" && intent.action === "offline") {
    const reviewed = new Set(intent.snapshot.connectedAssemblies.map(item => item.id));
    if (fresh.connectedAssemblies.some(item => !reviewed.has(item.id)))
      throw new Error("New assemblies connected to this node after queueing. Review its shutdown effects and queue the task again.");
  }
  validateAssemblyAction(config, fresh, intent.action, wallet.address);
  let operation: SignedAdminTransaction | undefined;
  try {
    let result: { digest: string };
    if (config.network === "localnet") {
      adminItemId(fresh, config);
      progress("Awaiting wallet approval for admin access");
      const session = await api.authenticate(wallet, config);
      assertCurrent();
      progress("Preparing the queued state change");
      const prepared = await api.prepare(fresh, config, session.token, intent.action);
      assertCurrent();
      const checked = await validatePreparedAdminTransaction(prepared, config, fresh, intent.action, wallet.address);
      assertCurrent();
      progress("Awaiting wallet approval; the server pays gas");
      const signed = await wallet.signTransaction(checked.transaction, config);
      assertCurrent();
      if (signed.bytes !== checked.bytes) throw new Error("The wallet changed the prepared transaction. Review the task again.");
      operation = { transactionUUID: prepared.transactionUUID, action: intent.action, assemblyID: adminItemId(fresh, config), assemblyObjectID: fresh.id, walletAddress: wallet.address, bytes: signed.bytes, signature: signed.signature, digest: checked.digest };
      sessionStorage.setItem(key, JSON.stringify(operation));
      progress("Confirming the queued state change");
      result = await api.execute(session.token, operation);
      sessionStorage.removeItem(key);
    } else {
      progress("Awaiting wallet approval and chain confirmation");
      result = await wallet.signAndExecute(buildAssemblyTransaction(config, fresh, intent.action, wallet.address), config);
    }
    return { message: `Assembly brought ${intent.action}.`, digest: result.digest };
  } catch (cause) {
    if (operation && adminOperationFinished(cause)) sessionStorage.removeItem(key);
    const digest = operation?.digest || (cause instanceof TransactionSubmissionError ? cause.digest : "");
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${detail}${digest ? ` Transaction: ${digest}. Check its result before another state change.` : ""}`);
  }
}
