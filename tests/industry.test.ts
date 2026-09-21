import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { configFromEnv } from "../src/assembly/config.ts";
import { createIndustryClient, IndustryApiError, industryItemId, industryStartRequest, validateIndustryStatus } from "../src/industry/client.ts";
import type { IndustryProduction, IndustryStatus, IndustryStorageResult, IndustryTransferRequest, IndustryTransferResult } from "../src/industry/client.ts";
import type { WalletSession } from "../src/wallet.ts";

const production: IndustryProduction = {
  job_id: "5", state: "RUNNING", requested_runs: "10", completed_runs: "2",
  run_started_at_ms: "1800000000000", run_end_at_ms: "1800000060000", stop_reason: null,
};
const status: IndustryStatus = {
  blueprintHash: "a".repeat(64),
  facility: {
    itemId: "100", typeId: 88001, status: 2, production,
    snapshot: { owner_id: "200", solar_system_id: "300001", blueprint_id: "22", run_time: "60",
      inputs: [{ type_id: "34", quantity: "9007199254740993" }], outputs: [{ type_id: "35", quantity: "4" }],
      blueprint_inputs: [{ type_id: "34", quantity: "100", max_quantity: "18446744073709551615" }],
      blueprint_outputs: [{ type_id: "35", quantity: "2", max_quantity: "1000" }],
    },
  },
  production,
  chain: { status: "synced", assemblyObjectID: "0xa", industryObjectID: "0xb", revision: "3", observedAtMs: "1800000000000", syncedAtMs: "1800000000001", productionMirrored: true, production },
};

function readyStatus(): IndustryStatus {
  const current = structuredClone(status);
  current.production = current.facility.production = null;
  current.chain = { status: "pending" };
  current.facility.snapshot.inputs[0].quantity = "100";
  return current;
}

const transferRequest: IndustryTransferRequest = {
  requestID: "d5b345fb-6611-4000-a000-4dc47c6d45fc", storageUnitID: "300",
  direction: "deposit", side: "inputs", typeID: "34", quantity: "5",
};
const storageResult: IndustryStorageResult = { storageUnits: [{
  storageUnitID: 300, name: "Nearby storage", capacity: 1000, usedVolume: 3,
  items: [{ itemID: 301, typeID: 34, name: "Material", quantity: 10, unitVolume: 0.1 },
    { itemID: 302, typeID: 34, name: "Material", quantity: 20, unitVolume: 0.1 }],
}] };
const transferResult: IndustryTransferResult = {
  requestID: transferRequest.requestID, gameCommitted: true, storageUnitID: 300,
  direction: "deposit", side: "inputs", items: { "34": 5 },
  chain: { status: "pending", industryStatus: "synced", storageStatus: "pending" },
};

test("Industry loads accessible storage and sends each deliberate transfer exactly once with owner authorization", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const api = createIndustryClient(async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return Response.json({ success: true, data: String(url).endsWith("/storage") ? storageResult : transferResult });
  });
  assert.deepEqual(await api.storage("100", "industry-token"), storageResult);
  const receipt = await api.transfer("100", "industry-token", transferRequest);
  assert.equal(receipt.gameCommitted, true);
  assert.equal(receipt.chain.status, "pending");
  assert.equal(receipt.chain.storageStatus, "pending");
  assert.deepEqual(calls.map(call => call.url), ["/evejs/industry/100/storage", "/evejs/industry/100/transfer"]);
  assert.deepEqual(JSON.parse(String(calls[1].options.body)), transferRequest);
  for (const { options } of calls) {
    assert.equal(options.method, "POST");
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "omit");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer industry-token");
  }
});

test("Industry rejects malformed transfer parameters before the server can move items", async () => {
  let requests = 0;
  const api = createIndustryClient(async () => { requests++; return Response.json({ success: true, data: transferResult }); });
  for (const change of [{ requestID: "" }, { storageUnitID: "-1" }, { typeID: "1.5" }, { typeID: "4294967296" }, { quantity: "0" },
    { quantity: "4294967296" }, { quantity: "9007199254740992" }, { quantity: "1e3" }, { side: "outputs" as const }, { direction: "invalid" as "deposit" }])
    await assert.rejects(api.transfer("100", "token", { ...transferRequest, ...change }), IndustryApiError);
  assert.equal(requests, 0);
});

