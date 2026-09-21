import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { configFromEnv } from "../src/assembly/config.ts";
import type { StorageInventory } from "../src/storage/client.ts";
import { executeStorageTask } from "../src/tasks/storage.ts";
import type { TaskDraft, TaskExecutionContext } from "../src/tasks/types.ts";
import type { WalletSession } from "../src/wallet.ts";

const config = configFromEnv({
  VITE_EVE_WORLD_PACKAGE_ID: "0xa",
  VITE_OBJECT_REGISTRY_ID: "0xb",
});
const task: TaskDraft = {
  title: "Deposit items",
  details: "3 items",
  assembly: {
    id: "0xc",
    itemId: "100",
    kind: "storage_unit",
    name: "Storage",
    state: "online",
    ownerCapId: "0xd",
    ownerCapRef: { objectId: "0xd", version: "1", digest: "digest" },
    characterId: "0xe",
    ownerAddress: "0xf",
    connectedAssemblies: [],
    observedAt: new Date().toISOString(),
  },
  operation: {
    kind: "storage-transfer",
    direction: "deposit",
    selected: 222,
    quantity: "3",
  },
};
const inventory: StorageInventory = {
  storageUnitID: 100,
  characterID: 200,
  capacity: 100,
  usedVolume: 10,
  isAssemblyOwner: true,
  items: [],
  cargo: {
    shipID: 300,
    capacity: 100,
    usedVolume: 10,
    items: [{ itemID: 222, typeID: 30, quantity: 5, unitVolume: 2 }],
  },
  chain: { status: "synced" },
  deployment: {
    network: "localnet",
    chainId: "test-chain",
    packageId: "0xa",
    objectRegistryId: "0xb",
    assemblyObjectID: "0xc",
  },
};
const recoveryKey = "storage-transfer:localnet:0xc:0xf";
const signed = {
  direction: "deposit",
  transactionUUID: "queued-operation",
  bytes: "signed-bytes",
  signature: "signed-signature",
};

async function fixture(t: TestContext) {
  const values = new Map<string, string>();
  const previousStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  t.after(() => {
    if (previousStorage)
      Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  const transactionData = await new Transaction().toJSON();
  const state = {
    current: true,
    signs: 0,
    calls: [] as string[],
    freshInventory: structuredClone(inventory),
    chainStatus: "synced",
    gameCommitted: true,
    failExecute: false,
    invalidateOn: "",
  };
  const wallet = {
    address: "0xf",
    async signTransaction() {
      state.signs++;
      return { bytes: signed.bytes, signature: signed.signature };
    },
  } as unknown as WalletSession;
  const context: TaskExecutionContext = {
    config,
    wallet,
    assertCurrent() {
      if (!state.current) throw new Error("The wallet changed.");
    },
    progress() {},
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const route = String(input).split("/").at(-1)!;
      state.calls.push(route);
      if (route === state.invalidateOn) state.current = false;
      let data: unknown;
      switch (route) {
        case "challenge":
          data = {
            challengeId: "challenge",
            transactionData,
            expiresAt: Date.now() + 60000,
          };
          break;
        case "session":
          data = {
            token: "fresh-token",
            walletAddress: "0xf",
            characterID: 200,
            expiresAt: Date.now() + 60000,
          };
          break;
        case "inventory":
          data = state.freshInventory;
          break;
        case "prepare": {
          const payload = JSON.parse(String(init?.body));
          assert.deepEqual(payload.stacks, [{ itemID: 222, quantity: 3 }]);
          data = {
            transactionUUID: signed.transactionUUID,
            transactionData,
            expiresAtMs: Date.now() + 60000,
          };
          break;
        }
        case "execute":
          assert.deepEqual(JSON.parse(values.get(recoveryKey)!), signed);
          assert.deepEqual(JSON.parse(String(init?.body)), signed);
          if (state.failExecute) throw new Error("Connection lost");
          data = {
            gameCommitted: state.gameCommitted,
            chain: { status: state.chainStatus },
          };
          break;
        default:
          throw new Error(`Unexpected route: ${route}`);
      }
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200,
      });
    },
  );
  return { state, context, values };
}

