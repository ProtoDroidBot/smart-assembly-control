import { Transaction } from "@mysten/sui/transactions";
import { requireObjectId } from "../assembly/config.ts";
import type { AssemblyConfig } from "../assembly/types.ts";
import type { WalletSession } from "../wallet.ts";

export interface GateSession {
  token: string;
  characterID: number;
  walletAddress: string;
  expiresAt: string | number;
}

export interface GateEntry {
  itemID: number;
  typeID: number;
  name: string;
  solarSystemID: number;
  assemblyStatus: string | number;
  destinationGateID: number | null;
  rangeLightYears: number;
}

export interface GateCandidate extends GateEntry {
  distanceLightYears: number | null;
  distanceMeters?: string | null;
  eligible: boolean;
  reason: string | null;
}

export interface GateStatus {
  gate: GateEntry;
  destination: GateEntry | null;
  candidates: GateCandidate[];
  rangeLightYears: number;
  chain: {
    status: "disabled" | "pending" | "synced" | "error";
    message?: string;
    gateObjectID?: string;
    linkedGateObjectID?: string | null;
    maxDistanceMeters?: string;
  };
}

export const METERS_PER_LIGHT_YEAR = 9460730472580800;

export class GateApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = "GATE_UNAVAILABLE", status = 0) {
    super(message);
    this.name = "GateApiError";
    this.code = code;
    this.status = status;
  }
}

export function gateItemId(value: string | number) {
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error("Select a valid game gate ID.");
  return id;
}

const eligibilityReasons: Record<string, string> = {
  ASSEMBLY_UNDER_CONSTRUCTION: "Finish constructing both gates",
  ASSEMBLY_ACTIVATING: "Wait for gate activation to finish",
  SMART_GATE_MUST_BE_OFFLINE: "Take both gates offline before linking",
  SMART_GATE_SAME_SYSTEM: "Choose a gate in another solar system",
  SMART_GATE_ALREADY_LINKED: "One of these gates already has a destination",
  SMART_GATE_LINK_NOT_SUPPORTED: "This type does not support paired links",
  SMART_GATE_SYSTEM_DATA_UNAVAILABLE: "Gate distance is unavailable",
  SMART_GATE_OUT_OF_RANGE: "Outside the configured link range",
  SMART_GATE_TYPE_MISMATCH: "Choose a gate of the same type",
};

export function gateLinkBlockReason(status: GateStatus, candidate: GateCandidate) {
  if (status.gate.destinationGateID) return "Unlink the current destination first";
  if (status.chain.status !== "synced") return "Sync the gate with the blockchain before linking";
  if (candidate.itemID === status.gate.itemID) return "A gate cannot link to itself";
  if (candidate.typeID !== status.gate.typeID) return "Choose a gate of the same type";
  if (candidate.destinationGateID) return "This gate already has a destination";
  if (candidate.distanceLightYears === null) return "Gate distance is unavailable";
  if (status.rangeLightYears <= 0) return "The gate's link range is unavailable";
  if (candidate.distanceLightYears > status.rangeLightYears)
    return "Outside the configured link range";
  if (!candidate.eligible) return (candidate.reason && eligibilityReasons[candidate.reason]) || "This gate cannot be linked";
  return "";
}

export function validateGateStatus(status: GateStatus, gateID: string) {
  if (!status?.gate || String(status.gate.itemID) !== gateID)
    throw new Error("The server returned a different gate. Refresh the gate links.");
  const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const validEntry = (entry: GateEntry) => {
    gateItemId(entry.itemID);
    gateItemId(entry.typeID);
    if (entry.destinationGateID !== null && entry.destinationGateID !== 0)
      gateItemId(entry.destinationGateID);
    if (typeof entry.name !== "string" || !nonnegative(entry.rangeLightYears))
      throw new Error("The server returned incomplete gate details. Refresh the gate links.");
  };
  if (!nonnegative(status.rangeLightYears) || !Array.isArray(status.candidates) ||
      !status.chain || !["disabled", "pending", "synced", "error"].includes(status.chain.status) ||
      (status.chain.maxDistanceMeters !== undefined && !/^\d+$/.test(status.chain.maxDistanceMeters)))
    throw new Error("The server returned incomplete gate readings. Refresh the gate links.");
  validEntry(status.gate);
  if (status.destination !== null) {
    if (!status.destination) throw new Error("The gate destination is unavailable. Refresh the gate links.");
    validEntry(status.destination);
    if (status.destination.itemID !== status.gate.destinationGateID)
      throw new Error("The gate destination changed. Refresh the gate links.");
  }
  const candidateIDs = new Set<number>();
  for (const entry of status.candidates) {
    validEntry(entry);
    if (candidateIDs.has(entry.itemID) || typeof entry.eligible !== "boolean" ||
        (entry.distanceMeters != null && !/^\d+$/.test(entry.distanceMeters)) ||
        (entry.distanceLightYears !== null && !nonnegative(entry.distanceLightYears)))
      throw new Error("The server returned incomplete candidate readings. Refresh the gate links.");
    candidateIDs.add(entry.itemID);
  }
  return status;
}