test("Industry accepts the storage wire limit and normalized UUID receipts", async () => {
  const request = { ...transferRequest, requestID: transferRequest.requestID.toUpperCase(), typeID: "4294967295", quantity: "4294967295" };
  const api = createIndustryClient(async () => Response.json({ success: true, data: {
    ...transferResult, requestID: request.requestID.toLowerCase(), items: { "4294967295": 4294967295 },
  } }));
  const result = await api.transfer("100", "token", request);
  assert.equal(result.requestID, transferRequest.requestID);
  assert.deepEqual(result.items, { "4294967295": 4294967295 });
});

test("Industry validates transfer identity, quantities, and both blockchain statuses", async () => {
  const invalid: Array<(value: IndustryTransferResult) => void> = [
    value => { value.requestID = "another-request"; }, value => { value.storageUnitID = 301; },
    value => { value.direction = "withdraw"; }, value => { value.side = "outputs"; },
    value => { value.gameCommitted = false as true; }, value => { value.items = { "34": 4 }; },
    value => { value.items = { "34": 5, "35": 1 }; }, value => { value.chain.status = "synced"; },
    value => { value.chain.storageStatus = "unknown" as "pending"; },
    value => { value.chain.status = "disabled"; }, value => { value.chain.status = "error"; },
    value => { value.chain.storageStatus = "error"; },
    value => { value.chain.industryStatus = value.chain.storageStatus = "disabled"; },
  ];
  for (const change of invalid) {
    const receipt = structuredClone(transferResult);
    change(receipt);
    const api = createIndustryClient(async () => Response.json({ success: true, data: receipt }));
    await assert.rejects(api.transfer("100", "token", transferRequest), (error: unknown) => error instanceof IndustryApiError && error.code === "INVALID_RESPONSE");
  }
  for (const side of ["inputs", "outputs"] as const) {
    const body = { ...transferRequest, direction: "withdraw" as const, side };
    const api = createIndustryClient(async () => Response.json({ success: true, data: { ...transferResult, direction: "withdraw", side } }));
    assert.equal((await api.transfer("100", "token", body)).side, side);
  }
});

test("Industry accepts consistent combined blockchain states", async () => {
  const combinations: IndustryTransferResult["chain"][] = [
    { status: "synced", industryStatus: "synced", storageStatus: "synced" },
    { status: "disabled", industryStatus: "disabled", storageStatus: "disabled" },
    { status: "pending", industryStatus: "disabled", storageStatus: "synced" },
    { status: "pending", industryStatus: "pending", storageStatus: "disabled" },
    { status: "error", industryStatus: "disabled", storageStatus: "error" },
    { status: "error", industryStatus: "error", storageStatus: "synced" },
  ];
  for (const chain of combinations) {
    const api = createIndustryClient(async () => Response.json({ success: true, data: { ...transferResult, chain } }));
    assert.deepEqual((await api.transfer("100", "token", transferRequest)).chain, chain);
  }
});

test("Industry never retries a transfer with an unknown result", async () => {
  let calls = 0;
  const api = createIndustryClient(async () => { calls++; throw new TypeError("Connection closed after commit"); });
  await assert.rejects(api.transfer("100", "token", transferRequest), IndustryApiError);
  assert.equal(calls, 1);
});

test("Industry synchronizes the committed transfer's storage without moving items again", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const api = createIndustryClient(async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return Response.json({ success: true, data: { status: "synced", industryStatus: "synced", storageStatus: "synced" } });
  });
  assert.equal((await api.storageSync("100", "token", "300")).status, "synced");
  assert.deepEqual(calls, [{ url: "/evejs/industry/100/storage-sync", body: { storageUnitID: "300" } }]);
  await assert.rejects(api.storageSync("100", "token", "-1"), IndustryApiError);
  assert.equal(calls.length, 1);
});

test("Industry rejects unsafe or duplicate storage inventory before transfers", async () => {
  const invalid: Array<(value: IndustryStorageResult) => void> = [
    value => { value.storageUnits[0].storageUnitID = -1; },
    value => { value.storageUnits.push(structuredClone(value.storageUnits[0])); },
    value => { value.storageUnits[0].items[0].quantity = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.storageUnits[0].items[0].unitVolume = -1; },
    value => { value.storageUnits[0].items[0].itemID = value.storageUnits[0].items[1].itemID; },
  ];
  for (const change of invalid) {
    const inventory = structuredClone(storageResult);
    change(inventory);
    const api = createIndustryClient(async () => Response.json({ success: true, data: inventory }));
    await assert.rejects(api.storage("100", "token"), IndustryApiError);
  }
});

