import { Transaction } from "@mysten/sui/transactions";
import { requireObjectId } from "../assembly/config.ts";
import type { AssemblyConfig } from "../assembly/types.ts";
import type { WalletSession } from "../wallet.ts";

export interface IndustrySession {
  token: string;
  characterID: number;
  walletAddress: string;
  expiresAt: string | number;
}

/** Keep quantities and timestamps as decimal strings, matching the server's u64 snapshot. */
export interface IndustryItemStack {
  type_id: string;
  quantity: string;
}

export interface IndustryRecipeSlot extends IndustryItemStack {
  max_quantity: string;
}

export interface IndustryProduction {
  job_id: string;
  state: "RUNNING" | "DISCONTINUING" | "STOPPED";
  requested_runs: string | null;
  completed_runs: string;
  run_started_at_ms: string;
  run_end_at_ms: string;
  stop_reason: string | null;
}

export interface IndustrySnapshot {
  owner_id: string;
  solar_system_id: string;
  blueprint_id: string;
  run_time: string;
  inputs: IndustryItemStack[];
  outputs: IndustryItemStack[];
  blueprint_inputs: IndustryRecipeSlot[];
  blueprint_outputs: IndustryRecipeSlot[];
}

export interface IndustryFacilitySnapshot {
  itemId: string;
  typeId: number;
  status: 1 | 2;
  snapshot: IndustrySnapshot;
  production: IndustryProduction | null;
}

export interface IndustryChainStatus {
  status: "disabled" | "pending" | "synced" | "error";
  assemblyObjectID?: string;
  industryObjectID?: string;
  revision?: string;
  observedAtMs?: string;
  syncedAtMs?: string;
  productionMirrored?: boolean;
  production?: IndustryProduction | null;
}

export interface IndustryStatus {
  facility: IndustryFacilitySnapshot;
  production: IndustryProduction | null;
  chain: IndustryChainStatus;
  /** Older status endpoints omit this; starting requires the server's selected recipe hash. */
  blueprintHash?: string | null;
}

export interface IndustryStartRequest {
  blueprintID: string;
  blueprintHash: string;
  runs: string | null;
  expectedJobID: string | null;
}

export interface IndustryStartResult extends IndustryStatus {
  gameCommitted: true;
  startedJobID: string;
}

export interface IndustryBlueprint {
  blueprintID: string;
  blueprintHash: string;
  name: string;
  runTime: string;
  inputs: IndustryRecipeSlot[];
  outputs: IndustryRecipeSlot[];
}

export interface IndustryBlueprintsResult { blueprints: IndustryBlueprint[] }

export interface IndustryBlueprintExpectation {
  expectedBlueprintID: string;
  expectedBlueprintHash: string | null;
  expectedJobID: string | null;
}

export interface IndustryBlueprintChangeRequest extends IndustryBlueprintExpectation {
  requestID: string;
  blueprintID: string;
  blueprintHash: string;
}

export interface IndustryBlueprintChangeResult extends IndustryStatus {
  requestID: string;
  gameCommitted: true;
  selectedBlueprintID: string;
}

export interface IndustryEmptyRequest extends IndustryBlueprintExpectation {
  requestID: string;
  storageUnitID: string;
}

export interface IndustryEmptyResult {
  requestID: string;
  gameCommitted: true;
  storageUnitID: number;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  chain: IndustryTransferChain;
}

export interface IndustryStorageItem {
  itemID: number;
  typeID: number;
  name: string;
  quantity: number;
  unitVolume: number;
}

export interface IndustryStorageUnit {
  storageUnitID: number;
  name: string;
  capacity: number;
  usedVolume: number;
  items: IndustryStorageItem[];
}

export interface IndustryStorageResult {
  storageUnits: IndustryStorageUnit[];
}

export interface IndustryTransferRequest {
  requestID: string;
  storageUnitID: string;
  direction: "deposit" | "withdraw";
  side: "inputs" | "outputs";
  typeID: string;
  quantity: string;
}

