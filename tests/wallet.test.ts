import assert from "node:assert/strict";
import { test } from "node:test";
import { Transaction, type TransactionPlugin } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import type { Wallet, WalletAccount } from "@mysten/wallet-standard";
import {
  createWalletController,
  GameWalletNotReadyError,
  TransactionSubmissionError,
  type WalletEnvironment,
} from "../src/wallet.ts";

const ALICE = `0x${"a".repeat(64)}`;
const BOB = `0x${"b".repeat(64)}`;
const CONFIG = { network: "devnet", rpcUrl: "http://localhost:9000" };

function transaction(sender = ALICE) {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasBudget(1000);
  tx.setGasPrice(1);
  tx.setGasPayment([
    {
      objectId: `0x${"1".repeat(64)}`,
      version: "1",
      digest: "11111111111111111111111111111111",
    },
  ]);
  return tx;
}

function sponsoredTransaction() {
  const tx = transaction();
  tx.setGasOwner(BOB);
  tx.moveCall({
    target: "0x2::assembly::set_online",
    arguments: [
      tx.sharedObjectRef({
        objectId: `0x${"2".repeat(64)}`,
        initialSharedVersion: "1",
        mutable: true,
      }),
      tx.pure.bool(true),
    ],
  });
  return tx;
}

interface SigningInput {
  chain: string;
  transaction: { toJSON(): Promise<string> };
}

function account(address = ALICE, chain = "sui:devnet"): WalletAccount {
  return {
    address,
    publicKey: new Uint8Array(32),
    chains: [chain],
    features: ["sui:signTransaction"],
  };
}

function fixture(
  options: {
    account?: WalletAccount;
    sign?: (input: SigningInput) => Promise<unknown>;
    execute?: () => Promise<unknown>;
    confirm?: () => Promise<unknown>;
  } = {},
) {
  let accounts = [options.account ?? account()];
  let change: (() => void) | undefined;
  let signCalls = 0;
  let executeCalls = 0;
  let suppliedChain = "";
  const wallet = {
    version: "1.0.0",
    name: "Test wallet",
    icon: "data:image/svg+xml;base64,",
    chains: ["sui:devnet", "sui:testnet"],
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => ({ accounts }),
      },
      "standard:events": {
        version: "1.0.0",
        on: (_event: string, callback: () => void) => {
          change = callback;
          return () => {
            change = undefined;
          };
        },
      },
      "sui:signTransaction": {
        version: "2.0.0",
        signTransaction: async (input: SigningInput) => {
          signCalls++;
          suppliedChain = input.chain;
          if (options.sign) return options.sign(input);
          const tx = Transaction.from(await input.transaction.toJSON());
          return {
            bytes: toBase64(await tx.build()),
            signature: "test-signature",
          };
        },
      },
    },
  } as Wallet;
  const registry = {
    get: () => [wallet],
    on: () => () => {},
  } as unknown as ReturnType<NonNullable<WalletEnvironment["registry"]>>;
  const client = {
    executeTransactionBlock: async () => {
      executeCalls++;
      return options.execute
        ? options.execute()
        : {
            digest: "submitted-digest",
            effects: { status: { status: "success" } },
          };
    },
    waitForTransaction: async () =>
      options.confirm
        ? options.confirm()
        : {
            digest: "submitted-digest",
            effects: { status: { status: "success" } },
          },
  } as unknown as ReturnType<NonNullable<WalletEnvironment["client"]>>;
  const environment: WalletEnvironment = {
    registry: () => registry,
    native: () => undefined,
    client: () => client,
  };
  const controller = createWalletController(environment);
  return {
    controller,
    environment,
    connect: () =>
      controller.connectWallet(controller.listWallets()[0].id, CONFIG),
    changeAccount(next: WalletAccount) {
      accounts = [next];
      change?.();
    },
    calls: () => ({ signCalls, executeCalls, suppliedChain }),
  };
}

test("browser signing uses the configured chain and confirms successful effects", async () => {
  const f = fixture();
  const session = await f.connect();
  try {
    assert.deepEqual(await session.signAndExecute(transaction(), CONFIG), {
      digest: "submitted-digest",
    });
    assert.deepEqual(f.calls(), {
      signCalls: 1,
      executeCalls: 1,
      suppliedChain: "sui:devnet",
    });
  } finally {
    await session.disconnect();
  }
});