test("Industry status and sync fetch the selected facility without caching or losing u64 quantities", async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const api = createIndustryClient(async (url, options) => {
    calls.push({ url: String(url), options: options! });
    const latest = structuredClone(status);
    latest.facility.snapshot.outputs[0].quantity = String(calls.length * 4);
    return Response.json({ success: true, data: latest });
  });
  assert.equal((await api.status("100", "industry-token")).facility.snapshot.inputs[0].quantity, "9007199254740993");
  assert.equal((await api.status("100", "industry-token")).facility.snapshot.outputs[0].quantity, "8");
  assert.equal((await api.sync("100", "industry-token")).facility.snapshot.outputs[0].quantity, "12");
  assert.deepEqual(calls.map(call => call.url), ["/evejs/industry/100/status", "/evejs/industry/100/status", "/evejs/industry/100/sync"]);
  for (const { options } of calls) {
    assert.equal(options.method, "POST");
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer industry-token");
    assert.equal(options.body, "{}");
  }
});

test("Industry starts the reviewed server recipe once and retains a committed result while chain sync is pending", async () => {
  const current = readyStatus();
  const request = industryStartRequest(current, "50");
  assert.deepEqual(request, { blueprintID: "22", blueprintHash: "a".repeat(64), runs: "50", expectedJobID: null });
  const started = structuredClone(status);
  started.chain = { status: "error" };
  const calls: { url: string; options: RequestInit }[] = [];
  const api = createIndustryClient(async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return Response.json({ success: true, data: { ...started, gameCommitted: true, startedJobID: "1" } });
  });
  const result = await api.start("100", "industry-token", request);
  assert.equal(result.gameCommitted, true);
  assert.equal(result.startedJobID, "1");
  assert.equal(result.chain.status, "error");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/evejs/industry/100/start");
  assert.deepEqual(JSON.parse(String(calls[0].options.body)), request);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(new Headers(calls[0].options.headers).get("Authorization"), "Bearer industry-token");
});

test("Industry supports continuous and safe finite counts with only the first run's resources", () => {
  const current = readyStatus();
  current.facility.snapshot.outputs[0].quantity = "998";
  assert.equal(industryStartRequest(current, null).runs, null);
  assert.equal(industryStartRequest(current, "9007199254740991").runs, "9007199254740991");
  current.production = current.facility.production = { ...production, state: "STOPPED", stop_reason: "COMPLETED", completed_runs: "10" };
  assert.equal(industryStartRequest(current, "1").expectedJobID, "5");
});

test("Industry start blocks unavailable recipes, active jobs, offline facilities and insufficient first-run resources", () => {
  const cases: [(value: IndustryStatus) => void, string][] = [
    [value => { value.facility.status = 1; }, "FACILITY_OFFLINE"],
    [value => { value.production = value.facility.production = production; }, "PRODUCTION_ALREADY_RUNNING"],
    [value => { value.production = value.facility.production = { ...production, state: "DISCONTINUING" }; }, "PRODUCTION_ALREADY_RUNNING"],
    [value => { value.facility.snapshot.blueprint_id = "0"; }, "INVALID_BLUEPRINT_ID"],
    [value => { value.blueprintHash = null; }, "INVALID_BLUEPRINT_HASH"],
    [value => { delete value.blueprintHash; }, "INVALID_BLUEPRINT_HASH"],
    [value => { value.facility.snapshot.run_time = "0"; }, "BLUEPRINT_NOT_FOUND"],
    [value => { value.facility.snapshot.blueprint_inputs = []; }, "BLUEPRINT_NOT_FOUND"],
    [value => { value.facility.snapshot.blueprint_outputs[0].max_quantity = "1"; }, "BLUEPRINT_NOT_FOUND"],
    [value => { value.facility.snapshot.inputs[0].quantity = "99"; }, "INSUFFICIENT_INPUTS"],
    [value => { value.facility.snapshot.inputs = []; }, "INSUFFICIENT_INPUTS"],
    [value => { value.facility.snapshot.outputs[0].quantity = "999"; }, "OUTPUT_CAPACITY_EXCEEDED"],
  ];
  for (const [change, code] of cases) {
    const current = readyStatus();
    change(current);
    assert.throws(() => industryStartRequest(current, "1"), (error: unknown) => error instanceof IndustryApiError && error.code === code, code);
  }
});

