import { Transaction } from "@mysten/sui/transactions";
import { requireObjectId } from "../assembly/config.ts";
import type { AssemblyConfig } from "../assembly/types.ts";
import type { WalletSession } from "../wallet.ts";

export interface EnergySession {
  token: string;
  characterID: number;
  walletAddress: string;
  expiresAt: string | number;
}

export interface GridAssembly {
  itemID: number;
  typeID: number;
  name: string;
  assemblyStatus: string | number;
  energyRequired: number;
  energyUsed: number;
  distanceMeters?: number;
  networkNodeID?: number | null;
  canDisconnect?: boolean;
  disconnectReason?: string | null;
}

export type RadarStructureType =
  | "assembly"
  | "industry"
  | "storage_unit"
  | "gate"
  | "turret"
  | "network_node";

export interface RadarProduct {
  typeID: number;
  name: string;
  quantityPerRun: number;
}

export interface RadarAssembly {
  itemID: number;
  typeID: number;
  name: string;
  typeName: string;
  structureType: RadarStructureType;
  assemblyStatus: string | number;
  distanceMeters: number;
  relativePosition: { x: number; y: number; z: number };
  linkedToNode: boolean;
  industry: {
    state: "RUNNING" | "DISCONTINUING";
    jobID: number;
    runEndAtMs: number;
    products: RadarProduct[];
  } | null;
}

export interface EnergyGridStatus {
  networkNodeID: number;
  online: boolean;
  radiusMeters: number;
  maxEnergy: number;
  energyUsed: number;
  energyAvailable: number;
  connectedAssemblies: GridAssembly[];
  nearbyAssemblies: GridAssembly[];
  radarAssemblies: RadarAssembly[];
}

export class EnergyApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = "ENERGY_UNAVAILABLE", status = 0) {
    super(message);
    this.name = "EnergyApiError";
    this.code = code;
    this.status = status;
  }
}

export function energyItemId(value: string | number) {
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error("Select a valid game assembly ID.");
  return id;
}

export function gridConnectionBlockReason(entry: GridAssembly, action: "connect" | "disconnect", nodeID: number) {
  if (entry.networkNodeID && entry.networkNodeID !== nodeID) return "Connected to another node";
  if (entry.assemblyStatus !== 1) return "Take offline to change connection";
  if (action === "disconnect" && entry.canDisconnect === false)
    return entry.disconnectReason || "This connection cannot be changed";
  return "";
}

export function validateEnergyGridStatus(status: EnergyGridStatus, nodeID: string): EnergyGridStatus {
  if (!status || String(status.networkNodeID) !== nodeID)
    throw new Error("The server returned a different network node. Refresh the grid.");
  const validEnergy = (value: number) => Number.isFinite(value) && value >= 0;
  if (typeof status.online !== "boolean" || ![status.radiusMeters, status.maxEnergy, status.energyUsed, status.energyAvailable].every(validEnergy) ||
      !Array.isArray(status.connectedAssemblies) || !Array.isArray(status.nearbyAssemblies) ||
      (status.radarAssemblies !== undefined && !Array.isArray(status.radarAssemblies)))
    throw new Error("The server returned incomplete energy readings. Refresh the grid.");
  for (const entry of [...status.connectedAssemblies, ...status.nearbyAssemblies]) {
    energyItemId(entry.itemID);
    energyItemId(entry.typeID);
    if (![entry.energyRequired, entry.energyUsed].every(validEnergy))
      throw new Error("An assembly has incomplete energy readings. Refresh the grid.");
  }
  const structureTypes = new Set<RadarStructureType>(["assembly", "industry", "storage_unit", "gate", "turret", "network_node"]);
  const radarAssemblies = status.radarAssemblies || [];
  for (const entry of radarAssemblies) {
    energyItemId(entry.itemID);
    energyItemId(entry.typeID);
    const position = entry.relativePosition;
    if (!structureTypes.has(entry.structureType) || typeof entry.name !== "string" || typeof entry.typeName !== "string" ||
        typeof entry.linkedToNode !== "boolean" || !validEnergy(entry.distanceMeters) || entry.distanceMeters > status.radiusMeters ||
        !position || ![position.x, position.y, position.z].every(Number.isFinite))
      throw new Error("The server returned an invalid radar contact. Refresh the grid.");
    if (entry.industry) {
      if (!["RUNNING", "DISCONTINUING"].includes(entry.industry.state) ||
          !Number.isSafeInteger(entry.industry.jobID) || entry.industry.jobID <= 0 ||
          !Number.isSafeInteger(entry.industry.runEndAtMs) || entry.industry.runEndAtMs < 0 ||
          !Array.isArray(entry.industry.products) || entry.industry.products.some(product =>
            !Number.isSafeInteger(product.typeID) || product.typeID <= 0 || typeof product.name !== "string" ||
            !Number.isSafeInteger(product.quantityPerRun) || product.quantityPerRun <= 0))
        throw new Error("The server returned invalid Industry radar telemetry. Refresh the grid.");
    }
  }
  return status.radarAssemblies ? status : { ...status, radarAssemblies };
}