/** Storage inventory wire values are unsigned 32-bit type IDs and quantities. */
export const INDUSTRY_TRANSFER_MAX = 0xffffffff;

export interface IndustryTransferResult {
  requestID: string;
  gameCommitted: true;
  storageUnitID: number;
  direction: "deposit" | "withdraw";
  side: "inputs" | "outputs";
  items: Record<string, number>;
  chain: IndustryTransferChain;
}

export interface IndustryTransferChain {
  status: IndustryChainStatus["status"];
  industryStatus: IndustryChainStatus["status"];
  storageStatus: IndustryChainStatus["status"];
}

export class IndustryApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = "INDUSTRY_UNAVAILABLE", status = 0) {
    super(message);
    this.name = "IndustryApiError";
    this.code = code;
    this.status = status;
  }
}

export function industryItemId(value: string | number): string {
  const id = String(value);
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error("Select a valid game Industry facility ID.");
  return id;
}

function invalidStatus(): never {
  throw new IndustryApiError("The Industry server returned incomplete or inconsistent status. Refresh the facility.", "INVALID_RESPONSE");
}

function isU64(value: unknown, zero = false): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) &&
    value.length <= 20 && BigInt(value) <= 18446744073709551615n && (zero || value !== "0");
}

function isSafePositiveDecimal(value: unknown): value is string {
  return isU64(value) && Number.isSafeInteger(Number(value));
}

function isBlueprintHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validateBlueprintExpectation(value: IndustryBlueprintExpectation) {
  if (!value || !(value.expectedBlueprintID === "0" || isSafePositiveDecimal(value.expectedBlueprintID)) ||
      (value.expectedBlueprintID === "0" ? value.expectedBlueprintHash !== null : !isBlueprintHash(value.expectedBlueprintHash)) ||
      !(value.expectedJobID === null || isSafePositiveDecimal(value.expectedJobID)))
    throw new IndustryApiError("Refresh the active blueprint and production job before changing the facility.", "INVALID_BLUEPRINT_EXPECTATION");
}

function validateRequestID(value: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new IndustryApiError("Create a new request before changing the facility.", "INVALID_REQUEST_ID");
}

/** Capture reviewed recipe identity while allowing a queued empty action to run first. */
export function industryBlueprintExpectation(status: IndustryStatus): IndustryBlueprintExpectation {
  validateIndustryStatus(status, industryItemId(status?.facility?.itemId));
  if (status.production && status.production.state !== "STOPPED")
    throw new IndustryApiError("Finish or stop production before emptying or changing the active blueprint.", "PRODUCTION_ALREADY_RUNNING");
  const expected = { expectedBlueprintID: status.facility.snapshot.blueprint_id,
    expectedBlueprintHash: status.blueprintHash ?? null, expectedJobID: status.production?.job_id ?? null };
  validateBlueprintExpectation(expected);
  return expected;
}

export function validateIndustryBlueprintExpectation(status: IndustryStatus, expected: IndustryBlueprintExpectation) {
  validateBlueprintExpectation(expected);
  const current = industryBlueprintExpectation(status);
  if (current.expectedBlueprintID !== expected.expectedBlueprintID || current.expectedBlueprintHash !== expected.expectedBlueprintHash ||
      current.expectedJobID !== expected.expectedJobID)
    throw new IndustryApiError("The active blueprint or production job changed. Refresh and review this action again.", "BLUEPRINT_CHANGED");
}

function validateBlueprintsResult(value: IndustryBlueprintsResult) {
  if (!value || !Array.isArray(value.blueprints) || value.blueprints.length > 10000) invalidStatus();
  const ids = new Set<string>();
  for (const blueprint of value.blueprints) {
    if (!blueprint || !isSafePositiveDecimal(blueprint.blueprintID) || ids.has(blueprint.blueprintID) ||
        !isBlueprintHash(blueprint.blueprintHash) || typeof blueprint.name !== "string" || !isU64(blueprint.runTime)) invalidStatus();
    ids.add(blueprint.blueprintID);
    validateStacks(blueprint.inputs, true);
    validateStacks(blueprint.outputs, true);
    if ([...blueprint.inputs, ...blueprint.outputs].some(slot => BigInt(slot.quantity) > BigInt(slot.max_quantity))) invalidStatus();
  }
  return value;
}