export function createGateClient(fetcher: typeof fetch = fetch, base = "/evejs/gates") {
  async function request<T>(route: string, token: string | undefined, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetcher(`${base}${route}`, {
        method: "POST", cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      let payload: { success?: boolean; data?: T; message?: string; errorMsg?: string };
      try { payload = await response.json(); }
      catch { throw new GateApiError(`The gate server returned an invalid response (HTTP ${response.status}). Refresh the gate links before trying again.`, "INVALID_RESPONSE", response.status); }
      if (!response.ok || payload.success !== true || !payload.data)
        throw new GateApiError(payload.message || payload.errorMsg || `Gate request failed (HTTP ${response.status}).`, payload.errorMsg, response.status);
      return payload.data;
    } catch (error) {
      if (error instanceof GateApiError) throw error;
      throw new GateApiError("The gate server could not be reached. Refresh the gate links to check whether the destination changed before trying again.");
    } finally { clearTimeout(timeout); }
  }
  function route(gateID: string, action: string) {
    return `/${gateItemId(gateID)}/${action}`;
  }
  return {
    async authenticate(wallet: WalletSession, config: AssemblyConfig): Promise<GateSession> {
      if (config.network !== "localnet") throw new Error("Gate controls require the game's localnet deployment.");
      const challenge = await request<{ challengeId: string; transactionData: string }>("/auth/challenge", undefined, { walletAddress: wallet.address });
      const transaction = Transaction.from(challenge.transactionData);
      const data = transaction.getData();
      const address = requireObjectId(wallet.address, "Connected wallet");
      const payment = data.gasData.payment;
      // Authentication may contain only the server's synthetic gas reference.
      if (!challenge.challengeId || !transaction.isFullyResolved() || data.commands.length || data.inputs.length || data.expiration !== null ||
          requireObjectId(data.sender || "", "Challenge sender") !== address || requireObjectId(data.gasData.owner || "", "Challenge gas owner") !== address ||
          data.gasData.budget !== "1" || data.gasData.price !== "1" || payment?.length !== 1 || payment[0].version !== "1" || payment[0].digest !== "11111111111111111111111111111111")
        throw new Error("The gate connection challenge is invalid. Reconnect and try again.");
      const signed = await wallet.signTransaction(transaction, config);
      const session = await request<GateSession>("/auth/session", undefined, { challengeId: challenge.challengeId, ...signed });
      if (requireObjectId(session.walletAddress, "Session wallet") !== address || !session.token ||
          !Number.isFinite(new Date(session.expiresAt).getTime()) || new Date(session.expiresAt).getTime() <= Date.now())
        throw new Error("The gate session expired or belongs to a different wallet. Reconnect and try again.");
      return session;
    },
    async status(gateID: string, token: string) {
      return validateGateStatus(await request<GateStatus>(route(gateID, "status"), token, {}), gateID);
    },
    async link(gateID: string, token: string, destinationGateID: number) {
      return validateGateStatus(await request<GateStatus>(route(gateID, "link"), token, { destinationGateID: Number(gateItemId(destinationGateID)) }), gateID);
    },
    async unlink(gateID: string, token: string, destinationGateID: number) {
      return validateGateStatus(await request<GateStatus>(route(gateID, "unlink"), token, { destinationGateID: Number(gateItemId(destinationGateID)) }), gateID);
    },
    async sync(gateID: string, token: string) {
      return validateGateStatus(await request<GateStatus>(route(gateID, "sync"), token, {}), gateID);
    },
  };
}
