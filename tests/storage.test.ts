import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import {
  createStorageClient,
  StorageApiError,
  transferQuantity,
  transferRequest,
  validateInventoryListenerRequest,
  validateStorageDeployment,
} from "../src/storage/client.ts";
import type { StorageInventory } from "../src/storage/client.ts";
import type { WalletSession } from "../src/wallet.ts";
import { configFromEnv } from "../src/assembly/config.ts";

const inventory: StorageInventory = {
  storageUnitID: 100,
  characterID: 200,
  capacity: 100,
  usedVolume: 10,
  isAssemblyOwner: true,
  items: [{ itemID: 111, typeID: 20, quantity: 10, unitVolume: 1 }],
  cargo: {
    shipID: 300,
    capacity: 100,
    usedVolume: 10,
    items: [
      { itemID: 222, typeID: 30, quantity: 5, unitVolume: 2 },
      { itemID: 333, typeID: 40, quantity: 1, unitVolume: 1, singleton: 1 },
    ],
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

test("transfers require the same local deployment even if chain synchronization is unavailable", () => {
  const config = configFromEnv({
    VITE_EVE_WORLD_PACKAGE_ID: "0xa",
    VITE_OBJECT_REGISTRY_ID: "0xb",
  });
  validateStorageDeployment(config, "0xc", inventory.deployment);
  assert.throws(
    () =>
      validateStorageDeployment(
        { ...config, network: "testnet" },
        "0xc",
        inventory.deployment,
      ),
    /localnet/,
  );
  assert.throws(
    () =>
      validateStorageDeployment(
        { ...config, packageId: "0xd" },
        "0xc",
        inventory.deployment,
      ),
    /different deployments/,
  );
  assert.throws(
    () => validateStorageDeployment(config, "0xd", inventory.deployment),
    /different deployments/,
  );
  assert.throws(
    () =>
      validateStorageDeployment(
        config,
        "0xc",
        undefined as unknown as StorageInventory["deployment"],
      ),
    /localnet/,
  );
});

test("preparing a transfer includes the expected chain storage object", async () => {
  let payload: Record<string, unknown> | undefined;
  const client = createStorageClient(async (_url, init) => {
    payload = JSON.parse(String(init?.body));
    return response({ success: true, data: { transactionUUID: "prepared" } });
  });
  await client.prepare(
    "100",
    "token",
    transferRequest(inventory, "deposit", 222, "1"),
    "0xc",
  );
  assert.equal(payload?.expectedAssemblyObjectID, `0x${"c".padStart(64, "0")}`);
  assert.deepEqual(payload?.stacks, [{ itemID: 222, quantity: 1 }]);
});

test("transfer requests preserve existing stack custody and use type IDs only for withdrawals", () => {
  assert.deepEqual(transferRequest(inventory, "deposit", 222, "3"), {
    direction: "deposit",
    stacks: [{ itemID: 222, quantity: 3 }],
  });
  assert.deepEqual(transferRequest(inventory, "withdraw", 20, "5"), {
    direction: "withdraw",
    stacks: [{ typeID: 20, quantity: 5 }],
  });
  assert.throws(
    () => transferRequest(inventory, "deposit", 999, "1"),
    /current inventory/,
  );
  assert.throws(
    () => transferRequest(inventory, "deposit", 333, "1"),
    /Assembled items/,
  );
  assert.throws(
    () => transferRequest(inventory, "deposit", 222, "6"),
    /exceeds the available/,
  );
  assert.throws(
    () => transferRequest(inventory, "withdraw", 111, "1"),
    /current inventory/,
  );
});

test("quantities reject fractions, negative amounts, unsafe integers, and capacity overflow", () => {
  for (const value of [
    "0",
    "-1",
    "+1",
    "1.5",
    "1e3",
    " 1",
    "Infinity",
    "4294967296",
    "9007199254740993",
  ]) {
    assert.throws(() => transferQuantity(value, Number.MAX_SAFE_INTEGER));
  }
  assert.equal(transferQuantity("4294967295", 4294967295), 4294967295);
  assert.throws(
    () => transferRequest({ ...inventory, capacity: 11 }, "deposit", 222, "1"),
    /storage unit has insufficient/,
  );
  assert.throws(
    () =>
      transferRequest(
        { ...inventory, cargo: { ...inventory.cargo, capacity: 10 } },
        "withdraw",
        20,
        "1",
      ),
    /ship has insufficient/,
  );
});

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("inventory requests use only a bearer token and never send game cookies", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createStorageClient(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return response({ success: true, data: inventory });
  });
  assert.deepEqual(await client.inventory("100", "session-token"), inventory);
  assert.equal(calls[0].url, "/evejs/storage/100/inventory");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(
    new Headers(calls[0].init.headers).get("Authorization"),
    "Bearer session-token",
  );
  assert.throws(
    () => client.inventory("../200", "token"),
    /valid game item ID/,
  );
  assert.equal(calls.length, 1);
});

