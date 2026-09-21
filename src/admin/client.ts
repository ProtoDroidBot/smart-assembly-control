import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, SUI_CLOCK_OBJECT_ID, toBase64 } from "@mysten/sui/utils";
import { requireObjectId } from "../assembly/config.ts";
import { buildAssemblyTransaction } from "../assembly/transaction.ts";
import type {
  AssemblyAction,
  AssemblyConfig,
  AssemblySnapshot,
} from "../assembly/types.ts";
import type { WalletSession } from "../wallet.ts";

export interface AdminSession {
  token: string;
  characterID: number;
  walletAddress: string;
  expiresAt: string | number;
}

export interface PreparedAdminTransaction {
  transactionUUID: string;
  transactionData: string;
  expiresAt: string | number;
  action: AssemblyAction;
  assemblyID: number;
  assemblyObjectID: string;
  walletAddress: string;
  sponsorAddress: string;
  deployment: {
    network: string;
    chainId: string;
    packageId: string;
    objectRegistryId: string;
    adminAclId?: string;
    energyConfigId?: string;
    fuelConfigId?: string;
  };
}

/** Persist only the immutable operation, never the authentication token. */
export interface SignedAdminTransaction {
  transactionUUID: string;
  action: AssemblyAction;
  assemblyID: string;
  assemblyObjectID: string;
  walletAddress: string;
  bytes: string;
  signature: string;
  digest: string;
}

export interface AdminResult {
  transactionUUID: string;
  action: AssemblyAction;
  assemblyID: number;
  assemblyObjectID: string;
  digest: string;
  gameCommitted: boolean;
  replayed: boolean;
}

export class AdminApiError extends Error {
  readonly code: string;
  readonly digest?: string;
  constructor(message: string, code = "ADMIN_UNAVAILABLE", digest?: string) {
    super(message);
    this.name = "AdminApiError";
    this.code = code;
    this.digest = digest;
  }
}

/** The server guarantees these codes have no unresolved submitted transaction. */
export function adminOperationFinished(error: unknown) {
  return (
    error instanceof AdminApiError &&
    ["TRANSACTION_NOT_FOUND", "TRANSACTION_FAILED"].includes(error.code)
  );
}

export function adminItemId(
  assembly: AssemblySnapshot,
  config: AssemblyConfig,
) {
  if (config.network !== "localnet" || assembly.tenant !== "dev")
    throw new Error(
      "Sponsored admin actions require the game's localnet deployment and dev tenant.",
    );
  const id = assembly.itemId || "";
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error(
      "This assembly needs a valid game item ID for sponsored admin actions.",
    );
  return id;
}

type TransactionData = ReturnType<Transaction["getData"]>;
type MoveCall = NonNullable<TransactionData["commands"][number]["MoveCall"]>;
type Argument = MoveCall["arguments"][number];