test("sign and execute resolves missing gas through the configured RPC before wallet serialization", async () => {
  let resolutions = 0;
  const resolve: TransactionPlugin = async (data, _options, next) => {
    resolutions++;
    assert.equal(data.sender, ALICE);
    data.gasData = transaction().getData().gasData;
    await next();
  };
  const f = fixture({
    sign: async (input) => {
      const prepared = Transaction.from(await input.transaction.toJSON());
      assert.equal(prepared.isFullyResolved(), true);
      return {
        bytes: toBase64(await prepared.build()),
        signature: "test-signature",
      };
    },
  });
  const controller = createWalletController({
    ...f.environment,
    client(config) {
      assert.deepEqual(config, CONFIG);
      return {
        ...f.environment.client!(config),
        core: { resolveTransactionPlugin: () => resolve },
      };
    },
  });
  const session = await controller.connectWallet(
    controller.listWallets()[0].id,
    CONFIG,
  );
  try {
    assert.deepEqual(await session.signAndExecute(new Transaction(), CONFIG), {
      digest: "submitted-digest",
    });
    assert.equal(resolutions, 1);
    assert.equal(f.calls().signCalls, 1);
    assert.equal(f.calls().executeCalls, 1);
  } finally {
    session.dispose();
  }
});

test("storage authorization signs the exact prepared bytes without submitting to the chain", async () => {
  const f = fixture();
  const session = await f.connect();
  try {
    const tx = transaction();
    const signed = await session.signTransaction(tx, CONFIG);
    assert.equal(signed.bytes, toBase64(await tx.build()));
    assert.equal(signed.signature, "test-signature");
    assert.deepEqual(f.calls(), {
      signCalls: 1,
      executeCalls: 0,
      suppliedChain: "sui:devnet",
    });
  } finally {
    await session.disconnect();
  }
});

test("storage authorization rejects wallet mutation of the reviewed transaction", async () => {
  const changed = transaction();
  changed.setGasBudget(2000);
  const f = fixture({
    sign: async () => ({
      bytes: toBase64(await changed.build()),
      signature: "test-signature",
    }),
  });
  const session = await f.connect();
  try {
    await assert.rejects(
      session.signTransaction(transaction(), CONFIG),
      /wallet changed the prepared transaction/,
    );
    assert.equal(f.calls().executeCalls, 0);
  } finally {
    await session.disconnect();
  }
});

test("storage authorization refuses another sender before opening the wallet", async () => {
  const f = fixture();
  const session = await f.connect();
  try {
    await assert.rejects(
      session.signTransaction(transaction(BOB), CONFIG),
      /sender does not match/,
    );
    assert.equal(f.calls().signCalls, 0);
  } finally {
    await session.disconnect();
  }
});

test("sponsored browser authorization signs an immutable transaction with sponsor gas and no sender coin lookup", async () => {
  const tx = sponsoredTransaction();
  const expectedBytes = toBase64(await tx.build());
  const f = fixture({
    sign: async (input) => {
      const firstJSON = await input.transaction.toJSON();
      // A caller changing its builder while approval is open cannot change the request.
      tx.setGasOwner(ALICE);
      tx.setGasBudget(2000);
      assert.equal(await input.transaction.toJSON(), firstJSON);
      const prepared = Transaction.from(firstJSON);
      assert.equal(prepared.getData().sender, ALICE);
      assert.equal(prepared.getData().gasData.owner, BOB);
      assert.equal(toBase64(await prepared.build()), expectedBytes);
      return { bytes: expectedBytes, signature: "sponsored-signature" };
    },
  });
  const controller = createWalletController({
    ...f.environment,
    client() {
      throw new Error(
        "A sender with zero coins must not need RPC for sponsored signing",
      );
    },
  });
  const session = await controller.connectWallet(
    controller.listWallets()[0].id,
    CONFIG,
  );
  try {
    assert.deepEqual(await session.signTransaction(tx, CONFIG), {
      bytes: expectedBytes,
      signature: "sponsored-signature",
    });
    assert.equal(f.calls().signCalls, 1);
    assert.equal(f.calls().executeCalls, 0);
  } finally {
    session.dispose();
  }
});

test("sponsored browser authorization rejects replacement sponsor gas", async () => {
  const changed = sponsoredTransaction();
  changed.setGasOwner(ALICE);
  const f = fixture({
    sign: async () => ({
      bytes: toBase64(await changed.build()),
      signature: "signature",
    }),
  });
  const session = await f.connect();
  try {
    await assert.rejects(
      session.signTransaction(sponsoredTransaction(), CONFIG),
      /wallet changed the prepared transaction/,
    );
    assert.equal(f.calls().executeCalls, 0);
  } finally {
    session.dispose();
  }
});