test("queued transfers authenticate, validate fresh inventory and retain recovery before execute", async (t) => {
  const { state, context, values } = await fixture(t);
  const result = await executeStorageTask(task, context);
  assert.deepEqual(state.calls, [
    "challenge",
    "session",
    "inventory",
    "prepare",
    "execute",
  ]);
  assert.equal(state.signs, 2);
  assert.equal(values.has(recoveryKey), false);
  assert.match(result.message, /confirmed in game and on chain/);
});

test("a confirmed queued transfer remains completed if the wallet changes during submission", async (t) => {
  const { state, context, values } = await fixture(t);
  state.invalidateOn = "execute";
  const result = await executeStorageTask(task, context);
  assert.equal(state.current, false);
  assert.match(result.message, /confirmed in game and on chain/);
  assert.equal(values.has(recoveryKey), false);
  assert.equal(state.calls.filter(route => route === "execute").length, 1);
});

test("queued transfer does not substitute another cargo stack of the same type", async (t) => {
  const { state, context } = await fixture(t);
  state.freshInventory.cargo.items[0].itemID = 999;
  await assert.rejects(executeStorageTask(task, context), /current inventory/);
  assert.equal(state.signs, 1);
  assert.equal(state.calls.includes("prepare"), false);
});

test("queued transfers stop when fresh inventory no longer has enough items", async (t) => {
  const { state, context } = await fixture(t);
  state.freshInventory.cargo.items[0].quantity = 2;
  await assert.rejects(
    executeStorageTask(task, context),
    /exceeds the available/,
  );
  assert.equal(state.calls.includes("prepare"), false);
});

test("queued transfers validate the source deployment before preparing", async (t) => {
  const { state, context } = await fixture(t);
  state.freshInventory.deployment.assemblyObjectID = "0xaa";
  await assert.rejects(
    executeStorageTask(task, context),
    /different deployments/,
  );
  assert.equal(state.calls.includes("prepare"), false);
});

test("an unresolved operation blocks queued execution before authentication", async (t) => {
  const { state, context, values } = await fixture(t);
  values.set(recoveryKey, JSON.stringify(signed));
  await assert.rejects(executeStorageTask(task, context), /existing transfer/);
  assert.deepEqual(state.calls, []);
  assert.equal(state.signs, 0);
});

test("lost execute response retains the exact operation and never retries", async (t) => {
  const { state, context, values } = await fixture(t);
  state.failExecute = true;
  await assert.rejects(
    executeStorageTask(task, context),
    /could not be reached/,
  );
  assert.deepEqual(JSON.parse(values.get(recoveryKey)!), signed);
  assert.equal(state.calls.filter((route) => route === "execute").length, 1);
});

test("unconfirmed game result retains recovery", async (t) => {
  const { state, context, values } = await fixture(t);
  state.gameCommitted = false;
  await assert.rejects(executeStorageTask(task, context), /did not confirm/);
  assert.equal(values.has(recoveryKey), true);
});

test("a committed game transfer reports pending chain synchronization honestly", async (t) => {
  const { state, context, values } = await fixture(t);
  state.chainStatus = "pending";
  const result = await executeStorageTask(task, context);
  assert.match(
    result.message,
    /confirmed in game\. Chain synchronization is pending/,
  );
  assert.equal(values.has(recoveryKey), false);
});

test("wallet invalidation during the auth challenge prevents any signing", async (t) => {
  const { state, context } = await fixture(t);
  state.invalidateOn = "challenge";
  await assert.rejects(executeStorageTask(task, context), /wallet changed/);
  assert.equal(state.signs, 0);
  assert.deepEqual(state.calls, ["challenge"]);
});

test("wallet invalidation during prepare prevents transfer signing or execution", async (t) => {
  const { state, context, values } = await fixture(t);
  state.invalidateOn = "prepare";
  await assert.rejects(executeStorageTask(task, context), /wallet changed/);
  assert.equal(state.signs, 1);
  assert.equal(state.calls.includes("execute"), false);
  assert.equal(values.has(recoveryKey), false);
});