function validateEmptyResult(value: IndustryEmptyResult, body: IndustryEmptyRequest) {
  if (!value || typeof value.requestID !== "string" || value.requestID.toLowerCase() !== body.requestID.toLowerCase() ||
      value.gameCommitted !== true || value.storageUnitID !== Number(body.storageUnitID)) invalidStatus();
  const totals = new Map<string, number>();
  for (const side of [value.inputs, value.outputs]) {
    if (!side || typeof side !== "object" || Array.isArray(side) || Object.keys(side).length > 256) invalidStatus();
    for (const [typeID, quantity] of Object.entries(side)) {
      if (!isSafePositiveDecimal(typeID) || Number(typeID) > INDUSTRY_TRANSFER_MAX ||
          !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > INDUSTRY_TRANSFER_MAX) invalidStatus();
      const total = (totals.get(typeID) || 0) + quantity;
      if (total > INDUSTRY_TRANSFER_MAX) invalidStatus();
      totals.set(typeID, total);
    }
  }
  validateTransferChain(value.chain);
  return value;
}

function validateTransferRequest(value: IndustryTransferRequest) {
  if (!value || typeof value.requestID !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestID))
    throw new IndustryApiError("Create a new transfer request before moving items.", "INVALID_REQUEST_ID");
  if (!isSafePositiveDecimal(value.storageUnitID) || !isSafePositiveDecimal(value.typeID) || Number(value.typeID) > INDUSTRY_TRANSFER_MAX)
    throw new IndustryApiError("Select an accessible storage unit and a supported item type.", "INVALID_TRANSFER_ITEM");
  if (!["deposit", "withdraw"].includes(value.direction) || !["inputs", "outputs"].includes(value.side) ||
      (value.direction === "deposit" && value.side !== "inputs"))
    throw new IndustryApiError("Move storage items to Industry inputs, or withdraw Industry inputs or outputs.", "INVALID_TRANSFER_DIRECTION");
  if (!isSafePositiveDecimal(value.quantity) || Number(value.quantity) > INDUSTRY_TRANSFER_MAX)
    throw new IndustryApiError("Enter a whole quantity from 1 to 4294967295.", "INVALID_TRANSFER_QUANTITY");
}

function validateStorageResult(value: IndustryStorageResult): IndustryStorageResult {
  const invalid = () => { throw new IndustryApiError("The Industry server returned incomplete storage inventory. Refresh before transferring items.", "INVALID_RESPONSE"); };
  if (!value || !Array.isArray(value.storageUnits)) invalid();
  const units = new Set<number>();
  for (const unit of value.storageUnits) {
    if (!unit || !Number.isSafeInteger(unit.storageUnitID) || unit.storageUnitID <= 0 || units.has(unit.storageUnitID) ||
        typeof unit.name !== "string" || !Number.isFinite(unit.capacity) || unit.capacity < 0 ||
        !Number.isFinite(unit.usedVolume) || unit.usedVolume < 0 || !Array.isArray(unit.items)) invalid();
    units.add(unit.storageUnitID);
    const items = new Set<number>();
    for (const item of unit.items) {
      if (!item || !Number.isSafeInteger(item.itemID) || item.itemID <= 0 || items.has(item.itemID) ||
          !Number.isSafeInteger(item.typeID) || item.typeID <= 0 || typeof item.name !== "string" ||
          !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitVolume) || item.unitVolume < 0) invalid();
      items.add(item.itemID);
    }
  }
  return value;
}