test("sign-only authorization rejects incomplete transactions before opening a wallet or resolving gas", async () => {
  const f = fixture();
  const session = await f.connect();
  try {
    const tx = new Transaction();
    tx.setSender(ALICE);
    await assert.rejects(
      session.signTransaction(tx, CONFIG),
      /prepared transaction is incomplete/,
    );
    assert.equal(f.calls().signCalls, 0);
    assert.equal(f.calls().executeCalls, 0);
  } finally {
    session.dispose();
  }
});

test("sponsored authorization refuses wallets that can only sign and execute", async () => {
  const signer = { ...account(), features: ["sui:signAndExecuteTransaction"] };
  const f = fixture({ account: signer });
  const providerFeatures = f.environment.registry!().get()[0]
    .features as Record<string, unknown>;
  delete providerFeatures["sui:signTransaction"];
  let submissions = 0;
  providerFeatures["sui:signAndExecuteTransaction"] = {
    version: "2.0.0",
    async signAndExecuteTransaction() {
      submissions++;
      return { digest: "unexpected" };
    },
  };
  const session = await f.connect();
  try {
    await assert.rejects(
      session.signTransaction(sponsoredTransaction(), CONFIG),
      /cannot sign without submitting/,
    );
    assert.equal(submissions, 0);
    assert.equal(f.calls().executeCalls, 0);
  } finally {
    session.dispose();
  }
});

test("native sponsored authorization preserves sponsor bytes without looking up sender coins or submitting", async () => {
  for (const mutateSignerBytes of [false, true]) {
    const tx = sponsoredTransaction();
    const expectedBytes = toBase64(await tx.build());
    let signingCalls = 0;
    const controller = createWalletController({
      client() {
        throw new Error(
          "Sponsored signing must not query coins or execute through RPC",
        );
      },
      native: () => ({
        WALLET_API_CHAIN: "sui:devnet",
        async callWallet(request) {
          if (request.method === "connect") {
            return {
              result: {
                accounts: [{ suiAddress: ALICE, chains: ["sui:devnet"] }],
              },
            };
          }
          signingCalls++;
          assert.equal(request.method, "signTransaction");
          assert.equal(typeof request.params.transaction, "string");
          tx.setGasOwner(ALICE);
          const prepared = Transaction.from(
            request.params.transaction as string,
          );
          assert.equal(prepared.getData().gasData.owner, BOB);
          assert.equal(toBase64(await prepared.build()), expectedBytes);
          if (mutateSignerBytes) prepared.setGasBudget(2000);
          return {
            result: {
              bytes: toBase64(await prepared.build()),
              signature: "native-sponsored-signature",
            },
          };
        },
      }),
    });
    const session = await controller.connectWallet(
      "eve-frontier-native",
      CONFIG,
    );
    try {
      if (mutateSignerBytes) {
        await assert.rejects(
          session.signTransaction(tx, CONFIG),
          /wallet changed the prepared transaction/,
        );
      } else {
        assert.deepEqual(await session.signTransaction(tx, CONFIG), {
          bytes: expectedBytes,
          signature: "native-sponsored-signature",
        });
      }
      assert.equal(signingCalls, 1);
    } finally {
      session.dispose();
    }
  }
});

test("a wallet connected only to another network cannot supply the signing account", async () => {
  const f = fixture({ account: account(ALICE, "sui:testnet") });
  await assert.rejects(
    f.connect(),
    /No signing account is available for sui:devnet/,
  );
  assert.equal(f.calls().signCalls, 0);
});

test("an account change invalidates the session before signing", async () => {
  const f = fixture();
  const session = await f.connect();
  let reason = "";
  session.subscribe((next) => {
    reason = next;
  });
  f.changeAccount(account(BOB));
  await assert.rejects(
    session.signAndExecute(transaction(), CONFIG),
    /account or network changed/,
  );
  assert.match(reason, /Reconnect/);
  assert.equal(f.calls().signCalls, 0);
});

test("changing RPC configuration requires reconnecting before signing", async () => {
  const f = fixture();
  const session = await f.connect();
  try {
    await assert.rejects(
      session.signAndExecute(transaction(), {
        ...CONFIG,
        rpcUrl: "http://localhost:9001",
      }),
      /configuration changed/,
    );
    assert.equal(f.calls().signCalls, 0);
  } finally {
    await session.disconnect();
  }
});

