import { useEffect, useRef, useState } from "react";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { AssemblyConfig, AssemblySnapshot } from "../assembly/types.ts";
import type { WalletSession } from "../wallet.ts";
import type { EnqueueTask } from "../tasks/types.ts";
import {
  isPlaceholderTypeName,
  useLocalizedTypeNames,
  type LocalizedTypeName,
} from "../localization/type-names.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import {
  createStorageClient,
  StorageApiError,
  transferRequest,
  validateStorageDeployment,
} from "../storage/client.ts";
import type {
  ChainStorageStatus,
  PreparedTransfer,
  SignedTransfer,
  StorageDirection,
  StorageInventory,
  StorageSession,
  TransferRequest,
  TransferResult,
} from "../storage/client.ts";

const api = createStorageClient();
const volume = (amount: number) =>
  amount.toLocaleString(undefined, { maximumFractionDigits: 3 });
const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function micros(value: string) {
  try {
    const amount = BigInt(value);
    return `${amount / 1000000n}${
      amount % 1000000n
        ? `.${String(amount % 1000000n)
            .padStart(6, "0")
            .replace(/0+$/, "")}`
        : ""
    }`;
  } catch {
    return "Unavailable";
  }
}

function ChainInventory({
  state,
  characterID,
  typeName,
}: {
  state: ChainStorageStatus;
  characterID: number;
  typeName: LocalizedTypeName;
}) {
  const partition = state.chain?.partitions.find(
    (entry) => String(entry.characterId) === String(characterID),
  );
  return (
    <div className="storage-chain">
      <div className="storage-heading">
        <h3>On-chain storage</h3>
        <span
          className={`state ${state.status === "synced" ? "online" : "unknown"}`}
        >
          {state.status.toUpperCase()}
        </span>
      </div>
      <p>
        {state.status === "synced"
          ? "The chain inventory matches the game inventory."
          : state.status === "disabled"
            ? "On-chain synchronization is disabled on the server. Transfers currently update the game inventory only."
            : state.status === "pending"
              ? "The game inventory is awaiting on-chain synchronization."
              : "On-chain synchronization needs attention."}
      </p>
      {state.error && <p role="alert">{state.error}</p>}
      {state.chain && (
        <p className="storage-object">
          Storage object <code>{state.chain.assemblyId}</code>
        </p>
      )}
      {partition && (
        <>
          <p>
            {micros(partition.usedCapacity)} / {micros(partition.maxCapacity)}{" "}
            m³ on chain
          </p>
          {partition.items.length ? (
            <div className="inventory-scroll">
              <table className="inventory-table">
                <caption>
                  Confirmed on-chain inventory for character {characterID}
                </caption>
                <thead>
                  <tr>
                    <th>Item type</th>
                    <th>Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {partition.items.map((item) => (
                    <tr key={`${item.itemId}-${item.typeId}`}>
                      <td>
                        {typeName(item.typeId)}
                        <small>Type {item.typeId}</small>
                      </td>
                      <td>{item.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No items recorded in this on-chain inventory.</p>
          )}
        </>
      )}
      {state.digest && (
        <p>
          Transaction <code>{state.digest}</code>
        </p>
      )}
    </div>
  );
}

interface Props {
  assembly: AssemblySnapshot;
  config: AssemblyConfig;
  wallet: WalletSession | null;
  disabled: boolean;
  onBusyChange: (busy: string) => void;
  onQueueTask?: EnqueueTask;
  onActivity: (activity: {
    time: string;
    title: string;
    digest: string;
    failed?: boolean;
  }) => void;
}

export function StoragePanel({
  assembly,
  config,
  wallet,
  disabled,
  onBusyChange,
  onActivity,
  onQueueTask,
}: Props) {
  const [session, setSession] = useState<StorageSession | null>(null);
  const [inventory, setInventory] = useState<StorageInventory | null>(null);
  const [direction, setDirection] = useState<StorageDirection>("deposit");
  const [selected, setSelected] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [review, setReview] = useState<{
    prepared: PreparedTransfer;
    transfer: TransferRequest;
  } | null>(null);
  const [recovery, setRecovery] = useState<SignedTransfer | null>(null);
  const [inspectedRecovery, setInspectedRecovery] = useState(false);
  const active = useRef({ wallet, assemblyId: assembly.id, mounted: true });
  active.current.wallet = wallet;
  active.current.assemblyId = assembly.id;
  const locked = useRef(false);
  const itemId = assembly.itemId || "";
  const recoveryKey = `storage-transfer:${config.network}:${assembly.id}:${wallet?.address || ""}`;
  const typeName = useLocalizedTypeNames(
    [
      ...(inventory?.items ?? []).map((item) => item.typeID),
      ...(inventory?.cargo.items ?? []).map((item) => item.typeID),
      ...(inventory?.chain.chain?.partitions ?? []).flatMap((partition) =>
        partition.items.map((item) => item.typeId),
      ),
    ],
    assembly.tenant || config.defaultTenant,
  );

  useEffect(() => {
    active.current.mounted = true;
    const context = active.current;
    return () => {
      context.mounted = false;
    };
  }, []);
  useEffect(() => {
    setSession(null);
    setInventory(null);
    setReview(null);
    setSelected("");
    setError("");
    setNotice("");
    setInspectedRecovery(false);
    try {
      const saved = sessionStorage.getItem(recoveryKey);
      const pending: unknown = saved ? JSON.parse(saved) : null;
      if (
        pending &&
        typeof pending === "object" &&
        "transactionUUID" in pending &&
        "direction" in pending &&
        "signature" in pending &&
        "bytes" in pending &&
        typeof pending.transactionUUID === "string" &&
        typeof pending.signature === "string" &&
        typeof pending.bytes === "string" &&
        (pending.direction === "deposit" || pending.direction === "withdraw")
      )
        setRecovery(pending as SignedTransfer);
      else setRecovery(null);
    } catch {
      setRecovery(null);
    }
  }, [wallet, assembly.id, recoveryKey]);

  function current() {
    return (
      active.current.mounted &&
      active.current.wallet === wallet &&
      active.current.assemblyId === assembly.id
    );
  }
  function progress(label: string) {
    setBusy(label);
    onBusyChange(label);
  }
  async function access() {
    if (config.network !== "localnet")
      throw new Error(
        "Storage transfers require the game's localnet deployment. Reload this dApp from the local game server.",
      );
    if (!wallet)
      throw new Error("Connect the wallet for your logged-in game character.");
    if (session && new Date(session.expiresAt).getTime() > Date.now() + 5000)
      return session;
    progress("Awaiting wallet approval for inventory access");
    const next = await api.authenticate(wallet, config);
    if (!current())
      throw new Error("The wallet or assembly changed. Reload inventory.");
    setSession(next);
    return next;
  }
  async function read(token: string) {
    const next = await api.inventory(itemId, token);
    if (!current()) return next;
    if (String(next.storageUnitID) !== itemId)
      throw new Error(
        "The server returned a different storage unit. Reload the dApp.",
      );
    validateStorageDeployment(config, assembly.id, next.deployment);
    if (
      next.chain.chain?.assemblyId &&
      normalizeSuiAddress(next.chain.chain.assemblyId) !==
        normalizeSuiAddress(assembly.id)
    )
      throw new Error(
        "The game's storage unit is linked to a different chain object. Check the server's deployment configuration.",
      );
    setInventory(next);
    setInspectedRecovery(false);
    setStale(false);
    return next;
  }
  async function run(label: string, operation: () => Promise<void>) {
    if (locked.current || disabled || !wallet || !itemId) return;
    locked.current = true;
    progress(label);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      if (current()) {
        setError(describe(cause));
        setStale(true);
        if (cause instanceof StorageApiError && cause.status === 401)
          setSession(null);
      }
    } finally {
      locked.current = false;
      if (active.current.mounted) {
        setBusy("");
        onBusyChange("");
      }
    }
  }
  async function load() {
    await run("Loading cargo and storage", async () => {
      const authorized = await access();
      progress("Reading cargo and storage inventories");
      await read(authorized.token);
    });
  }
  async function prepare() {
    if (!inventory || recovery) return;
    await run("Checking transfer and capacity", async () => {
      const authorized = await access();
      const fresh = await read(authorized.token);
      if (!current()) return;
      const transfer = transferRequest(
        fresh,
        direction,
        Number(selected),
        quantity,
      );
      const prepared = await api.prepare(
        itemId,
        authorized.token,
        transfer,
        assembly.id,
      );
      if (current()) setReview({ prepared, transfer });
    });
  }
  function queueTransfer() {
    if (!canTransfer || !inventory || !chosen || !onQueueTask) return;
    setError("");
    setNotice("");
    try {
      const transfer = transferRequest(
        inventory,
        direction,
        Number(selected),
        quantity,
      );
      const stack = transfer.stacks[0];
      onQueueTask({
        title: direction === "deposit" ? "Deposit items" : "Withdraw items",
        details: `${stack.quantity.toLocaleString()} × ${typeName(chosen.typeID, chosen.typeName)} · ${direction === "deposit" ? `cargo stack ${chosen.itemID} → storage` : "storage → cargo"}`,
        assembly,
        operation: {
          kind: "storage-transfer",
          direction: transfer.direction,
          selected: Number(
            direction === "deposit" ? stack.itemID : stack.typeID,
          ),
          quantity: String(stack.quantity),
        },
      });
      setNotice(
        "Transfer added to the task queue. Inventory will be checked again when it runs.",
      );
    } catch (cause) {
      setError(describe(cause));
    }
  }
  async function completed(
    result: TransferResult,
    signed: SignedTransfer,
    token: string,
  ) {
    if (!result.gameCommitted)
      throw new Error(
        "The server did not confirm the game transfer. Check this operation before retrying.",
      );
    onActivity({
      time: new Date().toLocaleTimeString(),
      title: `${signed.direction === "deposit" ? "Added items to" : "Removed items from"} storage · chain ${result.chain.status}`,
      digest: result.chain.digest || signed.transactionUUID,
      failed: result.chain.status === "error",
    });
    if (!current()) return;
    setRecovery(null);
    try {
      sessionStorage.removeItem(recoveryKey);
    } catch {
      /* The confirmed result is still shown if storage is unavailable. */
    }
    setReview(null);
    setSelected("");
    setQuantity("1");
    setNotice(
      result.chain.status === "synced"
        ? "Transfer confirmed in game and on chain."
        : `Transfer confirmed in game. Chain synchronization is ${result.chain.status}. Use Sync chain to check it; this does not move the items again.`,
    );
    try {
      await read(token);
    } catch (cause) {
      setStale(true);
      setError(
        `The transfer committed, but inventory refresh failed. ${describe(cause)}`,
      );
    }
  }
  async function execute() {
    if (!review || !wallet || recovery) return;
    await run("Awaiting wallet approval for storage transfer", async () => {
      if (review.prepared.expiresAtMs <= Date.now()) {
        setReview(null);
        throw new Error(
          "This transfer review expired. Review the transfer again.",
        );
      }
      const authorized = await access();
      const signedBytes = await wallet.signTransaction(
        Transaction.from(review.prepared.transactionData),
        config,
      );
      if (!current()) return;
      const signed: SignedTransfer = {
        direction: review.transfer.direction,
        transactionUUID: review.prepared.transactionUUID,
        ...signedBytes,
      };
      // Retain the same signed operation until its outcome is known; never repeat the transfer with a new UUID.
      setRecovery(signed);
      setInspectedRecovery(false);
      try {
        sessionStorage.setItem(recoveryKey, JSON.stringify(signed));
      } catch {
        /* Keep recovery in memory when browser storage is unavailable. */
      }
      setReview(null);
      progress("Committing transfer and synchronizing the chain");
      const result = await api.execute(itemId, authorized.token, signed);
      await completed(result, signed, authorized.token);
    });
  }
  async function checkExisting() {
    if (!recovery) return;
    await run("Checking the existing transfer", async () => {
      const authorized = await access();
      let result: TransferResult;
      try {
        result = await api.execute(itemId, authorized.token, recovery);
      } catch (cause) {
        if (
          cause instanceof StorageApiError &&
          /(?:TRANSACTION|OPERATION).*(?:NOT_FOUND|EXPIRED)|(?:INVALID|EXPIRED)_TRANSACTION/.test(
            cause.code,
          )
        )
          throw new Error(
            "The server no longer recognizes this transfer authorization. Refresh inventory, inspect the cargo and storage totals, then dismiss this operation only after you have verified its result.",
          );
        throw cause;
      }
      await completed(result, recovery, authorized.token);
    });
  }
  function dismissInspectedTransfer() {
    if (!inspectedRecovery || stale || !inventory || busy) return;
    try {
      sessionStorage.removeItem(recoveryKey);
    } catch {
      /* The local recovery state can still be cleared. */
    }
    setRecovery(null);
    setInspectedRecovery(false);
    setNotice(
      "The inspected operation was dismissed. No items were moved by dismissing it.",
    );
  }
  async function sync() {
    await run("Synchronizing storage with the chain", async () => {
      const authorized = await access();
      const result = await api.sync(itemId, authorized.token);
      if (!current()) return;
      await read(authorized.token);
      if (result.status !== "synced")
        throw new Error(
          result.error ||
            `Chain synchronization is ${result.status}. The game inventory is unchanged by this check.`,
        );
      setNotice("Game and chain storage inventories are synchronized.");
    });
  }

  const items = inventory
    ? direction === "deposit"
      ? inventory.cargo.items.filter((item) => !item.singleton)
      : inventory.items
    : [];
  const chosen = items.find(
    (item) =>
      String(direction === "deposit" ? item.itemID : item.typeID) === selected,
  );
  const blocked = disabled || !!busy || !wallet || !itemId;
  const canTransfer = !blocked && !stale && !!inventory && !recovery;
  return (
    <section className="panel storage-panel" aria-busy={!!busy}>
      <div className="section-kicker">SMART STORAGE UNIT</div>
      <h2>Cargo and storage.</h2>
      <p>
        Move items between your active ship and your storage inventory. The
        server verifies your character, range, available items, and capacity
        before committing each transfer.
      </p>
      {!wallet && (
        <div className="control-note">
          Connect the wallet for your logged-in game character to access
          inventory.
        </div>
      )}
      {!itemId && (
        <div className="banner error">
          This assembly has no game item ID. Open the deployed storage unit from
          the game.
        </div>
      )}
      <div className="storage-toolbar">
        <button disabled={blocked} onClick={() => void load()}>
          {session ? "Refresh inventory" : "Load cargo and storage ↗"}
        </button>
        {inventory && (
          <button disabled={blocked || !!recovery} onClick={() => void sync()}>
            Sync chain
          </button>
        )}
      </div>
      {busy && <p role="status">{busy}…</p>}
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="banner success" role="status">
          {notice}
        </div>
      )}
      {recovery && (
        <div className="storage-recovery" role="status">
          <h3>Check the existing transfer</h3>
          <p>
            The transfer was submitted. Its result must be checked before
            another transfer can start.
          </p>
          <code>{recovery.transactionUUID}</code>
          <button disabled={blocked} onClick={() => void checkExisting()}>
            Check transfer result
          </button>
          <label className="storage-recovery-check">
            <input
              type="checkbox"
              checked={inspectedRecovery}
              disabled={blocked || stale || !inventory}
              onChange={(event) => setInspectedRecovery(event.target.checked)}
            />
            I refreshed the inventory and inspected the cargo and storage totals
            to verify this transfer's result.
          </label>
          <button
            disabled={blocked || stale || !inventory || !inspectedRecovery}
            onClick={dismissInspectedTransfer}
          >
            Dismiss inspected operation
          </button>
        </div>
      )}
      {inventory && (
        <>
          <div className="storage-inventories">
            <div>
              <h3>Ship cargo</h3>
              <p>
                Ship {inventory.cargo.shipID} ·{" "}
                {volume(inventory.cargo.usedVolume)} /{" "}
                {volume(inventory.cargo.capacity)} m³
              </p>
              <p>
                {inventory.cargo.items
                  .reduce((sum, item) => sum + item.quantity, 0)
                  .toLocaleString()}{" "}
                items in {inventory.cargo.items.length} stacks
              </p>
            </div>
            <div>
              <h3>
                {inventory.isAssemblyOwner
                  ? "Owner storage"
                  : "Personal storage"}
              </h3>
              <p>
                Character {inventory.characterID} ·{" "}
                {volume(inventory.usedVolume)} / {volume(inventory.capacity)} m³
              </p>
              <p>
                {stale
                  ? "Inventory is stale. Refresh before transferring."
                  : "Game inventory verified by the server."}
              </p>
            </div>
          </div>
          <div
            className="storage-directions"
            role="group"
            aria-label="Transfer direction"
          >
            <button
              aria-pressed={direction === "deposit"}
              className={direction === "deposit" ? "primary" : ""}
              disabled={blocked || !!recovery}
              onClick={() => {
                setDirection("deposit");
                setSelected("");
                setQuantity("1");
              }}
            >
              Add from cargo ↓
            </button>
            <button
              aria-pressed={direction === "withdraw"}
              className={direction === "withdraw" ? "primary" : ""}
              disabled={blocked || !!recovery}
              onClick={() => {
                setDirection("withdraw");
                setSelected("");
                setQuantity("1");
              }}
            >
              Remove to cargo ↑
            </button>
          </div>
          <div className="inventory-scroll">
            <table className="inventory-table">
              <caption>
                {direction === "deposit"
                  ? "Available cargo stacks"
                  : "Stored items"}
              </caption>
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Item type</th>
                  <th>Available</th>
                  <th>Unit volume</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const id = String(
                    direction === "deposit" ? item.itemID : item.typeID,
                  );
                  return (
                    <tr key={id}>
                      <td>
                        <input
                          type="radio"
                          name="storage-item"
                          aria-label={`Select type ${item.typeID}, stack ${item.itemID}`}
                          checked={selected === id}
                          disabled={!canTransfer}
                          onChange={() => {
                            setSelected(id);
                            setQuantity("1");
                          }}
                        />
                      </td>
                      <td>
                        <span>{typeName(item.typeID, item.typeName)}</span>
                        {!isPlaceholderTypeName(
                          typeName(item.typeID, item.typeName),
                          item.typeID,
                        ) && <small>Type {item.typeID}</small>}
                        {direction === "deposit" && (
                          <small>Stack {item.itemID}</small>
                        )}
                      </td>
                      <td>{item.quantity.toLocaleString()}</td>
                      <td>{volume(item.unitVolume)} m³</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!items.length && (
              <p className="storage-empty">
                {direction === "deposit"
                  ? "No eligible cargo stacks. Put packaged items in your active ship's cargo hold."
                  : "This character's storage inventory is empty."}
              </p>
            )}
          </div>
          <div className="storage-transfer">
            <label>
              Quantity
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={quantity}
                disabled={!canTransfer || !chosen}
                onChange={(event) => setQuantity(event.target.value)}
                aria-label="Transfer quantity"
              />
            </label>
            <button
              disabled={!canTransfer || !chosen}
              onClick={() =>
                setQuantity(String(Math.min(chosen?.quantity || 1, 4294967295)))
              }
            >
              Max
            </button>
            <button
              className="primary"
              disabled={!canTransfer || !chosen}
              onClick={() => void prepare()}
            >
              Review {direction === "deposit" ? "deposit" : "withdrawal"} ↗
            </button>
            {onQueueTask && (
              <button
                disabled={!canTransfer || !chosen}
                onClick={queueTransfer}
              >
                Queue transfer
              </button>
            )}
          </div>
          <ChainInventory
            state={inventory.chain}
            characterID={inventory.characterID}
            typeName={typeName}
          />
        </>
      )}
      {review && (
        <ConfirmDialog
          labelledBy="storage-review-title"
          busy={!!busy}
          onDismiss={() => setReview(null)}
        >
          <div className="section-kicker">REVIEW STORAGE TRANSFER</div>
          <h2 id="storage-review-title">
            {review.transfer.direction === "deposit"
              ? "Add items to storage?"
              : "Remove items to cargo?"}
          </h2>
          <p>
            {review.transfer.stacks[0].quantity.toLocaleString()} items will
            move{" "}
            {review.transfer.direction === "deposit"
              ? "from your ship's cargo into"
              : "from"}{" "}
            <b>{assembly.name}</b>
            {review.transfer.direction === "withdraw"
              ? " into your active ship's cargo"
              : ""}
            .
          </p>
          <p>
            Game item {itemId} · {config.network}
          </p>
          <p>
            Your wallet signs an authorization for this exact transfer. The
            server commits the game inventory and synchronizes it on chain.
          </p>
          {inventory?.chain.status === "disabled" && (
            <div className="banner">
              Chain synchronization is currently disabled on the server. This
              transfer will update the game inventory only.
            </div>
          )}
          <div className="modal-actions">
            <button disabled={!!busy} onClick={() => setReview(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={blocked}
              onClick={() => void execute()}
            >
              {busy ? "Confirming…" : "Approve transfer in wallet ↗"}
            </button>
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}
