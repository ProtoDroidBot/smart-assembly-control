import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import {
  normalizeSuiAddress,
  SUI_CLOCK_OBJECT_ID,
  toBase64,
} from "@mysten/sui/utils";
import {
  AdminApiError,
  adminItemId,
  adminOperationFinished,
  createAdminClient,
  readAdminRecovery,
  validatePreparedAdminTransaction,
} from "../src/admin/client.ts";
import type {
  PreparedAdminTransaction,
  SignedAdminTransaction,
} from "../src/admin/client.ts";
import {
  ASSEMBLY_TYPES,
  type AssemblyAction,
  type AssemblyConfig,
  type AssemblySnapshot,
} from "../src/assembly/types.ts";
import type { WalletSession } from "../src/wallet.ts";

const id = (value: string) => normalizeSuiAddress(`0x${value}`);
const config: AssemblyConfig = {
  network: "localnet",
  rpcUrl: "http://127.0.0.1:9000",
  packageId: id("a"),
  objectRegistryId: id("b"),
  energyConfigId: id("c"),
  fuelConfigId: id("d"),
};
const assembly: AssemblySnapshot = {
  id: id("10"),
  itemId: "9988400000266",
  tenant: "dev",
  kind: "network_node",
  name: "Node",
  state: "offline",
  ownerAddress: id("20"),
  characterId: id("30"),
  ownerCapId: id("40"),
  ownerCapRef: {
    objectId: id("40"),
    version: "1",
    digest: "11111111111111111111111111111111",
  },
  connectedAssemblies: [],
  observedAt: new Date().toISOString(),
};
/** Build the backend's status template with fully resolved shared/receiving inputs. */
async function prepared(
  snapshot = assembly,
  action: AssemblyAction = "online",
  fuel = { withdraw: false, deposit: false },
): Promise<PreparedAdminTransaction> {
  const tx = new Transaction();
  tx.setSender(snapshot.ownerAddress);
  tx.setGasOwner(id("99"));
  tx.setGasBudget(100000000);
  tx.setGasPrice(1000);
  tx.setGasPayment([
    {
      objectId: id("88"),
      version: "1",
      digest: "11111111111111111111111111111111",
    },
  ]);
  const shared = (objectId: string) =>
    tx.sharedObjectRef({
      objectId,
      initialSharedVersion: "1",
      mutable: objectId !== SUI_CLOCK_OBJECT_ID,
    });
  const type = `${config.packageId}::${ASSEMBLY_TYPES[snapshot.kind]}`;
  const [cap, receipt] = tx.moveCall({
    target: `${config.packageId}::character::borrow_owner_cap`,
    typeArguments: [type],
    arguments: [
      shared(snapshot.characterId),
      tx.receivingRef(snapshot.ownerCapRef),
    ],
  });
  if (snapshot.kind !== "network_node") {
    tx.moveCall({
      target: `${config.packageId}::${snapshot.kind}::${action}`,
      arguments: [
        shared(snapshot.id),
        shared(snapshot.networkNodeId!),
        shared(config.energyConfigId),
        cap,
      ],
    });
  } else if (action === "online") {
    tx.moveCall({
      target: `${config.packageId}::network_node::online`,
      arguments: [shared(snapshot.id), cap, shared(SUI_CLOCK_OBJECT_ID)],
    });
    if (fuel.deposit)
      tx.moveCall({
        target: `${config.packageId}::network_node::deposit_fuel`,
        arguments: [
          shared(snapshot.id),
          shared(id("77")),
          cap,
          tx.pure.u64(175),
          tx.pure.u64(1000),
          tx.pure.u64(1),
          shared(SUI_CLOCK_OBJECT_ID),
        ],
      });
  } else {
    if (fuel.withdraw)
      tx.moveCall({
        target: `${config.packageId}::network_node::withdraw_fuel`,
        arguments: [
          shared(snapshot.id),
          shared(id("77")),
          cap,
          tx.pure.u64(175),
          tx.pure.u64(10),
        ],
      });
    let [remaining] = tx.moveCall({
      target: `${config.packageId}::network_node::offline`,
      arguments: [
        shared(snapshot.id),
        shared(config.fuelConfigId),
        cap,
        shared(SUI_CLOCK_OBJECT_ID),
      ],
    });
    for (const child of snapshot.connectedAssemblies) {
      [remaining] = tx.moveCall({
        target: `${config.packageId}::${child.kind}::offline_connected_${child.kind}`,
        arguments: [
          shared(child.id),
          remaining,
          shared(snapshot.id),
          shared(config.energyConfigId),
        ],
      });
    }
    tx.moveCall({
      target: `${config.packageId}::network_node::destroy_offline_assemblies`,
      arguments: [remaining],
    });
    if (fuel.deposit)
      tx.moveCall({
        target: `${config.packageId}::network_node::deposit_fuel`,
        arguments: [
          shared(snapshot.id),
          shared(id("77")),
          cap,
          tx.pure.u64(175),
          tx.pure.u64(1000),
          tx.pure.u64(5),
          shared(SUI_CLOCK_OBJECT_ID),
        ],
      });
  }
  tx.moveCall({
    target: `${config.packageId}::character::return_owner_cap`,
    typeArguments: [type],
    arguments: [shared(snapshot.characterId), cap, receipt],
  });
  return {
    transactionUUID: "unique-operation",
    transactionData: toBase64(await tx.build()),
    expiresAt: Date.now() + 60000,
    action,
    assemblyID: Number(snapshot.itemId),
    assemblyObjectID: snapshot.id,
    walletAddress: snapshot.ownerAddress,
    sponsorAddress: id("99"),
    deployment: {
      network: config.network,
      chainId: "chain",
      packageId: config.packageId,
      objectRegistryId: config.objectRegistryId,
      adminAclId: id("77"),
      energyConfigId: config.energyConfigId,
      fuelConfigId: config.fuelConfigId,
    },
  };
}
async function signed(): Promise<SignedAdminTransaction> {
  const value = await prepared();
  return {
    transactionUUID: value.transactionUUID,
    action: value.action,
    assemblyID: assembly.itemId!,
    assemblyObjectID: assembly.id,
    walletAddress: assembly.ownerAddress,
    bytes: value.transactionData,
    signature: "owner-signature",
    digest: await Transaction.from(value.transactionData).getDigest(),
  };
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

test("prepared sponsorship preserves exact bytes and resolves without sender coins or RPC", async () => {
  const value = await prepared();
  const checked = await validatePreparedAdminTransaction(
    value,
    config,
    assembly,
    "online",
    assembly.ownerAddress,
  );
  assert.equal(checked.bytes, value.transactionData);
  assert.equal(checked.transaction.getData().gasData.owner, id("99"));
  assert.equal(
    checked.digest,
    await Transaction.from(value.transactionData).getDigest(),
  );
});

test("network-node online accepts native fuel accounting and legacy startup compensation", async () => {
  for (const deposit of [false, true]) {
    const value = await prepared(assembly, "online", {
      withdraw: false,
      deposit,
    });
    const checked = await validatePreparedAdminTransaction(
      value,
      config,
      assembly,
      "online",
      assembly.ownerAddress,
    );
    assert.equal(checked.bytes, value.transactionData);
    assert.deepEqual(
      checked.transaction
        .getData()
        .commands.map((command) => command.MoveCall?.function),
      [
        "borrow_owner_cap",
        "online",
        ...(deposit ? ["deposit_fuel"] : []),
        "return_owner_cap",
      ],
    );
  }
});

type PreparedData = ReturnType<Transaction["getData"]>;
async function changedBytes(
  value: PreparedAdminTransaction,
  change: (data: PreparedData) => void,
) {
  const data = Transaction.from(value.transactionData).getData();
  change(data);
  return {
    ...value,
    transactionData: toBase64(
      await Transaction.from(JSON.stringify(data)).build(),
    ),
  };
}

test("prepared commands must match reviewed package, action, objects, capability and result wiring", async (t) => {
  const value = await prepared();
  const mutations: [string, (data: PreparedData) => void][] = [
    [
      "unrelated package",
      (data) => {
        data.commands[1].MoveCall!.package = id("ff");
      },
    ],
    [
      "unrelated action",
      (data) => {
        data.commands[1].MoveCall!.function = "offline";
      },
    ],
    [
      "different assembly",
      (data) => {
        data.inputs.find(
          (input) => input.Object?.SharedObject?.objectId === assembly.id,
        )!.Object!.SharedObject!.objectId = id("ff");
      },
    ],
    [
      "different character",
      (data) => {
        data.inputs.find(
          (input) =>
            input.Object?.SharedObject?.objectId === assembly.characterId,
        )!.Object!.SharedObject!.objectId = id("ff");
      },
    ],
    [
      "different owner capability",
      (data) => {
        data.inputs.find(
          (input) => input.Object?.Receiving,
        )!.Object!.Receiving!.objectId = id("ff");
      },
    ],
    [
      "stale owner capability",
      (data) => {
        data.inputs.find(
          (input) => input.Object?.Receiving,
        )!.Object!.Receiving!.version = "2";
      },
    ],
    [
      "wrong capability type",
      (data) => {
        data.commands[0].MoveCall!.typeArguments[0] = `${config.packageId}::gate::Gate`;
      },
    ],
    [
      "receipt used as owner capability",
      (data) => {
        data.commands[1].MoveCall!.arguments[1] = {
          $kind: "NestedResult",
          NestedResult: [0, 1],
        };
      },
    ],
    [
      "missing receipt return",
      (data) => {
        data.commands.pop();
      },
    ],
    [
      "unrelated extra call",
      (data) => {
        data.commands.push({
          $kind: "MoveCall",
          MoveCall: {
            package: id("ff"),
            module: "unrelated",
            function: "action",
            typeArguments: [],
            arguments: [],
          },
        });
      },
    ],
    [
      "unused sender input",
      (data) => {
        data.inputs.push({
          $kind: "Object",
          Object: {
            $kind: "ImmOrOwnedObject",
            ImmOrOwnedObject: {
              objectId: id("ff"),
              version: "1",
              digest: "11111111111111111111111111111111",
            },
          },
        });
      },
    ],
    [
      "empty operation",
      (data) => {
        data.inputs = [];
        data.commands = [];
      },
    ],
  ];
  for (const [name, mutation] of mutations)
    await t.test(name, async () => {
      await assert.rejects(
        validatePreparedAdminTransaction(
          await changedBytes(value, mutation),
          config,
          assembly,
          "online",
          assembly.ownerAddress,
        ),
        /differs from the reviewed operation/,
      );
    });
});

test("all non-node assembly actions accept only the configured node and energy configuration", async () => {
  for (const kind of ["assembly", "storage_unit", "gate", "turret"] as const) {
    for (const action of ["online", "offline"] as const) {
      const snapshot: AssemblySnapshot = {
        ...assembly,
        kind,
        state: action === "online" ? "offline" : "online",
        networkNodeId: id("50"),
        networkNodeState: "online",
      };
      const value = await prepared(snapshot, action);
      await validatePreparedAdminTransaction(
        value,
        config,
        snapshot,
        action,
        snapshot.ownerAddress,
      );
      for (const target of [snapshot.networkNodeId, config.energyConfigId]) {
        const changed = await changedBytes(value, (data) => {
          data.inputs.find(
            (input) => input.Object?.SharedObject?.objectId === target,
          )!.Object!.SharedObject!.objectId = id("ff");
        });
        await assert.rejects(
          validatePreparedAdminTransaction(
            changed,
            config,
            snapshot,
            action,
            snapshot.ownerAddress,
          ),
          /reviewed operation/,
        );
      }
    }
  }
});

test("network-node shutdown exactly matches the reviewed cascade and allows server fuel compensation", async () => {
  const snapshot: AssemblySnapshot = {
    ...assembly,
    state: "online",
    connectedAssemblies: [
      {
        id: id("51"),
        kind: "storage_unit",
        name: "Storage",
        state: "online",
        networkNodeId: assembly.id,
      },
      {
        id: id("52"),
        kind: "turret",
        name: "Turret",
        state: "online",
        networkNodeId: assembly.id,
      },
    ],
  };
  for (const withdraw of [false, true]) {
    for (const deposit of [false, true]) {
      const value = await prepared(snapshot, "offline", { withdraw, deposit });
      await validatePreparedAdminTransaction(
        value,
        config,
        snapshot,
        "offline",
        snapshot.ownerAddress,
      );
    }
  }
  const unseen = {
    id: id("53"),
    kind: "gate" as const,
    name: "Unreviewed gate",
    state: "online" as const,
    networkNodeId: assembly.id,
  };
  for (const connectedAssemblies of [
    [...snapshot.connectedAssemblies, unseen],
    snapshot.connectedAssemblies.slice(0, 1),
    [snapshot.connectedAssemblies[0], snapshot.connectedAssemblies[0]],
  ]) {
    const value = await prepared(
      { ...snapshot, connectedAssemblies },
      "offline",
    );
    await assert.rejects(
      validatePreparedAdminTransaction(
        value,
        config,
        snapshot,
        "offline",
        snapshot.ownerAddress,
      ),
      /reviewed operation/,
    );
  }
  const value = await prepared(snapshot, "offline");
  const fuelConfigChanged = await changedBytes(value, (data) => {
    data.inputs.find(
      (input) => input.Object?.SharedObject?.objectId === config.fuelConfigId,
    )!.Object!.SharedObject!.objectId = id("ff");
  });
  await assert.rejects(
    validatePreparedAdminTransaction(
      fuelConfigChanged,
      config,
      snapshot,
      "offline",
      snapshot.ownerAddress,
    ),
    /reviewed operation/,
  );
});

test("fuel adjustment calls cannot add hidden effects or change the reviewed node and sponsor ACL", async () => {
  const value = await prepared(assembly, "online", {
    withdraw: false,
    deposit: true,
  });
  await assert.rejects(
    validatePreparedAdminTransaction(
      { ...value, deployment: { ...value.deployment, adminAclId: id("ff") } },
      config,
      assembly,
      "online",
      assembly.ownerAddress,
    ),
    /reviewed operation/,
  );
  await assert.rejects(
    validatePreparedAdminTransaction(
      { ...value, deployment: { ...value.deployment, adminAclId: undefined } },
      config,
      assembly,
      "online",
      assembly.ownerAddress,
    ),
    /reviewed operation/,
  );
  for (const mutation of [
    (data: PreparedData) => {
      data.commands[2].MoveCall!.arguments[0] =
        data.commands[0].MoveCall!.arguments[0];
    },
    (data: PreparedData) => {
      data.commands[2].MoveCall!.arguments[2] = {
        $kind: "NestedResult",
        NestedResult: [0, 1],
      };
    },
    (data: PreparedData) => {
      data.commands[2].MoveCall!.arguments[5] =
        data.commands[2].MoveCall!.arguments[4];
    },
    (data: PreparedData) => {
      data.commands[2].MoveCall!.arguments[6] =
        data.commands[2].MoveCall!.arguments[0];
    },
    (data: PreparedData) => {
      data.commands[2].MoveCall!.typeArguments = ["u64"];
    },
    (data: PreparedData) => {
      data.commands.splice(3, 0, structuredClone(data.commands[2]));
    },
    (data: PreparedData) => {
      data.commands[2].MoveCall!.function = "withdraw_fuel";
    },
  ]) {
    await assert.rejects(
      validatePreparedAdminTransaction(
        await changedBytes(value, mutation),
        config,
        assembly,
        "online",
        assembly.ownerAddress,
      ),
      /reviewed operation/,
    );
  }
});

test("sponsored actions require real local game identity", () => {
  assert.equal(adminItemId(assembly, config), assembly.itemId);
  for (const itemId of [
    undefined,
    "0",
    "-1",
    "1.5",
    "9007199254740993",
    "../execute",
  ])
    assert.throws(
      () => adminItemId({ ...assembly, itemId }, config),
      /game item ID/,
    );
  assert.throws(
    () => adminItemId({ ...assembly, tenant: "other" }, config),
    /localnet/,
  );
  assert.throws(
    () => adminItemId(assembly, { ...config, network: "testnet" }),
    /localnet/,
  );
});

test("expired, unrelated, and unsponsored server preparations never reach signing", async () => {
  const value = await prepared();
  for (const change of [
    { expiresAt: Date.now() - 1 },
    { expiresAt: "invalid" },
    { action: "offline" as const },
    { assemblyID: 1 },
    { assemblyObjectID: id("11") },
    { walletAddress: id("21") },
    { deployment: { ...value.deployment, packageId: id("ff") } },
    { deployment: { ...value.deployment, objectRegistryId: id("ff") } },
    { deployment: { ...value.deployment, network: "testnet" } },
  ])
    await assert.rejects(
      validatePreparedAdminTransaction(
        { ...value, ...change },
        config,
        assembly,
        "online",
        assembly.ownerAddress,
      ),
      /expired or differs/,
    );
  const tx = Transaction.from(value.transactionData);
  tx.setGasOwner(assembly.ownerAddress);
  await assert.rejects(
    validatePreparedAdminTransaction(
      {
        ...value,
        sponsorAddress: assembly.ownerAddress,
        transactionData: toBase64(await tx.build()),
      },
      config,
      assembly,
      "online",
      assembly.ownerAddress,
    ),
    /sponsored gas/,
  );
  await assert.rejects(
    validatePreparedAdminTransaction(
      { ...value, sponsorAddress: id("77") },
      config,
      assembly,
      "online",
      assembly.ownerAddress,
    ),
    /sponsored gas/,
  );
});

function challengeTransaction() {
  const tx = new Transaction();
  tx.setSender(assembly.ownerAddress);
  tx.setGasOwner(assembly.ownerAddress);
  tx.setGasBudget(1);
  tx.setGasPrice(1);
  tx.setGasPayment([
    {
      objectId: id("88"),
      version: "1",
      digest: "11111111111111111111111111111111",
    },
  ]);
  return tx;
}

test("authentication signs only the challenge and prepare pins deployment and action", async () => {
  const value = await prepared();
  const challenge = await challengeTransaction().toJSON();
  const calls: {
    url: string;
    init?: RequestInit;
    body: Record<string, unknown>;
  }[] = [];
  const api = createAdminClient(async (url, init) => {
    calls.push({
      url: String(url),
      init,
      body: JSON.parse(String(init?.body)),
    });
    const data = String(url).endsWith("/challenge")
      ? { challengeId: "challenge", transactionData: challenge }
      : String(url).endsWith("/session")
        ? {
            token: "session-token",
            walletAddress: assembly.ownerAddress,
            characterID: 100,
            expiresAt: Date.now() + 60000,
          }
        : value;
    return response({ success: true, data });
  });
  let count = 0;
  const wallet = {
    address: assembly.ownerAddress,
    async signTransaction(tx: Transaction) {
      count++;
      return {
        bytes: toBase64(await tx.build()),
        signature: "owner-signature",
      };
    },
    async signAndExecute() {
      assert.fail("must not use direct submission");
    },
  } as unknown as WalletSession;
  const session = await api.authenticate(wallet, config);
  await api.prepare(assembly, config, session.token, "online");
  assert.equal(count, 1);
  assert.deepEqual(calls[2].body, {
    action: "online",
    tenant: "dev",
    expectedAssemblyObjectID: assembly.id,
    expectedPackageId: config.packageId,
    expectedObjectRegistryId: config.objectRegistryId,
  });
  assert.equal(calls[2].url, `/evejs/admin/${assembly.itemId}/prepare`);
  assert.equal(
    (calls[2].init?.headers as Record<string, string>).Authorization,
    "Bearer session-token",
  );
  assert.equal(calls[2].init?.credentials, "omit");
  assert.equal(calls[2].init?.redirect, "error");
});

test("admin authentication refuses real calls and altered challenge data before signing", async (t) => {
  const preparedOperation = await prepared();
  const transactions: [string, string][] = [
    ["real sponsored operation", preparedOperation.transactionData],
  ];
  for (const [name, mutate] of [
    [
      "Move call",
      (tx: Transaction) => {
        tx.moveCall({
          target: `${config.packageId}::network_node::online`,
          arguments: [],
        });
      },
    ],
    [
      "unused input",
      (tx: Transaction) => {
        tx.pure.u64(1);
      },
    ],
    ["other sender", (tx: Transaction) => tx.setSender(id("ff"))],
    ["sponsored challenge", (tx: Transaction) => tx.setGasOwner(id("ff"))],
    ["different gas budget", (tx: Transaction) => tx.setGasBudget(1000)],
    ["different gas price", (tx: Transaction) => tx.setGasPrice(1000)],
    ["expiration", (tx: Transaction) => tx.setExpiration({ Epoch: 1 })],
    [
      "real gas reference",
      (tx: Transaction) =>
        tx.setGasPayment([
          {
            objectId: id("88"),
            version: "2",
            digest: "11111111111111111111111111111111",
          },
        ]),
    ],
  ] as [string, (tx: Transaction) => void][]) {
    const tx = challengeTransaction();
    mutate(tx);
    transactions.push([name, await tx.toJSON()]);
  }
  for (const [name, transactionData] of transactions)
    await t.test(name, async () => {
      let signingCalls = 0;
      let serverCalls = 0;
      const wallet = {
        address: assembly.ownerAddress,
        async signTransaction() {
          signingCalls++;
          assert.fail("invalid auth challenge must not reach the wallet");
        },
      } as unknown as WalletSession;
      const api = createAdminClient(async () => {
        serverCalls++;
        return response({
          success: true,
          data: { challengeId: "challenge", transactionData },
        });
      });
      await assert.rejects(
        api.authenticate(wallet, config),
        /connection challenge is invalid/,
      );
      assert.equal(signingCalls, 0);
      assert.equal(serverCalls, 1);
    });
});

test("lost response recovery reuses immutable operation and verifies exact committed result", async () => {
  const operation = await signed();
  const saved = readAdminRecovery(
    JSON.stringify(operation),
    assembly.id,
    assembly.ownerAddress,
  )!;
  const requests: unknown[] = [];
  const api = createAdminClient(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1)
      throw new Error("connection lost after submission");
    return response({
      success: true,
      data: {
        ...operation,
        assemblyID: Number(operation.assemblyID),
        gameCommitted: true,
        replayed: true,
      },
    });
  });
  await assert.rejects(api.execute("token", operation), /Check transaction/);
  const result = await api.execute("new-token", saved);
  assert.equal(result.digest, operation.digest);
  assert.equal(result.replayed, true);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(
    readAdminRecovery(null, assembly.id, assembly.ownerAddress),
    null,
  );
  for (const raw of [
    "broken",
    JSON.stringify({ ...operation, walletAddress: id("ff") }),
    JSON.stringify({ ...operation, bytes: "" }),
  ])
    assert.throws(
      () => readAdminRecovery(raw, assembly.id, assembly.ownerAddress),
      /could not be read/,
    );
});

