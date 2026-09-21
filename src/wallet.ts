import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  isValidSuiAddress,
  normalizeSuiAddress,
  toBase64,
} from "@mysten/sui/utils";
import {
  getWallets,
  signTransaction,
  signAndExecuteTransaction,
  type Wallet,
  type WalletAccount,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
  type SuiWalletFeatures,
} from "@mysten/wallet-standard";

export interface WalletConfig {
  network: string;
  rpcUrl: string;
}

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
}

export interface WalletSession {
  address: string;
  name: string;
  chain: `sui:${string}`;
  /** Release this page's listeners without disconnecting the wallet provider. */
  dispose(): void;
  disconnect(): Promise<void>;
  subscribe(onInvalidated: (reason: string) => void): () => void;
  signTransaction(
    transaction: Transaction,
    config: WalletConfig,
  ): Promise<{ bytes: string; signature: string }>;
  signAndExecute(
    transaction: Transaction,
    config: WalletConfig,
  ): Promise<{ digest: string }>;
}

interface NativeRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface NativeBridge {
  callWallet(request: NativeRequest): Promise<unknown>;
  WALLET_API_CHAIN?: string;
}

declare global {
  interface Window {
    callWallet?: NativeBridge["callWallet"];
    WALLET_API_CHAIN?: string;
  }
}

type Features = Partial<
  StandardConnectFeature &
    StandardDisconnectFeature &
    StandardEventsFeature &
    SuiWalletFeatures
>;
type Registry = ReturnType<typeof getWallets>;
type Client = Pick<
  SuiJsonRpcClient,
  "executeTransactionBlock" | "waitForTransaction"
>;

/** Dependency injection keeps wallet checks testable without opening a wallet or submitting a transaction. */
export interface WalletEnvironment {
  registry?: () => Registry;
  native?: () => NativeBridge | undefined;
  client?: (config: WalletConfig) => Client;
}

/** The injected bridge is ready before the game's signer has initialized. */
export class GameWalletNotReadyError extends Error {
  constructor() {
    super(
      "The game wallet is still initializing. Connect again when it is ready.",
    );
    this.name = "GameWalletNotReadyError";
  }
}

/** A digest can exist even when confirmation fails; callers should keep it visible and must not retry automatically. */
export class TransactionSubmissionError extends Error {
  readonly digest: string;

  constructor(message: string, digest: string) {
    super(message);
    this.name = "TransactionSubmissionError";
    this.digest = digest;
  }
}

export const NATIVE_WALLET_ID = "eve-frontier-native";
const SIGN_FEATURES = [
  "sui:signTransaction",
  "sui:signTransactionBlock",
  "sui:signAndExecuteTransaction",
  "sui:signAndExecuteTransactionBlock",
] as const;

function sameAddress(a: string, b: string) {
  return (
    isValidSuiAddress(a) &&
    isValidSuiAddress(b) &&
    normalizeSuiAddress(a) === normalizeSuiAddress(b)
  );
}

function features(wallet: Wallet): Features {
  return wallet.features as Features;
}

