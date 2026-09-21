import {
  connectWallet,
  GameWalletNotReadyError,
  listWallets,
  NATIVE_WALLET_ID,
  watchWallets,
  type WalletConfig,
  type WalletOption,
  type WalletSession,
} from "./wallet.ts";

interface ConnectionState {
  wallets: WalletOption[];
  wallet: WalletSession | null;
  pending: boolean;
  retrying: boolean;
  error: string;
}

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Own the page's wallet lifecycle independently of assembly loading. */
export function createWalletConnection(
  config: WalletConfig,
  controller = { listWallets, watchWallets, connectWallet },
) {
  let state: ConnectionState = {
    wallets: [],
    wallet: null,
    pending: false,
    retrying: false,
    error: "",
  };
  const listeners = new Set<() => void>();
  let active = false;
  let lifecycle = 0;
  let attempt = 0;
  let autoAttempted = false;
  let retries = 0;
  let retryVersion = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopSession: (() => void) | undefined;

  function update(next: Partial<ConnectionState>) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  }

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function cancelRetry() {
    retryVersion++;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    if (state.retrying) update({ retrying: false });
  }

  async function establish(id: string, automatic = false) {
    if (!active || state.pending || state.wallet) return;
    const token = ++attempt;
    const retryToken = retryVersion;
    update({ pending: true, retrying: false, error: "" });
    try {
      const session = await controller.connectWallet(id, config);
      if (!active || token !== attempt) {
        session.dispose();
        return;
      }
      update({ wallet: session });
      stopSession = session.subscribe((reason) => {
        if (state.wallet !== session) return;
        // Account/network changes require a new explicit connection and review.
        autoAttempted = true;
        stopSession?.();
        stopSession = undefined;
        session.dispose();
        update({ wallet: null, error: reason });
      });
    } catch (error) {
      if (active && token === attempt) {
        if (
          automatic &&
          id === NATIVE_WALLET_ID &&
          error instanceof GameWalletNotReadyError &&
          retryToken === retryVersion &&
          retries < RETRY_DELAYS.length
        ) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (active && retryToken === retryVersion)
              void establish(NATIVE_WALLET_ID, true);
          }, RETRY_DELAYS[retries++]);
          update({ retrying: true, error: "" });
        } else {
          update({ error: errorMessage(error), retrying: false });
        }
      }
    } finally {
      if (active && token === attempt) update({ pending: false });
    }
  }

  function discover() {
    if (!active) return;
    update({ wallets: controller.listWallets() });
    if (
      !autoAttempted &&
      !state.wallet &&
      !state.pending &&
      state.wallets.some((wallet) => wallet.id === NATIVE_WALLET_ID)
    ) {
      autoAttempted = true;
      void establish(NATIVE_WALLET_ID, true);
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      active = true;
      const token = ++lifecycle;
      const stopDiscovery = controller.watchWallets(discover);
      // Subscribe before reading so late bridge/Wallet Standard registration is seen.
      discover();
      return () => {
        stopDiscovery();
        if (token !== lifecycle) return;
        active = false;
        // React StrictMode immediately restarts effects. Keep its in-flight
        // connection, but release sessions and invalidate late results on unmount.
        queueMicrotask(() => {
          if (active || token !== lifecycle) return;
          attempt++;
          cancelRetry();
          stopSession?.();
          stopSession = undefined;
          state.wallet?.dispose();
          update({ wallet: null, pending: false });
        });
      };
    },
    async connect(id: string) {
      autoAttempted = true;
      cancelRetry();
      await establish(id);
    },
    async disconnect() {
      autoAttempted = true;
      cancelRetry();
      if (!active || state.pending) return;
      const session = state.wallet;
      if (!session) return;
      const token = ++attempt;
      stopSession?.();
      stopSession = undefined;
      update({ wallet: null, pending: true, error: "" });
      try {
        await session.disconnect();
      } catch (error) {
        if (active && token === attempt) update({ error: errorMessage(error) });
      } finally {
        session.dispose();
        if (active && token === attempt) update({ pending: false });
      }
    },
  };
}
