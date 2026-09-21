import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { configFromEnv } from "../src/assembly/config.ts";
import { createGateClient, GateApiError, gateItemId, gateLinkBlockReason, validateGateStatus } from "../src/gate/client.ts";
import type { GateStatus } from "../src/gate/client.ts";
import type { WalletSession } from "../src/wallet.ts";

const status: GateStatus = {
  gate: { itemID: 100, typeID: 872, name: "Home gate", solarSystemID: 300001, assemblyStatus: 1, destinationGateID: null, rangeLightYears: 4.5 },
  destination: null,
  candidates: [{ itemID: 101, typeID: 872, name: "Remote gate", solarSystemID: 300002, assemblyStatus: 1, destinationGateID: null, rangeLightYears: 4.5, distanceLightYears: 4.5, distanceMeters: "42573287126613600", eligible: true, reason: null }],
  rangeLightYears: 4.5,
  chain: { status: "synced", maxDistanceMeters: "9460730472580800" },
};

test("gate eligibility includes the configured boundary and updates differing chain ranges when linking", () => {
  const candidate = status.candidates[0];
  assert.equal(gateLinkBlockReason(status, candidate), "");
  assert.match(gateLinkBlockReason(status, { ...candidate, distanceLightYears: 4.500001 }), /configured link range/);
  assert.match(gateLinkBlockReason(status, { ...candidate, typeID: 999 }), /same type/);
  assert.match(gateLinkBlockReason(status, { ...candidate, itemID: 100 }), /itself/);
  assert.match(gateLinkBlockReason(status, { ...candidate, destinationGateID: 102 }), /already has a destination/);
  assert.match(gateLinkBlockReason({ ...status, gate: { ...status.gate, destinationGateID: 102 } }, candidate), /Unlink/);
  assert.match(gateLinkBlockReason(status, { ...candidate, distanceLightYears: null }), /distance is unavailable/);
  assert.match(gateLinkBlockReason({ ...status, rangeLightYears: 0 }, candidate), /range is unavailable/);
  assert.match(gateLinkBlockReason(status, { ...candidate, eligible: false, reason: "SMART_GATE_MUST_BE_OFFLINE" }), /both gates offline/);
  for (const state of ["pending", "error", "disabled"] as const)
    assert.match(gateLinkBlockReason({ ...status, chain: { status: state } }, candidate), /Sync.*blockchain/);
});

test("gate authorization validates the empty wallet challenge and uses a separate gate session", async () => {
  const address = normalizeSuiAddress("0x99");
  const transaction = new Transaction();
  transaction.setSender(address);
  transaction.setGasOwner(address);
  transaction.setGasBudget(1);
  transaction.setGasPrice(1);
  transaction.setGasPayment([{ objectId: normalizeSuiAddress("0x66"), version: "1", digest: "11111111111111111111111111111111" }]);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const api = createGateClient(async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return new Response(JSON.stringify({ success: true, data: String(url).endsWith("challenge") ? { challengeId: "gate-challenge", transactionData: await transaction.toJSON() } : { token: "gate-token", walletAddress: address, characterID: 200, expiresAt: Date.now() + 60000 } }));
  });
  let signatures = 0;
  const wallet = { address, async signTransaction(tx: Transaction) { signatures++; return { bytes: toBase64(await tx.build()), signature: "signature" }; } } as WalletSession;
  assert.equal((await api.authenticate(wallet, configFromEnv({}))).token, "gate-token");
  assert.equal(signatures, 1);
  assert.deepEqual(calls.map(call => call.url), ["/evejs/gates/auth/challenge", "/evejs/gates/auth/session"]);
  assert.equal(calls[1].body.challengeId, "gate-challenge");
  assert.equal(calls[1].body.signature, "signature");
  transaction.moveCall({ target: `${normalizeSuiAddress("0xa")}::gate::unlink_gates`, arguments: [] });
  await assert.rejects(api.authenticate(wallet, configFromEnv({})), /challenge is invalid/);
  assert.equal(signatures, 1);
});