test("Industry start rejects unsafe or ambiguous run counts and identities before sending a request", async () => {
  const current = readyStatus();
  const request = industryStartRequest(current, "1");
  let calls = 0;
  const api = createIndustryClient(async () => { calls++; return new Response(); });
  for (const runs of ["", "0", "01", "-1", "1.5", "1e3", "+1", " 1 ", "9007199254740992", "18446744073709551615"]) {
    assert.throws(() => industryStartRequest(current, runs), (error: unknown) => error instanceof IndustryApiError && error.code === "INVALID_RUN_COUNT");
    await assert.rejects(api.start("100", "token", { ...request, runs }), (error: unknown) => error instanceof IndustryApiError && error.code === "INVALID_RUN_COUNT");
  }
  await assert.rejects(api.start("100/start", "token", request), /valid game Industry facility ID/);
  for (const changes of [{ blueprintID: "9007199254740992" }, { blueprintHash: "stale" }, { expectedJobID: "0" }, { expectedJobID: "9007199254740992" }])
    await assert.rejects(api.start("100", "token", { ...request, ...changes }), (error: unknown) => error instanceof IndustryApiError);
  assert.equal(calls, 0);
});

test("Industry start never retries a failed mutation and preserves stale-production and access errors", async () => {
  const request = industryStartRequest(readyStatus(), "1");
  for (const [errorMsg, statusCode] of [["PRODUCTION_CHANGED", 409], ["AUTH_EXPIRED", 401], ["FACILITY_OFFLINE", 409]] as const) {
    let calls = 0;
    const api = createIndustryClient(async () => { calls++; return Response.json({ success: false, errorMsg, message: "Refresh facility status." }, { status: statusCode }); });
    await assert.rejects(api.start("100", "token", request), (error: unknown) => error instanceof IndustryApiError && error.code === errorMsg && error.status === statusCode);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const lostResponse = createIndustryClient(async () => { calls++; throw new Error("response lost after commit"); });
  await assert.rejects(lostResponse.start("100", "token", request), /refresh the facility/);
  assert.equal(calls, 1);
});

test("Industry start requires a valid commit receipt even when production has already advanced", async () => {
  const request = industryStartRequest(readyStatus(), "1");
  const current = readyStatus();
  current.production = current.facility.production = { ...production, state: "STOPPED", stop_reason: "COMPLETED", completed_runs: "10" };
  const api = createIndustryClient(async () => Response.json({ success: true, data: { ...current, gameCommitted: true, startedJobID: "1" } }));
  assert.equal((await api.start("100", "token", request)).production?.state, "STOPPED");
  for (const receipt of [{}, { gameCommitted: false, startedJobID: "1" }, { gameCommitted: true, startedJobID: "0" }, { gameCommitted: true, startedJobID: "2" }, { gameCommitted: true, startedJobID: "9007199254740992" }]) {
    const invalid = createIndustryClient(async () => Response.json({ success: true, data: { ...current, ...receipt } }));
    await assert.rejects(invalid.start("100", "token", request), (error: unknown) => error instanceof IndustryApiError && error.code === "INVALID_RESPONSE");
  }
});

test("Industry authorization signs an empty scoped challenge and rejects commands, expiry and another wallet", async () => {
  const address = normalizeSuiAddress("0x99");
  const transaction = new Transaction();
  transaction.setSender(address);
  transaction.setGasOwner(address);
  transaction.setGasBudget(1);
  transaction.setGasPrice(1);
  transaction.setGasPayment([{ objectId: normalizeSuiAddress("0x66"), version: "1", digest: "11111111111111111111111111111111" }]);
  let expiresAt = Date.now() + 60000;
  let sessionWallet = address;
  let signatures = 0;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const api = createIndustryClient(async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return Response.json({ success: true, data: String(url).endsWith("challenge")
      ? { challengeId: "industry-challenge", transactionData: await transaction.toJSON(), expiresAt }
      : { token: "industry-token", walletAddress: sessionWallet, characterID: 200, expiresAt } });
  });
  const wallet = { address, async signTransaction(tx: Transaction) { signatures++; return { bytes: toBase64(await tx.build()), signature: "signature" }; } } as WalletSession;
  assert.equal((await api.authenticate(wallet, configFromEnv({}))).token, "industry-token");
  assert.equal(signatures, 1);
  assert.deepEqual(calls.map(call => call.url), ["/evejs/industry/auth/challenge", "/evejs/industry/auth/session"]);
  assert.deepEqual(calls[1].body, { challengeId: "industry-challenge", signature: "signature" });
  expiresAt = Date.now() - 1;
  await assert.rejects(api.authenticate(wallet, configFromEnv({})), /challenge is invalid or expired/);
  assert.equal(signatures, 1);
  expiresAt = Date.now() + 60000;
  sessionWallet = normalizeSuiAddress("0xaa");
  await assert.rejects(api.authenticate(wallet, configFromEnv({})), /different wallet/);
  assert.equal(signatures, 2);
  transaction.moveCall({ target: `${normalizeSuiAddress("0xa")}::assembly::online`, arguments: [] });
  await assert.rejects(api.authenticate(wallet, configFromEnv({})), /challenge is invalid or expired/);
  assert.equal(signatures, 2);
  await assert.rejects(api.authenticate(wallet, configFromEnv({ VITE_SUI_NETWORK: "testnet" })), /localnet/);
});