test("a signed transaction from another account is never submitted", async () => {
  const f = fixture({
    sign: async () => ({
      bytes: toBase64(await transaction(BOB).build()),
      signature: "test-signature",
    }),
  });
  const session = await f.connect();
  try {
    await assert.rejects(
      session.signAndExecute(transaction(), CONFIG),
      /different wallet account/,
    );
    assert.equal(f.calls().executeCalls, 0);
  } finally {
    await session.disconnect();
  }
});

test("account changes while a wallet approval is open prevent submission", async () => {
  const f = fixture({
    sign: async () => {
      f.changeAccount(account(BOB));
      return {
        bytes: toBase64(await transaction().build()),
        signature: "test-signature",
      };
    },
  });
  const session = await f.connect();
  await assert.rejects(
    session.signAndExecute(transaction(), CONFIG),
    /account or network changed/,
  );
  assert.equal(f.calls().executeCalls, 0);
});

test("a Move failure preserves its digest and never reports success", async () => {
  const f = fixture({
    execute: async () => ({
      digest: "failed-digest",
      effects: { status: { status: "failure", error: "EWrongOwner" } },
    }),
  });
  const session = await f.connect();
  try {
    await assert.rejects(
      session.signAndExecute(transaction(), CONFIG),
      (error) => {
        assert.ok(error instanceof TransactionSubmissionError);
        assert.equal(error.digest, "failed-digest");
        assert.match(error.message, /EWrongOwner/);
        return true;
      },
    );
  } finally {
    await session.disconnect();
  }
});

test("confirmation timeouts preserve the submitted digest and do not retry", async () => {
  const f = fixture({
    confirm: async () => {
      throw new Error("RPC timeout");
    },
  });
  const session = await f.connect();
  try {
    await assert.rejects(
      session.signAndExecute(transaction(), CONFIG),
      (error) => {
        assert.ok(error instanceof TransactionSubmissionError);
        assert.equal(error.digest, "submitted-digest");
        assert.match(error.message, /confirmation is unavailable/);
        return true;
      },
    );
    assert.equal(f.calls().executeCalls, 1);
  } finally {
    await session.disconnect();
  }
});

test("a lost submission response retains the locally calculated transaction digest", async () => {
  const f = fixture({
    execute: async () => {
      throw new Error("Connection reset after sending");
    },
  });
  const session = await f.connect();
  try {
    const expectedDigest = await transaction().getDigest();
    await assert.rejects(
      session.signAndExecute(transaction(), CONFIG),
      (error) => {
        assert.ok(error instanceof TransactionSubmissionError);
        assert.equal(error.digest, expectedDigest);
        assert.match(error.message, /Check the digest before trying again/);
        return true;
      },
    );
    assert.equal(f.calls().executeCalls, 1);
  } finally {
    await session.disconnect();
  }
});

test("native bridge connects with suiAddress and signs JSON through the proven JSON-RPC contract", async () => {
  const f = fixture();
  const methods: string[] = [];
  const controller = createWalletController({
    ...f.environment,
    native: () => ({
      WALLET_API_CHAIN: "sui:devnet",
      async callWallet(request) {
        methods.push(request.method);
        assert.equal(request.jsonrpc, "2.0");
        assert.equal(typeof request.id, "number");
        if (request.method === "connect")
          return {
            result: {
              accounts: [{ suiAddress: ALICE, chains: ["sui:devnet"] }],
            },
          };
        assert.equal(request.method, "signTransaction");
        assert.equal(typeof request.params.transaction, "string");
        const tx = Transaction.from(request.params.transaction as string);
        assert.equal(tx.getData().sender, ALICE);
        return {
          result: {
            bytes: toBase64(await tx.build()),
            signature: "test-signature",
          },
        };
      },
    }),
  });
  const session = await controller.connectWallet("eve-frontier-native", CONFIG);
  try {
    assert.equal(session.address, ALICE);
    assert.deepEqual(await session.signAndExecute(transaction(), CONFIG), {
      digest: "submitted-digest",
    });
    assert.equal(
      methods.filter((method) => method === "signTransaction").length,
      1,
    );
    assert.equal(f.calls().executeCalls, 1);
  } finally {
    await session.disconnect();
  }
});