function validateTransferResult(value: IndustryTransferResult, body: IndustryTransferRequest): IndustryTransferResult {
  const invalid = () => { throw new IndustryApiError("The transfer response could not be verified. Refresh both inventories before trying again.", "INVALID_RESPONSE"); };
  if (!value || typeof value.requestID !== "string" || value.requestID.toLowerCase() !== body.requestID.toLowerCase() || value.gameCommitted !== true ||
      value.storageUnitID !== Number(body.storageUnitID) || value.direction !== body.direction || value.side !== body.side ||
      !value.items || Object.keys(value.items).length !== 1 || value.items[body.typeID] !== Number(body.quantity) || !value.chain) invalid();
  validateTransferChain(value.chain);
  return value;
}

function validateTransferChain(value: IndustryTransferChain): IndustryTransferChain {
  const invalid = () => { throw new IndustryApiError("The server returned incomplete inventory synchronization status. Refresh both inventories.", "INVALID_RESPONSE"); };
  if (!value) invalid();
  const statuses = [value.status, value.industryStatus, value.storageStatus];
  const expected = value.industryStatus === "error" || value.storageStatus === "error" ? "error"
    : value.industryStatus === "disabled" && value.storageStatus === "disabled" ? "disabled"
      : value.industryStatus === "synced" && value.storageStatus === "synced" ? "synced" : "pending";
  if (statuses.some(status => !["synced", "pending", "error", "disabled"].includes(status)) ||
      value.status !== expected) invalid();
  return value;
}

function validateStartRequest(value: IndustryStartRequest) {
  if (!value || !isSafePositiveDecimal(value.blueprintID))
    throw new IndustryApiError("Load a valid blueprint before starting production.", "INVALID_BLUEPRINT_ID");
  if (!isBlueprintHash(value.blueprintHash))
    throw new IndustryApiError("Refresh the facility to load its blueprint hash before starting production.", "INVALID_BLUEPRINT_HASH");
  if (!(value.runs === null || isSafePositiveDecimal(value.runs)))
    throw new IndustryApiError("Enter a whole run count from 1 to 9007199254740991, or select continuous production.", "INVALID_RUN_COUNT");
  if (!(value.expectedJobID === null || isSafePositiveDecimal(value.expectedJobID)))
    throw new IndustryApiError("Refresh the facility to load its current job before starting production.", "INVALID_JOB_ID");
}

function validateProduction(value: IndustryProduction | null) {
  if (value === null) return;
  if (!value || !["RUNNING", "DISCONTINUING", "STOPPED"].includes(value.state) ||
      !isU64(value.job_id) || !(value.requested_runs === null || isU64(value.requested_runs)) ||
      !isU64(value.completed_runs, true) || !isU64(value.run_started_at_ms, true) || !isU64(value.run_end_at_ms, true) ||
      !(value.stop_reason === null || (typeof value.stop_reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.stop_reason)))) invalidStatus();
  if (BigInt(value.run_end_at_ms) <= BigInt(value.run_started_at_ms) ||
      (value.requested_runs !== null && (BigInt(value.completed_runs) > BigInt(value.requested_runs) ||
        (value.state !== "STOPPED" && value.completed_runs === value.requested_runs))) ||
      ((value.state === "STOPPED") !== (value.stop_reason !== null)) ||
      (value.stop_reason === "COMPLETED" && value.completed_runs !== value.requested_runs)) invalidStatus();
}

const productionFields = ["job_id", "state", "requested_runs", "completed_runs", "run_started_at_ms", "run_end_at_ms", "stop_reason"] as const;
function sameProduction(left: IndustryProduction | null, right: IndustryProduction | null) {
  return left === null || right === null ? left === right : productionFields.every(key => left[key] === right[key]);
}

function validateStacks(values: IndustryItemStack[], recipe = false) {
  if (!Array.isArray(values) || values.length > 256) invalidStatus();
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || !isU64(value.type_id) || !isU64(value.quantity) || seen.has(value.type_id) ||
        (recipe && !isU64((value as IndustryRecipeSlot).max_quantity))) invalidStatus();
    seen.add(value.type_id);
  }
}

