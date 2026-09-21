import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import {
  createStorageClient,
  transferRequest,
  validateStorageDeployment,
} from "../storage/client.ts";
import type { SignedTransfer } from "../storage/client.ts";
import type { TaskDraft, TaskExecutionContext, TaskResult } from "./types.ts";

/** Revalidate the saved intent and retain its signed operation until the game confirms it. */
export async function executeStorageTask(
  task: TaskDraft,
  context: TaskExecutionContext,
): Promise<TaskResult> {
  const { operation, assembly } = task;
  const { config, wallet, assertCurrent, progress } = context;
  if (operation.kind !== "storage-transfer")
    throw new Error("This task is not a storage transfer.");
  if (config.network !== "localnet")
    throw new Error(
      "Storage transfers require the game's localnet deployment.",
    );
  const itemId = assembly.itemId || "";
  if (!/^[1-9]\d*$/.test(itemId) || !Number.isSafeInteger(Number(itemId)))
    throw new Error("The storage unit needs a valid game item ID.");

  // This key and payload are also read by StoragePanel's existing recovery UI.
  const recoveryKey = `storage-transfer:${config.network}:${assembly.id}:${wallet.address}`;
  function requireNoRecovery() {
    if (sessionStorage.getItem(recoveryKey) !== null)
      throw new Error(
        "Check the existing transfer in this storage unit before executing another transfer.",
      );
  }
  assertCurrent();
  requireNoRecovery();
  const api = createStorageClient((input, init) => {
    assertCurrent();
    return fetch(input, init);
  });
  const guardedWallet = {
    ...wallet,
    signTransaction: async (
      ...args: Parameters<typeof wallet.signTransaction>
    ) => {
      assertCurrent();
      const signed = await wallet.signTransaction(...args);
      assertCurrent();
      return signed;
    },
  };
  progress("Awaiting wallet approval for inventory access");
  const session = await api.authenticate(guardedWallet, config);
  assertCurrent();
  progress("Checking current cargo, storage, and capacity");
  const inventory = await api.inventory(itemId, session.token);
  assertCurrent();
  if (String(inventory.storageUnitID) !== itemId)
    throw new Error(
      "The server returned a different storage unit. Reload the dApp.",
    );
  validateStorageDeployment(config, assembly.id, inventory.deployment);
  if (
    inventory.chain.chain?.assemblyId &&
    normalizeSuiAddress(inventory.chain.chain.assemblyId) !==
      normalizeSuiAddress(assembly.id)
  )
    throw new Error(
      "The game's storage unit is linked to a different chain object. Check the server's deployment configuration.",
    );
  const transfer = transferRequest(
    inventory,
    operation.direction,
    operation.selected,
    operation.quantity,
  );
  requireNoRecovery();
  const prepared = await api.prepare(
    itemId,
    session.token,
    transfer,
    assembly.id,
  );
  assertCurrent();
  if (prepared.expiresAtMs <= Date.now())
    throw new Error(
      "The transfer authorization expired before signing. Queue a new transfer.",
    );
  requireNoRecovery();
  progress("Awaiting wallet approval for storage transfer");
  const signedBytes = await guardedWallet.signTransaction(
    Transaction.from(prepared.transactionData),
    config,
  );
  assertCurrent();
  requireNoRecovery();
  const signed: SignedTransfer = {
    direction: transfer.direction,
    transactionUUID: prepared.transactionUUID,
    ...signedBytes,
  };
  // If browser storage fails, stop before committing: the existing recovery UI
  // must be able to inspect an uncertain result using this exact authorization.
  sessionStorage.setItem(recoveryKey, JSON.stringify(signed));
  assertCurrent();
  progress("Committing transfer and synchronizing the chain");
  const result = await api.execute(itemId, session.token, signed);
  // Preserve a confirmed result even if the wallet disconnected during submission.
  // The queue checks the wallet again before it starts the next task.
  if (!result.gameCommitted)
    throw new Error(
      "The server did not confirm the game transfer. Check the existing transfer before starting another.",
    );
  let recoveryNote = "";
  try {
    sessionStorage.removeItem(recoveryKey);
  } catch {
    recoveryNote =
      " The saved operation could not be cleared; inspect it in the storage panel before another transfer.";
  }
  return {
    message:
      (result.chain.status === "synced"
        ? "Transfer confirmed in game and on chain."
        : `Transfer confirmed in game. Chain synchronization is ${result.chain.status}. Use Sync chain to check it; this does not move the items again.`) +
      recoveryNote,
    digest: result.chain.digest || signed.transactionUUID,
  };
}