test("listener requests validate exact targets and response conditions", async () => {
  const request = { targetKind: "smart-assembly" as const, targetID: 400, inventory: "outputs" as const,
    requested: [{ typeID: 34, quantity: 5 }] };
  const calls: any[] = [];
  const client = createStorageClient(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return response({ success: true, data: { ...request, targetName: "Industry", capacity: 0, usedVolume: 5,
      matched: [{ typeID: 34, quantity: 5, available: 5 }], items: [], satisfied: true, observedAtMs: 1234 } });
  });
  const result = await client.listener("token", request);
  assert.equal(result.satisfied, true);
  assert.deepEqual(calls, [{ url: "/evejs/storage/listener", body: request }]);
  assert.throws(() => validateInventoryListenerRequest({ ...request, inventory: "cargo" }), /supported inventory/);
  assert.throws(() => validateInventoryListenerRequest({ ...request,
    requested: [{ typeID: 34, quantity: 1 }, { typeID: 34, quantity: 2 }] }), /unique/);

  const inconsistent = createStorageClient(async () => response({ success: true, data: {
    ...result, satisfied: false,
  } }));
  await assert.rejects(inconsistent.listener("token", request), /inconsistent result/);
});

test("listener requests honor queue cancellation during an active HTTP read", async () => {
  const controller = new AbortController();
  const request = { targetKind: "cargo" as const, targetID: 77, inventory: "cargo" as const,
    requested: [{ typeID: 12, quantity: 1 }] };
  const client = createStorageClient(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  }));
  const pending = client.listener("token", request, controller.signal);
  controller.abort();
  await assert.rejects(pending, /did not respond in time/);
});

test("auth signs the server challenge without chain submission and returns its signature and bytes", async () => {
  const tx = new Transaction();
  const transactionData = await tx.toJSON();
  const sent: unknown[] = [];
  let signs = 0;
  const client = createStorageClient(async (url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    if (String(url).endsWith("/challenge"))
      return response({
        success: true,
        data: {
          challengeId: "challenge-1",
          transactionData,
          expiresAt: Date.now() + 60000,
        },
      });
    return response({
      success: true,
      data: {
        token: "token",
        walletAddress: "0xa",
        characterID: 200,
        expiresAt: Date.now() + 60000,
      },
    });
  });
  const wallet = {
    address: "0xa",
    async signTransaction(transaction: Transaction) {
      signs++;
      assert.equal(await transaction.toJSON(), transactionData);
      return { signature: "signature", bytes: "bytes" };
    },
    async signAndExecute() {
      throw new Error("Authorization must not submit a chain transaction");
    },
  } as unknown as WalletSession;
  const session = await client.authenticate(wallet, {
    network: "localnet",
    rpcUrl: "http://localhost:9000",
  });
  assert.equal(session.token, "token");
  assert.equal(signs, 1);
  assert.deepEqual(sent, [
    { walletAddress: "0xa" },
    { challengeId: "challenge-1", signature: "signature", bytes: "bytes" },
  ]);
});

test("a lost execute response never triggers a second transfer request", async () => {
  let attempts = 0;
  const client = createStorageClient(async () => {
    attempts++;
    throw new Error("connection reset");
  });
  await assert.rejects(
    client.execute("100", "token", {
      direction: "deposit",
      transactionUUID: "existing-operation",
      signature: "signature",
      bytes: "bytes",
    }),
    /could not be reached/,
  );
  assert.equal(attempts, 1);
});

test("server errors retain their authentication status and readable reason", async () => {
  const client = createStorageClient(async () =>
    response(
      {
        success: false,
        errorMsg: "ACCESS_DENIED",
        message: "Your ship is out of range.",
      },
      403,
    ),
  );
  await assert.rejects(client.inventory("100", "token"), (error) => {
    assert.ok(error instanceof StorageApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "ACCESS_DENIED");
    assert.equal(error.message, "Your ship is out of range.");
    return true;
  });
});

test("game commit with a pending chain is returned as an explicit partial outcome", async () => {
  const result = {
    storageUnitID: 100,
    characterID: 200,
    gameCommitted: true,
    action: "deposit",
    chain: { status: "pending" },
  };
  const client = createStorageClient(async () =>
    response({ success: true, data: result }),
  );
  assert.deepEqual(
    await client.execute("100", "token", {
      direction: "deposit",
      transactionUUID: "one-operation",
      bytes: "bytes",
      signature: "sig",
    }),
    result,
  );
});