test("Industry validation accepts idle, finite, continuous and stopped production snapshots", () => {
  assert.deepEqual(validateIndustryStatus(status, "100"), status);
  for (const job of [null, { ...production, requested_runs: null },
    { ...production, state: "DISCONTINUING" as const },
    { ...production, state: "STOPPED" as const, stop_reason: "COMPLETED", completed_runs: "10" },
  ]) {
    const current = structuredClone(status);
    current.production = current.facility.production = job;
    current.chain = { status: "pending" };
    assert.deepEqual(validateIndustryStatus(current, "100"), current);
  }
});

test("Industry status rejects the wrong assembly, malformed inventory and inconsistent production", async () => {
  const malformed: IndustryStatus[] = [];
  const mutate = (change: (value: IndustryStatus) => void) => { const value = structuredClone(status); change(value); malformed.push(value); };
  mutate(value => { value.facility.itemId = "101"; });
  mutate(value => { value.facility.snapshot.inputs[0].quantity = "18446744073709551616"; });
  mutate(value => { value.facility.snapshot.inputs.push(value.facility.snapshot.inputs[0]); });
  mutate(value => { value.blueprintHash = "invalid"; });
  mutate(value => { value.production = { ...production, completed_runs: "10" }; value.facility.production = value.production; });
  mutate(value => { value.production = { ...production, state: "STOPPED" }; value.facility.production = value.production; });
  mutate(value => { value.production = { ...production, run_end_at_ms: production.run_started_at_ms }; value.facility.production = value.production; });
  mutate(value => { value.production = { ...production, requested_runs: null, state: "STOPPED", stop_reason: "COMPLETED" }; value.facility.production = value.production; });
  mutate(value => { value.facility.production = null; });
  mutate(value => { value.chain.productionMirrored = false; });
  mutate(value => { value.chain.production = null; });
  mutate(value => { value.chain.industryObjectID = "invalid"; });
  for (const data of malformed) {
    const api = createIndustryClient(async () => Response.json({ success: true, data }));
    await assert.rejects(api.status("100", "token"), (error: unknown) => error instanceof IndustryApiError && error.code === "INVALID_RESPONSE");
  }
});

test("Industry routes reject malformed and unsafe game item IDs before requesting data", async () => {
  let requests = 0;
  const api = createIndustryClient(async () => { requests++; return new Response(); });
  for (const id of ["0", "01", "-1", "1.5", "1/status", "9007199254740992"]) {
    assert.throws(() => industryItemId(id), /valid game Industry facility ID/);
    await assert.rejects(api.status(id, "token"), /valid game Industry facility ID/);
  }
  assert.equal(requests, 0);
});

test("Industry failures retain access and session errors and report invalid JSON or connection failure", async () => {
  for (const [code, message, statusCode] of [
    ["ACCESS_DENIED", "Only the facility owner can read its live inventory.", 403],
    ["AUTH_EXPIRED", "Your wallet session expired. Connect again.", 401],
  ] as const) {
    const api = createIndustryClient(async () => Response.json({ success: false, errorMsg: code, message }, { status: statusCode }));
    await assert.rejects(api.status("100", "token"), (error: unknown) => error instanceof IndustryApiError && error.code === code && error.status === statusCode && error.message === message);
  }
  const invalid = createIndustryClient(async () => new Response("invalid", { status: 502 }));
  await assert.rejects(invalid.status("100", "token"), /invalid response \(HTTP 502\)/);
  const unavailable = createIndustryClient(async () => { throw new Error("offline"); });
  await assert.rejects(unavailable.status("100", "token"), /could not be reached/);
});

test("Industry polling can cancel an outstanding request when the selected assembly changes", async () => {
  const controller = new AbortController();
  const api = createIndustryClient(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const pending = api.status("100", "token", controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
});