test("native mismatched chain is rejected before invoking the signer", async () => {
  const f = fixture();
  let called = false;
  const controller = createWalletController({
    ...f.environment,
    native: () => ({
      WALLET_API_CHAIN: "sui:testnet",
      async callWallet() {
        called = true;
        return {};
      },
    }),
  });
  await assert.rejects(
    controller.connectWallet("eve-frontier-native", CONFIG),
    /configured for sui:devnet/,
  );
  assert.equal(called, false);
});

test("native JSON-RPC errors surface their message without submitting", async () => {
  const f = fixture();
  const controller = createWalletController({
    ...f.environment,
    native: () => ({
      async callWallet() {
        return { error: { code: -32603, message: "signer not ready" } };
      },
    }),
  });
  await assert.rejects(
    controller.connectWallet("eve-frontier-native", CONFIG),
    /signer not ready/,
  );
  assert.equal(f.calls().executeCalls, 0);
});

test("only a valid empty native accounts array reports temporary signer readiness", async () => {
  const f = fixture();
  const methods: string[] = [];
  const controller = createWalletController({
    ...f.environment,
    native: () => ({
      WALLET_API_CHAIN: "sui:devnet",
      async callWallet(request) {
        methods.push(request.method);
        return { result: { accounts: [] } };
      },
    }),
  });
  await assert.rejects(
    controller.connectWallet("eve-frontier-native", CONFIG),
    GameWalletNotReadyError,
  );
  assert.deepEqual(methods, ["connect"]);
  assert.equal(f.calls().executeCalls, 0);
});

test("malformed native accounts, other chains, and generic errors are terminal", async () => {
  const f = fixture();
  const responses = [
    { result: null },
    { result: {} },
    { result: { accounts: null } },
    { result: { accounts: { length: 0 } } },
    { result: { accounts: [null] } },
    { result: { accounts: [{ suiAddress: ALICE, chains: "sui:devnet" }] } },
    {
      result: { accounts: [{ suiAddress: "invalid", chains: ["sui:devnet"] }] },
    },
    { result: { accounts: [{ suiAddress: ALICE, chains: ["sui:testnet"] }] } },
    { error: { code: -32603, message: "signer not ready" } },
  ];
  for (const response of responses) {
    const controller = createWalletController({
      ...f.environment,
      native: () => ({
        async callWallet() {
          return response;
        },
      }),
    });
    await assert.rejects(
      controller.connectWallet("eve-frontier-native", CONFIG),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof GameWalletNotReadyError));
        return true;
      },
    );
  }
  assert.equal(f.calls().executeCalls, 0);
});

test("local native session disposal removes its poll and prevents signing", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const clearPoll = t.mock.method(globalThis, "clearInterval");
  const methods: string[] = [];
  const controller = createWalletController({
    native: () => ({
      async callWallet(request) {
        methods.push(request.method);
        return {
          result: { accounts: [{ suiAddress: ALICE, chains: ["sui:devnet"] }] },
        };
      },
    }),
  });
  const connected = await controller.connectWallet(
    "eve-frontier-native",
    CONFIG,
  );
  assert.equal(clearPoll.mock.callCount(), 0);
  connected.dispose();
  assert.equal(clearPoll.mock.callCount(), 1);
  t.mock.timers.tick(15_000);
  await assert.rejects(
    connected.signTransaction(transaction(), CONFIG),
    /Wallet session closed/,
  );
  await assert.rejects(
    connected.signAndExecute(transaction(), CONFIG),
    /Wallet session closed/,
  );
  connected.dispose();
  assert.equal(clearPoll.mock.callCount(), 1);
  assert.deepEqual(methods, ["connect"]);
});

test("local browser session disposal does not disconnect its wallet provider", async () => {
  const f = fixture();
  const provider = f.environment.registry!().get()[0];
  let disconnectCalls = 0;
  (provider.features as Record<string, unknown>)["standard:disconnect"] = {
    version: "1.0.0",
    async disconnect() {
      disconnectCalls++;
    },
  };
  const connected = await f.connect();
  const invalidations: string[] = [];
  connected.subscribe((reason) => invalidations.push(reason));
  connected.dispose();
  f.changeAccount(account(BOB));
  await assert.rejects(
    connected.signTransaction(transaction(), CONFIG),
    /Wallet session closed/,
  );
  assert.equal(disconnectCalls, 0);
  assert.deepEqual(invalidations, []);
  assert.equal(f.calls().signCalls, 0);
  assert.equal(f.calls().executeCalls, 0);
});