function supportsSigning(wallet: Wallet, account?: WalletAccount) {
  return SIGN_FEATURES.some(
    (feature) =>
      features(wallet)[feature] &&
      (!account || account.features.includes(feature)),
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createWalletController(environment: WalletEnvironment = {}) {
  const registry = environment.registry ?? getWallets;
  const native =
    environment.native ??
    (() => {
      if (
        typeof window === "undefined" ||
        typeof window.callWallet !== "function"
      )
        return undefined;
      return {
        callWallet: window.callWallet.bind(window),
        WALLET_API_CHAIN: window.WALLET_API_CHAIN,
      };
    });
  const createClient =
    environment.client ??
    ((config: WalletConfig) =>
      new SuiJsonRpcClient({
        network: config.network,
        url: config.rpcUrl,
      }));
  const ids = new WeakMap<Wallet, string>();
  let nextWalletId = 0;
  let nextRequestId = 0;

  function walletId(wallet: Wallet) {
    let id = ids.get(wallet);
    if (!id) {
      id = `standard-${++nextWalletId}`;
      ids.set(wallet, id);
    }
    return id;
  }

  function listWallets(): WalletOption[] {
    const options: WalletOption[] = native()
      ? [{ id: NATIVE_WALLET_ID, name: "EVE Frontier game wallet" }]
      : [];
    for (const wallet of registry().get()) {
      if (features(wallet)["standard:connect"] && supportsSigning(wallet)) {
        options.push({
          id: walletId(wallet),
          name: wallet.name,
          icon: wallet.icon,
        });
      }
    }
    return options;
  }

  function watchWallets(onChange: () => void) {
    const offRegister = registry().on("register", onChange);
    const offUnregister = registry().on("unregister", onChange);
    // The embedded bridge may appear after the page's module scripts start.
    let embedded = Boolean(native());
    const interval = setInterval(() => {
      const current = Boolean(native());
      if (current !== embedded) {
        embedded = current;
        onChange();
      }
    }, 1000);
    return () => {
      clearInterval(interval);
      offRegister();
      offUnregister();
    };
  }

  async function nativeRequest(
    bridge: NativeBridge,
    method: string,
    params: Record<string, unknown> = {},
  ) {
    let response = await bridge.callWallet({
      jsonrpc: "2.0",
      id: ++nextRequestId,
      method,
      params,
    });
    if (typeof response === "string") response = JSON.parse(response);
    if (!response || typeof response !== "object")
      throw new Error("The game wallet returned an invalid response.");
    const envelope = response as {
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    if (envelope.error)
      throw new Error(
        envelope.error.message ||
          `Game wallet error ${envelope.error.code ?? "unknown"}.`,
      );
    if (!("result" in envelope))
      throw new Error("The game wallet response is missing its result.");
    return envelope.result;
  }

  async function nativeAccount(bridge: NativeBridge, chain: string) {
    if (bridge.WALLET_API_CHAIN && bridge.WALLET_API_CHAIN !== chain) {
      throw new Error(
        `The game wallet uses ${bridge.WALLET_API_CHAIN}; this dApp is configured for ${chain}.`,
      );
    }
    const result = (await nativeRequest(bridge, "connect")) as {
      accounts?: { suiAddress?: string; chains?: string[] }[];
    };
    if (
      !Array.isArray(result?.accounts) ||
      result.accounts.some(
        (candidate) =>
          !candidate ||
          typeof candidate.suiAddress !== "string" ||
          !Array.isArray(candidate.chains) ||
          candidate.chains.some((chain) => typeof chain !== "string"),
      )
    ) {
      throw new Error("The game wallet returned an invalid accounts response.");
    }
    if (result.accounts.length === 0) throw new GameWalletNotReadyError();
    const account = result?.accounts?.find((candidate) =>
      candidate.chains?.includes(chain),
    );
    if (!account?.suiAddress || !isValidSuiAddress(account.suiAddress)) {
      throw new Error(
        `The game wallet has no account for ${chain}. Check the dApp network configuration.`,
      );
    }
    return normalizeSuiAddress(account.suiAddress);
  }

  async function connectWallet(
    id: string,
    config: WalletConfig,
  ): Promise<WalletSession> {
    const chain: `sui:${string}` = `sui:${config.network}`;
    const initialConfig = { ...config };
    let wallet: Wallet | undefined;
    let account: WalletAccount | undefined;
    let address: string;
    let name: string;
    if (id === NATIVE_WALLET_ID) {
      const bridge = native();
      if (!bridge)
        throw new Error(
          "The game wallet is unavailable. Open this dApp inside EVE Frontier.",
        );
      address = await nativeAccount(bridge, chain);
      name = "EVE Frontier game wallet";
    } else {
      wallet = registry()
        .get()
        .find((candidate) => walletId(candidate) === id);
      if (!wallet)
        throw new Error(
          "That wallet is no longer available. Refresh the wallet list.",
        );
      const connect = features(wallet)["standard:connect"];
      if (!connect) throw new Error("This wallet does not support connecting.");
      const connected = await connect.connect();
      account = connected.accounts.find(
        (candidate) =>
          candidate.chains.includes(chain) &&
          supportsSigning(wallet!, candidate),
      );
      if (!account || !isValidSuiAddress(account.address)) {
        throw new Error(
          `No signing account is available for ${chain}. Select that network in your wallet and reconnect.`,
        );
      }
      address = normalizeSuiAddress(account.address);
      name = wallet.name;
    }

    const listeners = new Set<(reason: string) => void>();
    const cleanup: (() => void)[] = [];
    let invalidReason = "";
    let signing = false;
    function invalidate(reason: string) {
      if (invalidReason) return;
      invalidReason = reason;
      cleanup.splice(0).forEach((dispose) => dispose());
      listeners.forEach((listener) => listener(reason));
    }
    function valid() {
      if (invalidReason) throw new Error(invalidReason);
    }
    async function checkAccount() {
      valid();
      if (wallet) {
        const current = wallet.accounts.find((candidate) =>
          sameAddress(candidate.address, address),
        );
        if (
          !registry().get().includes(wallet) ||
          !current ||
          !current.chains.includes(chain) ||
          !supportsSigning(wallet, current)
        ) {
          invalidate(
            "The wallet account or network changed. Reconnect before continuing.",
          );
        }
      } else {
        const bridge = native();
        if (
          !bridge ||
          !sameAddress(await nativeAccount(bridge, chain), address)
        ) {
          invalidate(
            "The game wallet account changed. Reconnect before continuing.",
          );
        }
      }
      valid();
    }
    if (wallet) {
      const events = features(wallet)["standard:events"];
      if (events)
        cleanup.push(
          events.on("change", () => {
            void checkAccount().catch((error: unknown) =>
              invalidate(message(error)),
            );
          }),
        );
      cleanup.push(
        registry().on("unregister", (...removed) => {
          if (wallet && removed.includes(wallet))
            invalidate("The wallet disconnected. Reconnect before continuing.");
        }),
      );
    } else {
      let checking = false;
      const interval = setInterval(() => {
        if (checking || signing) return;
        checking = true;
        void checkAccount()
          .catch((error: unknown) => invalidate(message(error)))
          .finally(() => {
            checking = false;
          });
      }, 5000);
      cleanup.push(() => clearInterval(interval));
    }

    return {
      address,
      name,
      chain,
      dispose() {
        listeners.clear();
        invalidate("Wallet session closed.");
      },
      subscribe(onInvalidated) {
        listeners.add(onInvalidated);
        if (invalidReason) onInvalidated(invalidReason);
        return () => {
          listeners.delete(onInvalidated);
        };
      },
      async disconnect() {
        invalidate("Wallet disconnected.");
        listeners.clear();
        if (wallet) await features(wallet)["standard:disconnect"]?.disconnect();
        // Native disconnection is local: the game's signer and login remain owned by the client.
      },
      async signTransaction(transaction, currentConfig) {
        valid();
        if (
          currentConfig.network !== initialConfig.network ||
          currentConfig.rpcUrl !== initialConfig.rpcUrl
        )
          throw new Error(
            "The network configuration changed. Reconnect before continuing.",
          );
        if (signing)
          throw new Error("A wallet request is already in progress.");
        signing = true;
        try {
          const sender = transaction.getData().sender;
          if (!sender || !sameAddress(sender, address))
            throw new Error(
              "The prepared transaction sender does not match the connected wallet.",
            );
          if (!transaction.isFullyResolved())
            throw new Error(
              "The prepared transaction is incomplete. Prepare and review the operation again.",
            );
          // Snapshot before awaiting the wallet. Sponsor gas and all reviewed inputs
          // must remain unchanged, and sign-only operations never resolve sender gas.
          const prepared = Transaction.from(transaction);
          await checkAccount();
          const originalBytes = toBase64(await prepared.build());
          const preparedJSON = await Transaction.from(originalBytes).toJSON();
          const wrapper = {
            toJSON: async () => preparedJSON,
          };
          let signed: { bytes: string; signature: string };
          if (wallet && account) {
            if (
              !(
                ["sui:signTransaction", "sui:signTransactionBlock"] as const
              ).some(
                (feature) =>
                  account!.features.includes(feature) &&
                  wallet!.features[feature],
              )
            )
              throw new Error(
                "This wallet cannot sign without submitting. Prepared operations require transaction signing.",
              );
            signed = await signTransaction(
              wallet as Wallet & { features: Features },
              { account, chain, transaction: wrapper },
            );
          } else {
            const bridge = native();
            if (!bridge) throw new Error("The game wallet is unavailable.");
            signed = (await nativeRequest(bridge, "signTransaction", {
              transaction: await wrapper.toJSON(),
            })) as typeof signed;
          }
          await checkAccount();
          if (
            !signed ||
            signed.bytes !== originalBytes ||
            typeof signed.signature !== "string" ||
            !signed.signature
          )
            throw new Error(
              "The wallet changed the prepared transaction or returned no signature. Prepare and review the operation again.",
            );
          return signed;
        } finally {
          signing = false;
        }
      },
      async signAndExecute(transaction, currentConfig) {
        valid();
        if (
          currentConfig.network !== initialConfig.network ||
          currentConfig.rpcUrl !== initialConfig.rpcUrl
        ) {
          throw new Error(
            "The network configuration changed. Reconnect before continuing.",
          );
        }
        if (signing)
          throw new Error("A wallet transaction is already in progress.");
        signing = true;
        let digest: string | undefined;
        try {
          await checkAccount();
          const sender = transaction.getData().sender;
          if (sender && !sameAddress(sender, address))
            throw new Error(
              "The transaction sender does not match the connected wallet.",
            );
          transaction.setSenderIfNotSet(address);
          const client = createClient(initialConfig);
          // Resolve through the configured RPC, including non-default Frontier networks.
          await transaction.build({ client: client as SuiJsonRpcClient });
          const transactionWrapper = {
            toJSON: () =>
              transaction.toJSON({ client: client as SuiJsonRpcClient }),
          };
          let signed: { bytes: string; signature: string } | undefined;
          if (wallet && account) {
            const signingWallet = wallet as Wallet & { features: Features };
            const canSign = (
              ["sui:signTransaction", "sui:signTransactionBlock"] as const
            ).some(
              (feature) =>
                account!.features.includes(feature) &&
                Boolean(wallet!.features[feature]),
            );
            if (canSign) {
              signed = await signTransaction(signingWallet, {
                account,
                chain,
                transaction: transactionWrapper,
              });
            } else {
              const result = await signAndExecuteTransaction(signingWallet, {
                account,
                chain,
                transaction: transactionWrapper,
              });
              digest = result.digest;
            }
          } else {
            const bridge = native();
            if (!bridge) throw new Error("The game wallet is unavailable.");
            signed = (await nativeRequest(bridge, "signTransaction", {
              transaction: await transactionWrapper.toJSON(),
            })) as typeof signed;
          }
          if (signed) {
            if (
              typeof signed.bytes !== "string" ||
              typeof signed.signature !== "string"
            )
              throw new Error(
                "The wallet did not return a signed transaction.",
              );
            const signedTransaction = Transaction.from(signed.bytes);
            const signedSender = signedTransaction.getData().sender;
            if (!signedSender || !sameAddress(signedSender, address))
              throw new Error(
                "The signed transaction uses a different wallet account. Reconnect before continuing.",
              );
            await checkAccount();
            // Derive the digest before submission so a lost RPC response still has an exact transaction to inspect.
            digest = await signedTransaction.getDigest();
            const submitted = await client.executeTransactionBlock({
              transactionBlock: signed.bytes,
              signature: signed.signature,
              options: { showEffects: true },
            });
            digest = submitted.digest;
            if (submitted.effects?.status.status === "failure") {
              throw new TransactionSubmissionError(
                `Transaction failed: ${submitted.effects.status.error || "Move execution failed"}`,
                digest,
              );
            }
          }
          if (!digest)
            throw new Error(
              "The wallet returned no transaction digest; check your wallet activity before trying again.",
            );
          const confirmed = await client.waitForTransaction({
            digest,
            options: { showEffects: true },
            timeout: 60_000,
          });
          if (confirmed.effects?.status.status !== "success") {
            throw new TransactionSubmissionError(
              confirmed.effects?.status.status === "failure"
                ? `Transaction failed: ${confirmed.effects.status.error || "Move execution failed"}`
                : "The transaction was submitted, but its execution status is unavailable. Check the digest before trying again.",
              digest,
            );
          }
          return { digest };
        } catch (error) {
          if (error instanceof TransactionSubmissionError) throw error;
          if (digest)
            throw new TransactionSubmissionError(
              `Transaction submitted; confirmation is unavailable. Check the digest before trying again. ${message(error)}`,
              digest,
            );
          throw error;
        } finally {
          signing = false;
        }
      },
    };
  }

  return { listWallets, watchWallets, connectWallet };
}

const controller = createWalletController();
export const listWallets = controller.listWallets;
export const watchWallets = controller.watchWallets;
export const connectWallet = controller.connectWallet;
