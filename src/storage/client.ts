import { Transaction } from "@mysten/sui/transactions";
import type { WalletConfig, WalletSession } from "../wallet.ts";
import { requireObjectId } from "../assembly/config.ts";
import type { AssemblyConfig } from "../assembly/types.ts";

export type StorageDirection = "deposit" | "withdraw";
export interface StorageItem {
  itemID: number;
  typeID: number;
  quantity: number;
  unitVolume: number;
  typeName?: string;
  singleton?: boolean | number;
}
export interface ChainStorageStatus {
  status: "disabled" | "pending" | "synced" | "error";
  storageUnitID?: number;
  characterID?: number;
  error?: string;
  digest?: string;
  chain?: {
    assemblyId: string;
    online: boolean;
    synchronized: boolean;
    partitions: {
      characterId: number;
      characterObjectId: string;
      inventoryKey: string;
      isOwner: boolean;
      maxCapacity: string;
      usedCapacity: string;
      synchronized: boolean;
      items: {
        itemId: string;
        typeId: string;
        quantity: string;
        unitVolume: string;
      }[];
    }[];
  };
}
export interface StorageInventory {
  storageUnitID: number;
  characterID: number;
  capacity: number;
  usedVolume: number;
  isAssemblyOwner: boolean;
  items: StorageItem[];
  cargo: {
    shipID: number;
    capacity: number;
    usedVolume: number;
    items: StorageItem[];
  };
  chain: ChainStorageStatus;
  deployment: {
    network: string;
    chainId: string;
    packageId: string;
    objectRegistryId: string;
    assemblyObjectID: string;
  };
}
export interface StorageSession {
  token: string;
  characterID: number;
  walletAddress: string;
  expiresAt: string | number;
}
export interface PreparedTransfer {
  transactionUUID: string;
  transactionData: string;
  expiresAtMs: number;
}
export interface TransferResult {
  storageUnitID: number;
  characterID: number;
  action: string;
  gameCommitted: boolean;
  replayed?: boolean;
  chain: ChainStorageStatus;
}
export interface TransferRequest {
  direction: StorageDirection;
  stacks: { itemID?: number; typeID?: number; quantity: number }[];
}
export interface SignedTransfer {
  direction: StorageDirection;
  transactionUUID: string;
  signature: string;
  bytes: string;
}

export type InventoryListenerTargetKind = "smart-assembly" | "cargo";
export type InventoryListenerSpace = "storage" | "inputs" | "outputs" | "cargo";
export interface InventoryListenerRequest {
  targetKind: InventoryListenerTargetKind;
  targetID: number;
  inventory: InventoryListenerSpace;
  requested: { typeID: number; quantity: number }[];
}
export interface InventoryListenerResult extends InventoryListenerRequest {
  targetName: string;
  capacity: number;
  usedVolume: number;
  matched: { typeID: number; quantity: number; available: number }[];
  items: { typeID: number; typeName: string; quantity: number; unitVolume: number }[];
  satisfied: boolean;
  observedAtMs: number;
}

export function validateInventoryListenerRequest(value: InventoryListenerRequest): InventoryListenerRequest {
  if (!value || !["smart-assembly", "cargo"].includes(value.targetKind) ||
      !Number.isSafeInteger(value.targetID) || value.targetID <= 0 ||
      !["storage", "inputs", "outputs", "cargo"].includes(value.inventory) ||
      (value.targetKind === "cargo") !== (value.inventory === "cargo") ||
      !Array.isArray(value.requested) || !value.requested.length || value.requested.length > 100)
    throw new StorageApiError("Choose a supported inventory and at least one item requirement.", "INVALID_LISTENER_REQUEST");
  const seen = new Set<number>();
  for (const item of value.requested) {
    if (!item || !Number.isSafeInteger(item.typeID) || item.typeID <= 0 || item.typeID > 0xffff_ffff || seen.has(item.typeID) ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 0xffff_ffff)
      throw new StorageApiError("Listener item types must be unique positive IDs with quantities from 1 to 4,294,967,295.", "INVALID_LISTENER_REQUEST");
    seen.add(item.typeID);
  }
  return value;
}

