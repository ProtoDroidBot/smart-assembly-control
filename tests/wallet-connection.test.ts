import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createWalletConnection } from "../src/wallet-connection.ts";
import {
  createWalletController,
  GameWalletNotReadyError,
} from "../src/wallet.ts";
import type {
  WalletConfig,
  WalletOption,
  WalletSession,
} from "../src/wallet.ts";

const CONFIG = { network: "devnet", rpcUrl: "http://localhost:9000" };
const NATIVE = {
  id: "eve-frontier-native",
  name: "EVE Frontier game wallet",
};
const BROWSER = { id: "standard-1", name: "Browser wallet" };
const ALICE = `0x${"a".repeat(64)}`;
const BOB = `0x${"b".repeat(64)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function session(address = ALICE) {
  const listeners = new Set<(reason: string) => void>();
  const previousListeners = new Set<(reason: string) => void>();
  const calls = { disconnect: 0, dispose: 0, sign: 0, execute: 0 };
  const wallet: WalletSession = {
    address,
    name: NATIVE.name,
    chain: "sui:devnet",
    dispose() {
      calls.dispose++;
      listeners.clear();
    },
    async disconnect() {
      calls.disconnect++;
      listeners.forEach((listener) => listener("Wallet disconnected."));
      listeners.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      previousListeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async signTransaction() {
      calls.sign++;
      throw new Error("Connecting must not sign a transaction.");
    },
    async signAndExecute() {
      calls.execute++;
      throw new Error("Connecting must not execute a transaction.");
    },
  };
  return {
    wallet,
    calls,
    invalidate(reason: string) {
      listeners.forEach((listener) => listener(reason));
    },
    invalidateStale(reason: string) {
      previousListeners.forEach((listener) => listener(reason));
    },
  };
}

function fixture(initialWallets: WalletOption[] = [NATIVE]) {
  let wallets = initialWallets;
  const watchers = new Set<() => void>();
  const attempts: { id: string; config: WalletConfig }[] = [];
  const sessions: ReturnType<typeof session>[] = [];
  let connect: () => Promise<WalletSession> = async () => {
    const next = session();
    sessions.push(next);
    return next.wallet;
  };
  const controller = {
    listWallets: () => [...wallets],
    watchWallets(onChange: () => void) {
      watchers.add(onChange);
      return () => {
        watchers.delete(onChange);
      };
    },
    async connectWallet(id: string, config: WalletConfig) {
      attempts.push({ id, config });
      return connect();
    },
  };
  const connection = createWalletConnection(CONFIG, controller);
  return {
    connection,
    controller,
    attempts,
    sessions,
    watchers,
    useConnect(next: () => Promise<WalletSession>) {
      connect = next;
    },
    discover(next = wallets) {
      wallets = next;
      watchers.forEach((notify) => notify());
    },
  };
}

test("the native game wallet connects on start without signing or submitting", async () => {
  const f = fixture([BROWSER, NATIVE]);
  let notifications = 0;
  const unsubscribe = f.connection.subscribe(() => notifications++);
  const stop = f.connection.start();
  try {
    await setImmediate();
    assert.deepEqual(f.attempts, [{ id: NATIVE.id, config: CONFIG }]);
    assert.equal(f.connection.getSnapshot().wallet, f.sessions[0].wallet);
    assert.equal(f.connection.getSnapshot().pending, false);
    assert.equal(f.connection.getSnapshot().error, "");
    assert.ok(notifications > 0);
    assert.equal(f.sessions[0].calls.sign, 0);
    assert.equal(f.sessions[0].calls.execute, 0);
  } finally {
    unsubscribe();
    stop();
    await setImmediate();
  }
});

test("browser wallets remain manual and use the selected wallet", async () => {
  const f = fixture([BROWSER]);
  const stop = f.connection.start();
  try {
    await setImmediate();
    assert.equal(f.attempts.length, 0);
    assert.equal(f.connection.getSnapshot().wallet, null);
    await f.connection.connect(BROWSER.id);
    assert.deepEqual(f.attempts, [{ id: BROWSER.id, config: CONFIG }]);
    assert.equal(f.connection.getSnapshot().wallet, f.sessions[0].wallet);
  } finally {
    stop();
    await setImmediate();
  }
});

test("a bridge discovered after startup connects automatically only once", async () => {
  const f = fixture([BROWSER]);
  const stop = f.connection.start();
  try {
    await setImmediate();
    f.discover([BROWSER, NATIVE]);
    await setImmediate();
    f.discover();
    f.discover();
    await setImmediate();
    assert.deepEqual(
      f.attempts.map(({ id }) => id),
      [NATIVE.id],
    );
    assert.deepEqual(f.connection.getSnapshot().wallets, [BROWSER, NATIVE]);
    assert.equal(f.connection.getSnapshot().wallet, f.sessions[0].wallet);
  } finally {
    stop();
    await setImmediate();
  }
});

test("discovery and manual clicks cannot overlap a pending automatic connection", async () => {
  const f = fixture([NATIVE, BROWSER]);
  const pending = deferred<WalletSession>();
  const connected = session();
  f.useConnect(() => pending.promise);
  const stop = f.connection.start();
  try {
    await setImmediate();
    assert.equal(f.connection.getSnapshot().pending, true);
    f.discover();
    f.discover();
    const manual = f.connection.connect(BROWSER.id);
    assert.equal(f.attempts.length, 1);
    pending.resolve(connected.wallet);
    await manual;
    await setImmediate();
    assert.equal(f.attempts.length, 1);
    assert.equal(f.connection.getSnapshot().wallet, connected.wallet);
    assert.equal(f.connection.getSnapshot().pending, false);
  } finally {
    stop();
    await setImmediate();
  }
});

test("failed automatic connection waits for a manual retry", async () => {
  const f = fixture();
  f.useConnect(async () => {
    throw new Error("The game wallet has no account for sui:devnet.");
  });
  const stop = f.connection.start();
  try {
    await setImmediate();
    assert.match(f.connection.getSnapshot().error, /no account/);
    assert.equal(f.connection.getSnapshot().pending, false);
    f.discover();
    f.discover([]);
    f.discover([NATIVE]);
    await setImmediate();
    assert.equal(f.attempts.length, 1);
    const connected = session();
    f.useConnect(async () => connected.wallet);
    await f.connection.connect(NATIVE.id);
    assert.equal(f.attempts.length, 2);
    assert.equal(f.connection.getSnapshot().wallet, connected.wallet);
    assert.equal(f.connection.getSnapshot().error, "");
  } finally {
    stop();
    await setImmediate();
  }
});

test("manual connection errors are captured without rejecting the caller", async () => {
  const f = fixture([BROWSER]);
  f.useConnect(async () => {
    throw new Error("User rejected wallet connection.");
  });
  const stop = f.connection.start();
  try {
    await assert.doesNotReject(f.connection.connect(BROWSER.id));
    assert.match(f.connection.getSnapshot().error, /User rejected/);
    assert.equal(f.connection.getSnapshot().wallet, null);
    assert.equal(f.connection.getSnapshot().pending, false);
  } finally {
    stop();
    await setImmediate();
  }
});

test("intentional disconnect keeps automatic connection paused until a new page", async () => {
  const f = fixture();
  const stop = f.connection.start();
  try {
    await setImmediate();
    await f.connection.disconnect();
    assert.equal(f.sessions[0].calls.disconnect, 1);
    assert.equal(f.connection.getSnapshot().wallet, null);
    f.discover([]);
    f.discover([NATIVE]);
    await setImmediate();
    assert.equal(f.attempts.length, 1);
    const reloaded = createWalletConnection(CONFIG, f.controller);
    const stopReloaded = reloaded.start();
    try {
      await setImmediate();
      assert.equal(f.attempts.length, 2);
      assert.equal(reloaded.getSnapshot().wallet, f.sessions[1].wallet);
    } finally {
      stopReloaded();
      await setImmediate();
    }
  } finally {
    stop();
    await setImmediate();
  }
});

test("StrictMode start-stop-start shares one pending connection", async () => {
  const f = fixture();
  const pending = deferred<WalletSession>();
  const connected = session();
  f.useConnect(() => pending.promise);
  const firstStop = f.connection.start();
  firstStop();
  const stop = f.connection.start();
  try {
    await setImmediate();
    assert.equal(f.attempts.length, 1);
    assert.equal(f.watchers.size, 1);
    pending.resolve(connected.wallet);
    await setImmediate();
    assert.equal(f.connection.getSnapshot().wallet, connected.wallet);
    assert.equal(connected.calls.dispose, 0);
    assert.equal(connected.calls.disconnect, 0);
  } finally {
    stop();
    await setImmediate();
  }
  assert.equal(f.watchers.size, 0);
  assert.equal(connected.calls.dispose, 1);
});

test("unmount disposes a late connection without disconnecting the game wallet", async () => {
  const f = fixture();
  const pending = deferred<WalletSession>();
  const connected = session();
  f.useConnect(() => pending.promise);
  const stop = f.connection.start();
  await setImmediate();
  stop();
  await setImmediate();
  assert.equal(f.watchers.size, 0);
  pending.resolve(connected.wallet);
  await setImmediate();
  assert.equal(connected.calls.dispose, 1);
  assert.equal(connected.calls.disconnect, 0);
  assert.equal(f.connection.getSnapshot().wallet, null);
  assert.equal(connected.calls.sign, 0);
  assert.equal(connected.calls.execute, 0);
});

test("unmount removes discovery and locally disposes an established session", async () => {
  const f = fixture();
  const stop = f.connection.start();
  await setImmediate();
  const connected = f.sessions[0];
  stop();
  await setImmediate();
  assert.equal(f.watchers.size, 0);
  assert.equal(connected.calls.dispose, 1);
  assert.equal(connected.calls.disconnect, 0);
  f.discover([]);
  f.discover([NATIVE]);
  await setImmediate();
  assert.equal(f.attempts.length, 1);
});

test("account invalidation clears the session and requires an explicit reconnect", async () => {
  const f = fixture();
  const stop = f.connection.start();
  try {
    await setImmediate();
    f.sessions[0].invalidate("The game wallet account changed. Reconnect.");
    assert.equal(f.connection.getSnapshot().wallet, null);
    assert.match(f.connection.getSnapshot().error, /account changed/);
    f.discover([]);
    f.discover([NATIVE]);
    await setImmediate();
    assert.equal(f.attempts.length, 1);
    await f.connection.connect(NATIVE.id);
    assert.equal(f.connection.getSnapshot().wallet, f.sessions[1].wallet);
  } finally {
    stop();
    await setImmediate();
  }
});

test("a stale invalidation cannot clear a newly connected account", async () => {
  const f = fixture();
  const stop = f.connection.start();
  try {
    await setImmediate();
    const previous = f.sessions[0];
    await f.connection.disconnect();
    const replacement = session(BOB);
    f.useConnect(async () => replacement.wallet);
    await f.connection.connect(NATIVE.id);
    previous.invalidateStale("Old wallet account changed.");
    assert.equal(f.connection.getSnapshot().wallet, replacement.wallet);
    assert.equal(f.connection.getSnapshot().error, "");
  } finally {
    stop();
    await setImmediate();
  }
});

test("repeated manual connection requests share a single in-flight attempt", async () => {
  const f = fixture([BROWSER]);
  const pending = deferred<WalletSession>();
  const connected = session();
  f.useConnect(() => pending.promise);
  const stop = f.connection.start();
  try {
    const first = f.connection.connect(BROWSER.id);
    const second = f.connection.connect(BROWSER.id);
    assert.equal(f.attempts.length, 1);
    pending.resolve(connected.wallet);
    await Promise.all([first, second]);
    assert.equal(f.attempts.length, 1);
    assert.equal(f.connection.getSnapshot().wallet, connected.wallet);
    assert.equal(f.connection.getSnapshot().pending, false);
  } finally {
    stop();
    await setImmediate();
  }
});

test("an initializing game signer reconnects after the delay and never signs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const connected = session();
  const pending = deferred<WalletSession>();
  let ready = false;
  f.useConnect(async () => {
    if (!ready) throw new GameWalletNotReadyError();
    return pending.promise;
  });
  const stop = f.connection.start();
  try {
    await setImmediate();
    assert.equal(f.attempts.length, 1);
    assert.equal(f.connection.getSnapshot().retrying, true);
    assert.equal(f.connection.getSnapshot().pending, false);
    assert.equal(f.connection.getSnapshot().error, "");
    ready = true;
    t.mock.timers.tick(999);
    await setImmediate();
    assert.equal(f.attempts.length, 1);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(f.attempts.length, 2);
    assert.equal(f.connection.getSnapshot().pending, true);
    assert.equal(f.connection.getSnapshot().retrying, false);
    f.discover();
    t.mock.timers.tick(100_000);
    await setImmediate();
    assert.equal(f.attempts.length, 2);
    pending.resolve(connected.wallet);
    await setImmediate();
    assert.equal(f.connection.getSnapshot().wallet, connected.wallet);
    assert.equal(f.connection.getSnapshot().retrying, false);
    assert.equal(f.connection.getSnapshot().pending, false);
    assert.equal(connected.calls.sign, 0);
    assert.equal(connected.calls.execute, 0);
  } finally {
    stop();
    await setImmediate();
  }
});

test("automatic readiness retries stop after six increasing delays", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.useConnect(async () => {
    throw new GameWalletNotReadyError();
  });
  const stop = f.connection.start();
  try {
    await setImmediate();
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    for (const [index, delay] of delays.entries()) {
      t.mock.timers.tick(delay - 1);
      await setImmediate();
      assert.equal(f.attempts.length, index + 1);
      t.mock.timers.tick(1);
      await setImmediate();
      assert.equal(f.attempts.length, index + 2);
    }
    assert.equal(f.connection.getSnapshot().retrying, false);
    assert.equal(f.connection.getSnapshot().pending, false);
    assert.match(f.connection.getSnapshot().error, /still initializing/);
    f.discover([]);
    f.discover([NATIVE]);
    t.mock.timers.tick(100_000);
    await setImmediate();
    assert.equal(f.attempts.length, 7);
  } finally {
    stop();
    await setImmediate();
  }
});

test("a manual browser connection cancels a scheduled native retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([NATIVE, BROWSER]);
  f.useConnect(async () => {
    throw new GameWalletNotReadyError();
  });
  const stop = f.connection.start();
  try {
    await setImmediate();
    const connected = session();
    f.useConnect(async () => connected.wallet);
    await f.connection.connect(BROWSER.id);
    t.mock.timers.tick(100_000);
    await setImmediate();
    assert.deepEqual(
      f.attempts.map(({ id }) => id),
      [NATIVE.id, BROWSER.id],
    );
    assert.equal(f.connection.getSnapshot().wallet, connected.wallet);
    assert.equal(f.connection.getSnapshot().retrying, false);
  } finally {
    stop();
    await setImmediate();
  }
});

test("manual disconnect cancels waiting for an uninitialized native wallet", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.useConnect(async () => {
    throw new GameWalletNotReadyError();
  });
  const stop = f.connection.start();
  try {
    await setImmediate();
    await f.connection.disconnect();
    assert.equal(f.connection.getSnapshot().retrying, false);
    f.discover([]);
    f.discover([NATIVE]);
    t.mock.timers.tick(100_000);
    await setImmediate();
    assert.equal(f.attempts.length, 1);
  } finally {
    stop();
    await setImmediate();
  }
});

test("real stop cancels scheduled readiness retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.useConnect(async () => {
    throw new GameWalletNotReadyError();
  });
  const stop = f.connection.start();
  await setImmediate();
  assert.equal(f.connection.getSnapshot().retrying, true);
  stop();
  await setImmediate();
  t.mock.timers.tick(100_000);
  await setImmediate();
  assert.equal(f.attempts.length, 1);
  assert.equal(f.connection.getSnapshot().retrying, false);
  assert.equal(f.watchers.size, 0);
});

test("StrictMode replay preserves a scheduled readiness retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const connected = session();
  f.useConnect(async () => {
    if (f.attempts.length === 1) throw new GameWalletNotReadyError();
    return connected.wallet;
  });
  const firstStop = f.connection.start();
  await setImmediate();
  firstStop();
  const stop = f.connection.start();
  try {
    await setImmediate();
    assert.equal(f.connection.getSnapshot().retrying, true);
    t.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(f.attempts.length, 2);
    assert.equal(f.watchers.size, 1);
    assert.equal(f.connection.getSnapshot().wallet, connected.wallet);
  } finally {
    stop();
    await setImmediate();
  }
});

test("a native account on another chain remains a single terminal attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  let walletCalls = 0;
  const nativeController = createWalletController({
    native: () => ({
      async callWallet() {
        walletCalls++;
        return {
          result: {
            accounts: [{ suiAddress: ALICE, chains: ["sui:testnet"] }],
          },
        };
      },
    }),
  });
  f.useConnect(() => nativeController.connectWallet(NATIVE.id, CONFIG));
  const stop = f.connection.start();
  try {
    await setImmediate();
    assert.equal(f.connection.getSnapshot().retrying, false);
    assert.match(f.connection.getSnapshot().error, /no account for sui:devnet/);
    t.mock.timers.tick(100_000);
    f.discover();
    await setImmediate();
    assert.equal(f.attempts.length, 1);
    assert.equal(walletCalls, 1);
  } finally {
    stop();
    await setImmediate();
  }
});

test("manual native retries do not schedule a new automatic retry sequence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.useConnect(async () => {
    throw new GameWalletNotReadyError();
  });
  const stop = f.connection.start();
  try {
    await setImmediate();
    await f.connection.connect(NATIVE.id);
    assert.equal(f.connection.getSnapshot().retrying, false);
    assert.match(f.connection.getSnapshot().error, /still initializing/);
    t.mock.timers.tick(100_000);
    await setImmediate();
    assert.equal(f.attempts.length, 2);
  } finally {
    stop();
    await setImmediate();
  }
});