export function validateIndustryStatus(status: IndustryStatus, facilityID: string): IndustryStatus {
  if (!status?.facility || status.facility.itemId !== facilityID)
    throw new IndustryApiError("The server returned a different Industry facility. Refresh the selected assembly.", "INVALID_RESPONSE");
  const { facility, chain } = status;
  const snapshot = facility.snapshot;
  if (!Number.isSafeInteger(facility.typeId) || facility.typeId <= 0 || ![1, 2].includes(facility.status) ||
      !snapshot || !isU64(snapshot.owner_id) || !isU64(snapshot.solar_system_id) ||
      !isU64(snapshot.blueprint_id, true) || !isU64(snapshot.run_time, true) ||
      !(status.blueprintHash === undefined || status.blueprintHash === null || isBlueprintHash(status.blueprintHash)) ||
      !chain || !["disabled", "pending", "synced", "error"].includes(chain.status)) invalidStatus();
  validateStacks(snapshot.inputs);
  validateStacks(snapshot.outputs);
  validateStacks(snapshot.blueprint_inputs, true);
  validateStacks(snapshot.blueprint_outputs, true);
  validateProduction(status.production);
  validateProduction(facility.production);
  if (!sameProduction(status.production, facility.production) || (status.production !== null && snapshot.blueprint_id === "0")) invalidStatus();
  for (const value of [chain.assemblyObjectID, chain.industryObjectID]) {
    if (value !== undefined && (typeof value !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(value))) invalidStatus();
  }
  for (const value of [chain.revision, chain.observedAtMs, chain.syncedAtMs]) {
    if (value !== undefined && !isU64(value, true)) invalidStatus();
  }
  if (chain.productionMirrored !== undefined && typeof chain.productionMirrored !== "boolean") invalidStatus();
  if (chain.production !== undefined) validateProduction(chain.production);
  if (chain.status === "synced" && (!chain.assemblyObjectID || !chain.industryObjectID || chain.productionMirrored !== true ||
      chain.production === undefined || !sameProduction(status.production, chain.production))) invalidStatus();
  return status;
}

/** Review and submit this exact recipe/job identity; the server rechecks it before consuming inputs. */
export function industryStartRequest(status: IndustryStatus, runs: string | null): IndustryStartRequest {
  validateIndustryStatus(status, industryItemId(status?.facility?.itemId));
  const { facility, production } = status;
  const snapshot = facility.snapshot;
  if (facility.status !== 2)
    throw new IndustryApiError("Bring the Industry facility online before starting production.", "FACILITY_OFFLINE");
  if (production && production.state !== "STOPPED")
    throw new IndustryApiError("This facility already has an active production job.", "PRODUCTION_ALREADY_RUNNING");
  const request: IndustryStartRequest = {
    blueprintID: snapshot.blueprint_id,
    blueprintHash: status.blueprintHash || "",
    runs,
    expectedJobID: production?.job_id ?? null,
  };
  validateStartRequest(request);
  if (snapshot.run_time === "0" || !snapshot.blueprint_inputs.length || !snapshot.blueprint_outputs.length ||
      [...snapshot.blueprint_inputs, ...snapshot.blueprint_outputs].some(slot => BigInt(slot.quantity) > BigInt(slot.max_quantity)))
    throw new IndustryApiError("The selected blueprint has an invalid recipe. Refresh the facility.", "BLUEPRINT_NOT_FOUND");
  const inputs = new Map(snapshot.inputs.map(stack => [stack.type_id, BigInt(stack.quantity)]));
  if (snapshot.blueprint_inputs.some(slot => (inputs.get(slot.type_id) ?? 0n) < BigInt(slot.quantity)))
    throw new IndustryApiError("Add the required inputs for one run before starting production.", "INSUFFICIENT_INPUTS");
  const outputs = new Map(snapshot.outputs.map(stack => [stack.type_id, BigInt(stack.quantity)]));
  if (snapshot.blueprint_outputs.some(slot => (outputs.get(slot.type_id) ?? 0n) + BigInt(slot.quantity) > BigInt(slot.max_quantity)))
    throw new IndustryApiError("Make room in the facility outputs for one run before starting production.", "OUTPUT_CAPACITY_EXCEEDED");
  return request;
}