function validateInventoryListenerResult(value: InventoryListenerResult, expected: InventoryListenerRequest) {
  const invalid = () => { throw new StorageApiError("The inventory listener returned an inconsistent result. Stop and queue it again.", "INVALID_RESPONSE"); };
  if (!value || value.targetKind !== expected.targetKind || value.targetID !== expected.targetID ||
      value.inventory !== expected.inventory || typeof value.targetName !== "string" ||
      !Number.isFinite(value.capacity) || value.capacity < 0 || !Number.isFinite(value.usedVolume) || value.usedVolume < 0 ||
      typeof value.satisfied !== "boolean" || !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0 ||
      !Array.isArray(value.requested) || !Array.isArray(value.items) || !Array.isArray(value.matched) ||
      value.requested.length !== expected.requested.length || value.matched.length !== expected.requested.length) invalid();
  const expectedByType = new Map(expected.requested.map(item => [item.typeID, item.quantity]));
  if (value.requested.some(item => !item || expectedByType.get(item.typeID) !== item.quantity) ||
      new Set(value.requested.map(item => item.typeID)).size !== expectedByType.size) invalid();
  const seen = new Set<number>();
  for (const item of value.matched) {
    if (!item || seen.has(item.typeID) || expectedByType.get(item.typeID) !== item.quantity ||
        !Number.isSafeInteger(item.available) || item.available < 0) invalid();
    seen.add(item.typeID);
  }
  if (seen.size !== expectedByType.size || value.satisfied !== value.matched.every(item => item.available >= item.quantity)) invalid();
  const itemTypes = new Set<number>();
  for (const item of value.items) {
    if (!item || !Number.isSafeInteger(item.typeID) || item.typeID <= 0 || item.typeID > 0xffff_ffff ||
        itemTypes.has(item.typeID) || typeof item.typeName !== "string" ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        !Number.isFinite(item.unitVolume) || item.unitVolume < 0) invalid();
    itemTypes.add(item.typeID);
  }
  return value;
}

export class StorageApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = "STORAGE_UNAVAILABLE", status = 0) {
    super(message);
    this.name = "StorageApiError";
    this.code = code;
    this.status = status;
  }
}

export function validateStorageDeployment(
  config: AssemblyConfig,
  assemblyObjectID: string,
  deployment: StorageInventory["deployment"],
) {
  if (
    config.network !== "localnet" ||
    !deployment ||
    deployment.network !== "localnet"
  )
    throw new Error(
      "Storage transfers require the game's localnet deployment. Reload the dApp using the current server configuration.",
    );
  if (
    requireObjectId(config.packageId, "World package ID") !==
      requireObjectId(deployment.packageId, "Storage server package ID") ||
    requireObjectId(config.objectRegistryId, "Object registry ID") !==
      requireObjectId(
        deployment.objectRegistryId,
        "Storage server registry ID",
      ) ||
    requireObjectId(assemblyObjectID, "Assembly object ID") !==
      requireObjectId(deployment.assemblyObjectID, "Storage server assembly ID")
  )
    throw new Error(
      "The storage server and dApp reference different deployments or storage objects. Reload the dApp before transferring items.",
    );
}

export function transferQuantity(value: string, available: number): number {
  if (!/^[1-9]\d*$/.test(value))
    throw new Error("Enter a positive whole-number quantity.");
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity > 4294967295)
    throw new Error("Quantity must be no greater than 4,294,967,295.");
  if (quantity > available)
    throw new Error(
      "The requested quantity exceeds the available items. Refresh inventory.",
    );
  return quantity;
}