/** Compare the complete command graph, resolving input indexes to reviewed objects. */
function validateReviewedCommands(
  transaction: Transaction,
  config: AssemblyConfig,
  assembly: AssemblySnapshot,
  action: AssemblyAction,
  deployment: PreparedAdminTransaction["deployment"],
) {
  const mismatch = (): never => {
    throw new Error(
      "The prepared admin transaction differs from the reviewed operation. Refresh and review again.",
    );
  };
  const objectId = (value: string) =>
    requireObjectId(value, "Transaction object");
  const expected = buildAssemblyTransaction(
    config,
    assembly,
    action,
    assembly.ownerAddress,
  ).getData();
  const actual = transaction.getData();
  const used = new Set<number>();
  function input(
    data: TransactionData,
    index: number,
    reviewed = false,
  ): unknown[] {
    const value = data.inputs[index];
    if (!value) return mismatch();
    if (!reviewed) used.add(index);
    const ref = value.Object;
    if (ref?.Receiving)
      return [
        "receiving",
        objectId(ref.Receiving.objectId),
        ref.Receiving.version,
        ref.Receiving.digest,
      ];
    if (ref?.SharedObject)
      return ["object", objectId(ref.SharedObject.objectId)];
    if (ref?.ImmOrOwnedObject)
      return ["object", objectId(ref.ImmOrOwnedObject.objectId)];
    if (reviewed && value.UnresolvedObject)
      return ["object", objectId(value.UnresolvedObject.objectId)];
    if (value.Pure) return ["pure", value.Pure.bytes];
    return mismatch();
  }
  function argument(
    data: TransactionData,
    value: Argument,
    indexes: Map<number, number>,
    commandIndex: number,
    reviewed = false,
  ): unknown[] {
    if (value.$kind === "Input") return input(data, value.Input, reviewed);
    if (value.$kind === "NestedResult") {
      const [index, result] = value.NestedResult;
      if (index >= commandIndex || !indexes.has(index)) return mismatch();
      return ["nested", indexes.get(index), result];
    }
    if (value.$kind === "Result") {
      if (value.Result >= commandIndex || !indexes.has(value.Result))
        return mismatch();
      return ["result", indexes.get(value.Result)];
    }
    // GasCoin and other argument kinds are not part of an admin status operation.
    return mismatch();
  }
  const equal = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);
  const packageId = objectId(config.packageId);
  const main: { call: MoveCall; index: number }[] = [];
  let withdrawnType: string | undefined;
  let depositedType: string | undefined;
  let withdrawal = false;
  let deposit = false;
  function fuelValue(value: Argument) {
    if (value.$kind !== "Input") return mismatch();
    const normalized = input(actual, value.Input);
    if (normalized[0] !== "pure") return mismatch();
    const bytes = fromBase64(String(normalized[1]));
    if (bytes.length !== 8) return mismatch();
    const number = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getBigUint64(0, true);
    if (number === 0n) return mismatch();
    return number.toString();
  }
  for (let index = 0; index < actual.commands.length; index++) {
    const call = actual.commands[index].MoveCall;
    if (!call) return mismatch();
    const isFuel =
      objectId(call.package) === packageId &&
      call.module === "network_node" &&
      ["deposit_fuel", "withdraw_fuel"].includes(call.function);
    if (!isFuel) {
      main.push({ call, index });
      continue;
    }
    // Legacy servers compensate the native burn clock only on this reviewed node.
    // Servers using chain fuel accounting omit these optional adjustments.
    if (
      assembly.kind !== "network_node" ||
      call.typeArguments.length ||
      !deployment.adminAclId
    )
      return mismatch();
    const withdrawing = call.function === "withdraw_fuel";
    if (withdrawing) {
      if (
        action !== "offline" ||
        withdrawal ||
        main.length !== 1 ||
        call.arguments.length !== 5
      )
        return mismatch();
      withdrawal = true;
    } else {
      if (
        deposit ||
        main.length !== expected.commands.length - 1 ||
        call.arguments.length !== 7
      )
        return mismatch();
      deposit = true;
    }
    const indexes = new Map([[0, 0]]);
    const args = call.arguments;
    if (
      !equal(argument(actual, args[0], indexes, index), [
        "object",
        objectId(assembly.id),
      ]) ||
      !equal(argument(actual, args[1], indexes, index), [
        "object",
        objectId(deployment.adminAclId),
      ]) ||
      !equal(argument(actual, args[2], indexes, index), ["nested", 0, 0])
    )
      return mismatch();
    const type = fuelValue(args[3]);
    if (withdrawing) {
      withdrawnType = type;
      fuelValue(args[4]);
    } else {
      depositedType = type;
      fuelValue(args[4]);
      const quantity = fuelValue(args[5]);
      if (
        (action === "online" && quantity !== "1") ||
        !equal(argument(actual, args[6], indexes, index), [
          "object",
          objectId(SUI_CLOCK_OBJECT_ID),
        ])
      )
        return mismatch();
    }
  }
  if (
    (withdrawnType && depositedType && withdrawnType !== depositedType) ||
    main.length !== expected.commands.length
  )
    return mismatch();
  const actualIndexes = new Map(
    main.map(({ index }, position) => [index, position]),
  );
  const expectedIndexes = new Map(
    expected.commands.map((_, index) => [index, index]),
  );
  function normalizedCall(
    call: MoveCall,
    data: TransactionData,
    indexes: Map<number, number>,
    index: number,
    reviewed = false,
  ) {
    return [
      objectId(call.package),
      call.module,
      call.function,
      call.typeArguments.map((type) =>
        type.replace(/0x[\da-f]+(?=::)/gi, objectId),
      ),
      call.arguments.map((value) =>
        argument(data, value, indexes, index, reviewed),
      ),
    ];
  }
  for (let position = 0; position < main.length; position++) {
    const reviewed = expected.commands[position].MoveCall;
    if (
      !reviewed ||
      !equal(
        normalizedCall(
          main[position].call,
          actual,
          actualIndexes,
          main[position].index,
        ),
        normalizedCall(reviewed, expected, expectedIndexes, position, true),
      )
    )
      return mismatch();
  }
  if (used.size !== actual.inputs.length) return mismatch();
}