export function createEnergyClient(fetcher: typeof fetch = fetch, base = "/evejs/energy") {
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
      catch { throw new EnergyApiError(`The energy server returned an invalid response (HTTP ${response.status}). Refresh the grid before trying again.`, "INVALID_RESPONSE", response.status); }
      if (!response.ok || payload.success !== true || !payload.data)
        throw new EnergyApiError(payload.message || payload.errorMsg || `Energy request failed (HTTP ${response.status}).`, payload.errorMsg, response.status);
      return payload.data;
    } catch (error) {
      if (error instanceof EnergyApiError) throw error;
      throw new EnergyApiError("The energy server could not be reached. Refresh the grid to check whether the connection changed before trying again.");
    } finally { clearTimeout(timeout); }
  }
  function route(nodeID: string, action: string) {
    return `/${energyItemId(nodeID)}/${action}`;
  }
  return {
    async authenticate(wallet: WalletSession, config: AssemblyConfig): Promise<EnergySession> {
      if (config.network !== "localnet") throw new Error("Energy grid controls require the game's localnet deployment.");
      const challenge = await request<{ challengeId: string; transactionData: string }>("/auth/challenge", undefined, { walletAddress: wallet.address });
      const transaction = Transaction.from(challenge.transactionData);
      const data = transaction.getData();
      const address = requireObjectId(wallet.address, "Connected wallet");
      const payment = data.gasData.payment;
      // Authentication must contain only the server's synthetic gas reference.
      if (!challenge.challengeId || !transaction.isFullyResolved() || data.commands.length || data.inputs.length || data.expiration !== null ||
          requireObjectId(data.sender || "", "Challenge sender") !== address || requireObjectId(data.gasData.owner || "", "Challenge gas owner") !== address ||
          data.gasData.budget !== "1" || data.gasData.price !== "1" || payment?.length !== 1 || payment[0].version !== "1" || payment[0].digest !== "11111111111111111111111111111111")
        throw new Error("The energy connection challenge is invalid. Reconnect and try again.");
      const signed = await wallet.signTransaction(transaction, config);
      const session = await request<EnergySession>("/auth/session", undefined, { challengeId: challenge.challengeId, ...signed });
      if (requireObjectId(session.walletAddress, "Session wallet") !== requireObjectId(wallet.address, "Connected wallet") || !session.token ||
          !Number.isFinite(new Date(session.expiresAt).getTime()) || new Date(session.expiresAt).getTime() <= Date.now())
        throw new Error("The energy session expired or belongs to a different wallet. Reconnect and try again.");
      return session;
    },
    async status(nodeID: string, token: string) {
      return validateEnergyGridStatus(await request<EnergyGridStatus>(route(nodeID, "status"), token, {}), nodeID);
    },
    async connect(nodeID: string, token: string, assemblyID: number) {
      return validateEnergyGridStatus(await request<EnergyGridStatus>(route(nodeID, "connect"), token, { assemblyID: Number(energyItemId(assemblyID)) }), nodeID);
    },
    async disconnect(nodeID: string, token: string, assemblyID: number) {
      return validateEnergyGridStatus(await request<EnergyGridStatus>(route(nodeID, "disconnect"), token, { assemblyID: Number(energyItemId(assemblyID)) }), nodeID);
    },
  };
}