/** Only actual stacks from the current server inventory may be transferred. */
export function transferRequest(
  inventory: StorageInventory,
  direction: StorageDirection,
  selectedId: number,
  quantity: string,
): TransferRequest {
  const items =
    direction === "deposit" ? inventory.cargo.items : inventory.items;
  const item = items.find(
    (candidate) =>
      (direction === "deposit" ? candidate.itemID : candidate.typeID) ===
      selectedId,
  );
  if (!item) throw new Error("Select an item from the current inventory.");
  if (direction === "deposit" && item.singleton)
    throw new Error("Assembled items cannot be added to storage.");
  const amount = transferQuantity(quantity, item.quantity);
  const destination = direction === "deposit" ? inventory : inventory.cargo;
  if (
    destination.usedVolume + amount * item.unitVolume >
    destination.capacity + 0.000001
  )
    throw new Error(
      direction === "deposit"
        ? "The storage unit has insufficient free capacity."
        : "Your ship has insufficient free cargo capacity.",
    );
  return {
    direction,
    stacks: [
      {
        [direction === "deposit" ? "itemID" : "typeID"]: selectedId,
        quantity: amount,
      },
    ],
  };
}

export function createStorageClient(
  fetcher: typeof fetch = fetch,
  base = "/evejs/storage",
) {
  async function request<T>(
    route: string,
    token?: string,
    body?: unknown,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetcher(`${base}${route}`, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let payload: {
        success?: boolean;
        data?: T;
        message?: string;
        errorMsg?: string;
      };
      try {
        payload = await response.json();
      } catch {
        throw new StorageApiError(
          `The storage service returned an invalid response (HTTP ${response.status}). Check the local server and reload inventory.`,
          "INVALID_RESPONSE",
          response.status,
        );
      }
      if (!response.ok || payload.success !== true || !payload.data)
        throw new StorageApiError(
          payload.message ||
            payload.errorMsg ||
            `Storage request failed (HTTP ${response.status}).`,
          payload.errorMsg,
          response.status,
        );
      return payload.data;
    } catch (error) {
      if (error instanceof StorageApiError) throw error;
      throw new StorageApiError(
        error instanceof Error && error.name === "AbortError"
          ? "The storage server did not respond in time. A submitted transfer may still complete; check its existing operation before starting another."
          : "The storage server could not be reached. Check its connection and try again.",
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    }
  }
  function route(storageUnitID: string, action: string) {
    if (
      !/^[1-9]\d*$/.test(storageUnitID) ||
      !Number.isSafeInteger(Number(storageUnitID))
    )
      throw new Error("The storage unit needs a valid game item ID.");
    return `/${storageUnitID}/${action}`;
  }
  return {
    async authenticate(
      wallet: WalletSession,
      config: WalletConfig,
      signal?: AbortSignal,
    ): Promise<StorageSession> {
      const challenge = await request<{
        challengeId: string;
        message: string;
        transactionData: string;
        expiresAt: string | number;
      }>("/auth/challenge", undefined, { walletAddress: wallet.address }, signal);
      const signed = await wallet.signTransaction(
        Transaction.from(challenge.transactionData),
        config,
      );
      return request("/auth/session", undefined, {
        challengeId: challenge.challengeId,
        ...signed,
      }, signal);
    },
    inventory: (id: string, token: string) =>
      request<StorageInventory>(route(id, "inventory"), token),
    async listener(token: string, condition: InventoryListenerRequest, signal?: AbortSignal) {
      validateInventoryListenerRequest(condition);
      return validateInventoryListenerResult(
        await request<InventoryListenerResult>("/listener", token, condition, signal),
        condition,
      );
    },
    prepare: (
      id: string,
      token: string,
      transfer: TransferRequest,
      expectedAssemblyObjectID: string,
    ) =>
      request<PreparedTransfer>(route(id, "prepare"), token, {
        ...transfer,
        expectedAssemblyObjectID: requireObjectId(
          expectedAssemblyObjectID,
          "Expected storage object ID",
        ),
      }),
    execute: (id: string, token: string, transfer: SignedTransfer) =>
      request<TransferResult>(route(id, "execute"), token, transfer),
    sync: (id: string, token: string) =>
      request<ChainStorageStatus>(route(id, "sync"), token, {}),
  };
}