/** Check the prepared operation before opening the wallet; no gas lookup is allowed. */
export async function validatePreparedAdminTransaction(
  prepared: PreparedAdminTransaction,
  config: AssemblyConfig,
  assembly: AssemblySnapshot,
  action: AssemblyAction,
  walletAddress: string,
) {
  const id = adminItemId(assembly, config);
  const same = (left: string, right: string) =>
    requireObjectId(left, "Prepared transaction address") ===
    requireObjectId(right, "Expected address");
  if (
    !prepared ||
    !prepared.deployment ||
    prepared.deployment.network !== config.network ||
    !prepared.deployment.chainId ||
    !same(prepared.deployment.packageId, config.packageId) ||
    !same(prepared.deployment.objectRegistryId, config.objectRegistryId) ||
    !same(prepared.assemblyObjectID, assembly.id) ||
    String(prepared.assemblyID) !== id ||
    prepared.action !== action ||
    !same(prepared.walletAddress, walletAddress) ||
    !prepared.transactionUUID ||
    !Number.isFinite(new Date(prepared.expiresAt).getTime()) ||
    new Date(prepared.expiresAt).getTime() <= Date.now()
  )
    throw new Error(
      "The prepared admin operation expired or differs from your review. Refresh and review again.",
    );
  const transaction = Transaction.from(prepared.transactionData);
  const data = transaction.getData();
  if (
    !data.sender ||
    !same(data.sender, walletAddress) ||
    !data.gasData.owner ||
    !same(data.gasData.owner, prepared.sponsorAddress) ||
    same(data.gasData.owner, walletAddress) ||
    !data.gasData.payment?.length ||
    !data.gasData.budget ||
    !data.gasData.price
  )
    throw new Error(
      "The server did not prepare a transaction with sponsored gas. Refresh and try again.",
    );
  const bytes = toBase64(await transaction.build());
  if (bytes !== prepared.transactionData)
    throw new Error("The server returned invalid prepared transaction bytes.");
  validateReviewedCommands(
    transaction,
    config,
    assembly,
    action,
    prepared.deployment,
  );
  return { transaction, bytes, digest: await transaction.getDigest() };
}

export function adminRecoveryKey(
  config: AssemblyConfig,
  assemblyId: string,
  walletAddress: string,
) {
  return `admin-transaction:${config.network}:${config.packageId}:${assemblyId}:${walletAddress}`;
}

export function readAdminRecovery(
  value: string | null,
  assemblyId: string,
  walletAddress: string,
): SignedAdminTransaction | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as SignedAdminTransaction;
    if (
      !record ||
      record.assemblyObjectID !== assemblyId ||
      record.walletAddress !== walletAddress ||
      !/^[1-9]\d*$/.test(record.assemblyID) ||
      !Number.isSafeInteger(Number(record.assemblyID)) ||
      !["online", "offline"].includes(record.action) ||
      ![
        record.transactionUUID,
        record.bytes,
        record.signature,
        record.digest,
      ].every((v) => typeof v === "string" && v.length > 0)
    )
      throw new Error("Invalid saved operation");
    return record;
  } catch {
    // Do not silently discard an unreadable operation and allow a duplicate write.
    throw new Error(
      "The saved admin operation could not be read. Check transaction activity before clearing this page's session storage.",
    );
  }
}