export function createIndustryClient(fetcher: typeof fetch = fetch, base = "/evejs/industry") {
  async function request<T>(route: string, token: string | undefined, body: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 30000);
    try {
      const response = await fetcher(`${base}${route}`, {
        method: "POST", cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      let payload: { success?: boolean; data?: T; message?: string; errorMsg?: string };
      try { payload = await response.json(); }
      catch { throw new IndustryApiError(`The Industry server returned an invalid response (HTTP ${response.status}). Refresh the facility.`, "INVALID_RESPONSE", response.status); }
      if (!payload || !response.ok || payload.success !== true || !payload.data)
        throw new IndustryApiError(payload?.message || payload?.errorMsg || `Industry request failed (HTTP ${response.status}).`, payload?.errorMsg, response.status);
      return payload.data;
    } catch (error) {
      if (signal?.aborted) throw new DOMException("The Industry request was cancelled.", "AbortError");
      if (error instanceof IndustryApiError) throw error;
      throw new IndustryApiError(controller.signal.aborted
        ? "The Industry server did not respond in time. Refresh the facility to check its current status."
        : "The Industry server could not be reached. Check its connection and refresh the facility.");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function status(facilityID: string, token: string, action: "status" | "sync", signal?: AbortSignal) {
    const id = industryItemId(facilityID);
    return validateIndustryStatus(await request<IndustryStatus>(`/${id}/${action}`, token, {}, signal), id);
  }

  return {
    async blueprints(facilityID: string, token: string, signal?: AbortSignal): Promise<IndustryBlueprintsResult> {
      const id = industryItemId(facilityID);
      return validateBlueprintsResult(await request<IndustryBlueprintsResult>(`/${id}/blueprints`, token, {}, signal));
    },
    async changeBlueprint(facilityID: string, token: string, body: IndustryBlueprintChangeRequest, signal?: AbortSignal): Promise<IndustryBlueprintChangeResult> {
      const id = industryItemId(facilityID);
      validateBlueprintExpectation(body);
      validateRequestID(body.requestID);
      if (!isSafePositiveDecimal(body.blueprintID) || !isBlueprintHash(body.blueprintHash) || body.blueprintID === body.expectedBlueprintID)
        throw new IndustryApiError("Select a different blueprint from this facility's available recipes.", "INVALID_BLUEPRINT_ID");
      const result = await request<IndustryBlueprintChangeResult>(`/${id}/blueprint`, token, body, signal);
      validateIndustryStatus(result, id);
      if (result.gameCommitted !== true || typeof result.requestID !== "string" || result.requestID.toLowerCase() !== body.requestID.toLowerCase() ||
          result.selectedBlueprintID !== body.blueprintID || result.facility.snapshot.blueprint_id !== body.blueprintID || result.blueprintHash !== body.blueprintHash) invalidStatus();
      return result;
    },
    async emptyBlueprint(facilityID: string, token: string, body: IndustryEmptyRequest, signal?: AbortSignal): Promise<IndustryEmptyResult> {
      const id = industryItemId(facilityID);
      validateBlueprintExpectation(body);
      validateRequestID(body.requestID);
      if (!isSafePositiveDecimal(body.storageUnitID))
        throw new IndustryApiError("Select a nearby Smart Storage Unit for all inputs and outputs.", "INVALID_STORAGE_ID");
      return validateEmptyResult(await request<IndustryEmptyResult>(`/${id}/empty`, token, body, signal), body);
    },
    async authenticate(wallet: WalletSession, config: AssemblyConfig): Promise<IndustrySession> {
      if (config.network !== "localnet") throw new Error("Industry operations require the game's localnet deployment.");
      const challenge = await request<{ challengeId: string; transactionData: string; expiresAt: string | number }>(
        "/auth/challenge", undefined, { walletAddress: wallet.address });
      const transaction = Transaction.from(challenge.transactionData);
      const data = transaction.getData();
      const address = requireObjectId(wallet.address, "Connected wallet");
      const payment = data.gasData.payment;
      // Connection signatures must never authorize commands or spendable gas inputs.
      if (!challenge.challengeId || !Number.isFinite(new Date(challenge.expiresAt).getTime()) || new Date(challenge.expiresAt).getTime() <= Date.now() ||
          !transaction.isFullyResolved() || data.commands.length || data.inputs.length || data.expiration !== null ||
          requireObjectId(data.sender || "", "Challenge sender") !== address || requireObjectId(data.gasData.owner || "", "Challenge gas owner") !== address ||
          data.gasData.budget !== "1" || data.gasData.price !== "1" || payment?.length !== 1 || payment[0].version !== "1" || payment[0].digest !== "11111111111111111111111111111111")
        throw new Error("The Industry connection challenge is invalid or expired. Reconnect and try again.");
      const signed = await wallet.signTransaction(transaction, config);
      const session = await request<IndustrySession>("/auth/session", undefined, { challengeId: challenge.challengeId, signature: signed.signature });
      if (requireObjectId(session.walletAddress, "Session wallet") !== address || !session.token ||
          !Number.isSafeInteger(session.characterID) || session.characterID <= 0 ||
          !Number.isFinite(new Date(session.expiresAt).getTime()) || new Date(session.expiresAt).getTime() <= Date.now())
        throw new Error("The Industry session expired or belongs to a different wallet. Reconnect and try again.");
      return session;
    },
    status: (facilityID: string, token: string, signal?: AbortSignal) => status(facilityID, token, "status", signal),
    sync: (facilityID: string, token: string, signal?: AbortSignal) => status(facilityID, token, "sync", signal),
    async storage(facilityID: string, token: string, signal?: AbortSignal): Promise<IndustryStorageResult> {
      const id = industryItemId(facilityID);
      return validateStorageResult(await request<IndustryStorageResult>(`/${id}/storage`, token, {}, signal));
    },
    async storageSync(facilityID: string, token: string, storageUnitID: string, signal?: AbortSignal): Promise<IndustryTransferChain> {
      const id = industryItemId(facilityID);
      if (!isSafePositiveDecimal(storageUnitID)) throw new IndustryApiError("Select a valid storage unit to synchronize.", "INVALID_STORAGE_ID");
      return validateTransferChain(await request<IndustryTransferChain>(`/${id}/storage-sync`, token, { storageUnitID }, signal));
    },
    async transfer(facilityID: string, token: string, body: IndustryTransferRequest, signal?: AbortSignal): Promise<IndustryTransferResult> {
      const id = industryItemId(facilityID);
      validateTransferRequest(body);
      return validateTransferResult(await request<IndustryTransferResult>(`/${id}/transfer`, token, body, signal), body);
    },
    async start(facilityID: string, token: string, body: IndustryStartRequest, signal?: AbortSignal): Promise<IndustryStartResult> {
      const id = industryItemId(facilityID);
      validateStartRequest(body);
      const result = await request<IndustryStartResult>(`/${id}/start`, token, body, signal);
      validateIndustryStatus(result, id);
      // Synchronization can take long enough for production to advance; use the commit receipt
      // instead of requiring the returned current job to still be running.
      if (result.gameCommitted !== true || !isSafePositiveDecimal(result.startedJobID) ||
          BigInt(result.startedJobID) !== BigInt(body.expectedJobID ?? "0") + 1n) invalidStatus();
      return result;
    },
  };
}