test("gate link, guarded unlink, and sync use separate authenticated actions", async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const linked: GateStatus = { ...status, gate: { ...status.gate, destinationGateID: 101 }, destination: { ...status.candidates[0], destinationGateID: 100 }, chain: { status: "pending" } };
  const api = createGateClient(async (url, options) => {
    requests.push({ url: String(url), options: options! });
    return new Response(JSON.stringify({ success: true, data: String(url).endsWith("/link") ? linked : status }));
  });
  assert.deepEqual(await api.status("100", "gate-token"), status);
  assert.deepEqual(await api.link("100", "gate-token", 101), linked);
  assert.deepEqual(await api.unlink("100", "gate-token", 101), status);
  assert.deepEqual(await api.sync("100", "gate-token"), status);
  assert.deepEqual(requests.map(request => request.url), ["/evejs/gates/100/status", "/evejs/gates/100/link", "/evejs/gates/100/unlink", "/evejs/gates/100/sync"]);
  for (const request of requests) {
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error");
    assert.equal(new Headers(request.options.headers).get("Authorization"), "Bearer gate-token");
  }
  assert.deepEqual(requests.map(request => JSON.parse(String(request.options.body))), [{}, { destinationGateID: 101 }, { destinationGateID: 101 }, {}]);
});

test("gate readings reject another source, wrong destination, invalid range and incomplete eligibility", () => {
  assert.throws(() => validateGateStatus({ ...status, gate: { ...status.gate, itemID: 999 } }, "100"), /different gate/);
  assert.throws(() => validateGateStatus({ ...status, rangeLightYears: NaN }, "100"), /incomplete gate/);
  assert.throws(() => validateGateStatus({ ...status, destination: status.candidates[0] }, "100"), /destination changed/);
  assert.throws(() => validateGateStatus({ ...status, chain: { ...status.chain, maxDistanceMeters: "-1" } }, "100"), /incomplete gate/);
  assert.throws(() => validateGateStatus({ ...status, candidates: [{ ...status.candidates[0], distanceLightYears: -1 }] }, "100"), /incomplete candidate/);
  assert.throws(() => validateGateStatus({ ...status, candidates: [status.candidates[0], status.candidates[0]] }, "100"), /incomplete candidate/);
  assert.throws(() => validateGateStatus({ ...status, candidates: [{ ...status.candidates[0], eligible: undefined } as unknown as GateStatus["candidates"][0]] }, "100"), /incomplete candidate/);
});

test("gate routes reject malformed and unsafe IDs before sending requests", async () => {
  let requests = 0;
  const api = createGateClient(async () => { requests++; return new Response(); });
  for (const id of ["0", "-1", "1.5", "1/link", "9007199254740992"])
    assert.throws(() => gateItemId(id), /valid game gate ID/);
  await assert.rejects(api.link("100", "token", Number.MAX_SAFE_INTEGER + 1), /valid game gate ID/);
  await assert.rejects(api.status("100/anything", "token"), /valid game gate ID/);
  assert.equal(requests, 0);
});

test("gate failures retain server explanations and ambiguous actions require a fresh read", async () => {
  const denied = createGateClient(async () => new Response(JSON.stringify({ success: false, errorMsg: "SMART_GATE_CHAIN_PENDING", message: "Synchronize both gates before linking." }), { status: 409 }));
  await assert.rejects(denied.link("100", "token", 101), (error: unknown) => error instanceof GateApiError && error.code === "SMART_GATE_CHAIN_PENDING" && error.status === 409 && error.message === "Synchronize both gates before linking.");
  const unavailable = createGateClient(async () => { throw new Error("offline"); });
  await assert.rejects(unavailable.link("100", "token", 101), /Refresh the gate links to check whether the destination changed/);
  const invalid = createGateClient(async () => new Response("invalid", { status: 502 }));
  await assert.rejects(invalid.unlink("100", "token", 101), /Refresh the gate links before trying again/);
});