export function createAdminClient(
  fetcher: typeof fetch = fetch,
  base = "/evejs/admin",
) {
  async function request<T>(
    route: string,
    token: string | undefined,
    body: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetcher(`${base}${route}`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      let payload: {
        success?: boolean;
        data?: T;
        message?: string;
        errorMsg?: string;
        params?: { digest?: string };
      };
      try {
        payload = await response.json();
      } catch {
        throw new AdminApiError(
          `The admin server returned an invalid response (HTTP ${response.status}). Check the existing operation before trying again.`,
          "INVALID_RESPONSE",
        );
      }
      if (!response.ok || payload.success !== true || !payload.data)
        throw new AdminApiError(
          payload.message ||
            payload.errorMsg ||
            `Admin request failed (HTTP ${response.status}).`,
          payload.errorMsg,
          payload.params?.digest,
        );
      return payload.data;
    } catch (error) {
      if (error instanceof AdminApiError) throw error;
      throw new AdminApiError(
        "The admin server could not be reached or did not respond in time. A submitted transaction may still complete; use Check transaction to recover the same operation.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  function route(id: string, action: string) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
      throw new Error("Select a valid game assembly ID.");
    return `/${id}/${action}`;
  }
  return {
    async authenticate(
      wallet: WalletSession,
      config: AssemblyConfig,
    ): Promise<AdminSession> {
      if (config.network !== "localnet")
        throw new Error("Sponsored admin actions require localnet.");
      const challenge = await request<{
        challengeId: string;
        transactionData: string;
      }>("/auth/challenge", undefined, { walletAddress: wallet.address });
      const transaction = Transaction.from(challenge.transactionData);
      const data = transaction.getData();
      const address = requireObjectId(wallet.address, "Connected wallet");
      const payment = data.gasData.payment;
      // Connection challenges use a synthetic gas reference, contain no calls,
      // and cannot authorize a state change under the guise of authentication.
      if (
        typeof challenge.challengeId !== "string" ||
        !challenge.challengeId ||
        !transaction.isFullyResolved() ||
        data.commands.length ||
        data.inputs.length ||
        data.expiration !== null ||
        requireObjectId(data.sender || "", "Challenge sender") !== address ||
        requireObjectId(data.gasData.owner || "", "Challenge gas owner") !==
          address ||
        data.gasData.budget !== "1" ||
        data.gasData.price !== "1" ||
        payment?.length !== 1 ||
        payment[0].version !== "1" ||
        payment[0].digest !== "11111111111111111111111111111111"
      )
        throw new Error(
          "The admin connection challenge is invalid. No transaction was signed; reconnect and try again.",
        );
      const signed = await wallet.signTransaction(transaction, config);
      const session = await request<AdminSession>("/auth/session", undefined, {
        challengeId: challenge.challengeId,
        ...signed,
      });
      if (
        requireObjectId(session.walletAddress, "Session wallet") !==
          requireObjectId(wallet.address, "Connected wallet") ||
        !session.token
      )
        throw new Error(
          "The admin session belongs to a different wallet. Reconnect and try again.",
        );
      return session;
    },
    prepare: (
      assembly: AssemblySnapshot,
      config: AssemblyConfig,
      token: string,
      action: AssemblyAction,
    ) =>
      request<PreparedAdminTransaction>(
        route(adminItemId(assembly, config), "prepare"),
        token,
        {
          action,
          tenant: assembly.tenant,
          expectedAssemblyObjectID: requireObjectId(assembly.id, "Assembly ID"),
          expectedPackageId: requireObjectId(
            config.packageId,
            "World package ID",
          ),
          expectedObjectRegistryId: requireObjectId(
            config.objectRegistryId,
            "Object registry ID",
          ),
        },
      ),
    async execute(
      token: string,
      signed: SignedAdminTransaction,
    ): Promise<AdminResult> {
      const result = await request<AdminResult>(
        route(signed.assemblyID, "execute"),
        token,
        {
          action: signed.action,
          transactionUUID: signed.transactionUUID,
          bytes: signed.bytes,
          signature: signed.signature,
        },
      );
      if (
        result.transactionUUID !== signed.transactionUUID ||
        result.digest !== signed.digest ||
        result.action !== signed.action ||
        String(result.assemblyID) !== signed.assemblyID ||
        requireObjectId(result.assemblyObjectID, "Result assembly") !==
          requireObjectId(signed.assemblyObjectID, "Expected assembly") ||
        result.gameCommitted !== true
      )
        throw new AdminApiError(
          "The transaction result is not confirmed in the game. Check this transaction again before starting another.",
          "TRANSACTION_PENDING",
          signed.digest,
        );
      return result;
    },
  };
}