test("uncertain, failed, malformed, and mismatched responses remain distinguishable", async () => {
  const operation = await signed();
  const pending = new AdminApiError(
    "Pending",
    "TRANSACTION_PENDING",
    operation.digest,
  );
  assert.equal(adminOperationFinished(pending), false);
  assert.equal(
    adminOperationFinished(
      new AdminApiError("Expired", "TRANSACTION_NOT_FOUND"),
    ),
    true,
  );
  assert.equal(
    adminOperationFinished(new AdminApiError("Failed", "TRANSACTION_FAILED")),
    true,
  );
  assert.equal(
    adminOperationFinished(
      new AdminApiError("Deployment changed", "DEPLOYMENT_MISMATCH"),
    ),
    false,
  );
  const api = createAdminClient(async () =>
    response(
      {
        success: false,
        errorMsg: pending.code,
        message: pending.message,
        params: { digest: operation.digest },
      },
      409,
    ),
  );
  await assert.rejects(
    api.execute("token", operation),
    (error: unknown) =>
      error instanceof AdminApiError &&
      error.digest === operation.digest &&
      error.code === "TRANSACTION_PENDING",
  );
  for (const change of [
    { digest: "other" },
    { gameCommitted: false },
    { action: "offline" },
    { assemblyID: 1 },
    { transactionUUID: "other" },
  ]) {
    const mismatch = createAdminClient(async () =>
      response({
        success: true,
        data: { ...operation, gameCommitted: true, ...change },
      }),
    );
    await assert.rejects(mismatch.execute("token", operation), /not confirmed/);
  }
  const invalid = createAdminClient(
    async () => new Response("<html>gateway down</html>", { status: 502 }),
  );
  await assert.rejects(invalid.execute("token", operation), /invalid response/);
});
