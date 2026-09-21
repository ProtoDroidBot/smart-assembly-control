import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { configFromEnv } from "../src/assembly/config.ts";
import { createEnergyClient, EnergyApiError, energyItemId, gridConnectionBlockReason, validateEnergyGridStatus } from "../src/energy/client.ts";
import { filterRadarContacts, projectRadarContact } from "../src/energy/radar.ts";
import type { EnergyGridStatus } from "../src/energy/client.ts";
import type { WalletSession } from "../src/wallet.ts";

const grid: EnergyGridStatus = {
  networkNodeID: 100,
  online: true,
  radiusMeters: 80000,
  maxEnergy: 1000,
  energyUsed: 200,
  energyAvailable: 800,
  connectedAssemblies: [{ itemID: 101, typeID: 871, name: "Storage", assemblyStatus: 2, energyRequired: 200, energyUsed: 200, networkNodeID: 100, distanceMeters: 20000 }],
  nearbyAssemblies: [{ itemID: 102, typeID: 872, name: "Turret", assemblyStatus: 1, energyRequired: 300, energyUsed: 0, networkNodeID: 0, distanceMeters: 80000 }],
  radarAssemblies: [
    { itemID: 101, typeID: 871, name: "Storage", typeName: "Smart Storage Unit", structureType: "storage_unit", assemblyStatus: 2,
      distanceMeters: 20000, relativePosition: { x: 12000, y: 0, z: 16000 }, linkedToNode: true, industry: null },
    { itemID: 103, typeID: 873, name: "Factory", typeName: "Medium Industry", structureType: "industry", assemblyStatus: 2,
      distanceMeters: 50000, relativePosition: { x: -30000, y: 40000, z: 0 }, linkedToNode: false,
      industry: { state: "RUNNING", jobID: 77, runEndAtMs: 1700000003000,
        products: [{ typeID: 900, name: "Product", quantityPerRun: 2 }] } },
  ],
};

test("chain-anchored connections remain locked even when the assembly is offline", () => {
  const entry = { ...grid.connectedAssemblies[0], assemblyStatus: 1, canDisconnect: false, disconnectReason: "This assembly is anchored to its Network Node on the blockchain." };
  assert.equal(gridConnectionBlockReason(entry, "disconnect", 100), entry.disconnectReason);
  assert.equal(gridConnectionBlockReason({ ...entry, canDisconnect: true }, "disconnect", 100), "");
  assert.match(gridConnectionBlockReason({ ...entry, assemblyStatus: 2 }, "disconnect", 100), /Take offline/);
  assert.match(gridConnectionBlockReason({ ...entry, networkNodeID: 200 }, "connect", 100), /another node/);
});

test("energy authorization signs the empty challenge once and uses a separate session scope", async () => {
  const address = normalizeSuiAddress("0x99");
  const transaction = new Transaction();
  transaction.setSender(address);
  transaction.setGasOwner(address);
  transaction.setGasBudget(1);
  transaction.setGasPrice(1);
  transaction.setGasPayment([{ objectId: normalizeSuiAddress("0x66"), version: "1", digest: "11111111111111111111111111111111" }]);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const api = createEnergyClient(async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return new Response(JSON.stringify({ success: true, data: String(url).endsWith("challenge") ? { challengeId: "energy-challenge", transactionData: await transaction.toJSON() } : { token: "energy-token", walletAddress: address, characterID: 200, expiresAt: Date.now() + 60000 } }));
  });
  let signatures = 0;
  const wallet = { address, async signTransaction(tx: Transaction) { signatures++; return { bytes: toBase64(await tx.build()), signature: "signature" }; } } as WalletSession;
  assert.equal((await api.authenticate(wallet, configFromEnv({}))).token, "energy-token");
  assert.equal(signatures, 1);
  assert.deepEqual(calls.map(call => call.url), ["/evejs/energy/auth/challenge", "/evejs/energy/auth/session"]);
  assert.equal(calls[1].body.challengeId, "energy-challenge");
  assert.equal(calls[1].body.signature, "signature");
  transaction.moveCall({ target: `${normalizeSuiAddress("0xa")}::assembly::online`, arguments: [] });
  await assert.rejects(api.authenticate(wallet, configFromEnv({})), /challenge is invalid/);
  assert.equal(signatures, 1);
});

test("energy actions use the authenticated node route and accept server-confirmed grid usage", async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const api = createEnergyClient(async (url, options) => {
    requests.push({ url: String(url), options: options! });
    return new Response(JSON.stringify({ success: true, data: grid }));
  });
  assert.deepEqual(await api.status("100", "energy-token"), grid);
  assert.deepEqual(await api.connect("100", "energy-token", 102), grid);
  assert.deepEqual(await api.disconnect("100", "energy-token", 102), grid);
  assert.deepEqual(requests.map(request => request.url), ["/evejs/energy/100/status", "/evejs/energy/100/connect", "/evejs/energy/100/disconnect"]);
  for (const request of requests) {
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error");
    assert.equal(new Headers(request.options.headers).get("Authorization"), "Bearer energy-token");
  }
  assert.deepEqual(JSON.parse(String(requests[1].options.body)), { assemblyID: 102 });
  assert.deepEqual(JSON.parse(String(requests[2].options.body)), { assemblyID: 102 });
});

test("remote scanning uses the authenticated Network Node routes", async () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const requests: { url: string; body: unknown }[] = [];
  const api = createEnergyClient(async (url, options) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, body: JSON.parse(String(options?.body)) });
    const state = requestUrl.endsWith("/result") ? "complete" : "queued";
    return new Response(JSON.stringify({ success: true, data: { scanID: id, state } }));
  });
  const scan = {
    operationKey: "remote-scan/test",
    targetSystemID: 30000142,
    mode: "survey" as const,
    rangeJumps: 2,
    layers: ["sites", "entities"] as const,
  };
  await api.scanConfiguration("100", "energy-token", 2);
  await api.startScan("100", "energy-token", { ...scan, layers: [...scan.layers] });
  await api.scanStatus("100", "energy-token", id);
  await api.scanResult("100", "energy-token", id);
  await api.cancelScan("100", "energy-token", id);
  assert.deepEqual(requests.map(request => request.url), [
    "/evejs/energy/100/scanning/config",
    "/evejs/energy/100/scanning/start",
    `/evejs/energy/100/scanning/${id}/status`,
    `/evejs/energy/100/scanning/${id}/result`,
    `/evejs/energy/100/scanning/${id}/cancel`,
  ]);
  assert.deepEqual(requests[0].body, { rangeJumps: 2 });
  assert.deepEqual(requests[1].body, { ...scan, layers: [...scan.layers] });
  await assert.rejects(api.scanStatus("100", "energy-token", "../../status"), /valid remote scan job/);
});

test("energy grid rejects another node and unavailable or invalid energy readings", async () => {
  assert.throws(() => validateEnergyGridStatus({ ...grid, networkNodeID: 999 }, "100"), /different network node/);
  assert.throws(() => validateEnergyGridStatus({ ...grid, energyAvailable: -1 }, "100"), /incomplete energy/);
  assert.throws(() => validateEnergyGridStatus({ ...grid, nearbyAssemblies: [{ ...grid.nearbyAssemblies[0], energyRequired: NaN }] }, "100"), /incomplete energy/);
  assert.throws(() => validateEnergyGridStatus({ ...grid, radarAssemblies: [{ ...grid.radarAssemblies[0], relativePosition: { x: 0, y: NaN, z: 0 } }] }, "100"), /invalid radar contact/);
  assert.throws(() => validateEnergyGridStatus({ ...grid, radarAssemblies: [{ ...grid.radarAssemblies[1], industry: { ...grid.radarAssemblies[1].industry!, products: [] , jobID: 0 } }] }, "100"), /invalid Industry radar telemetry/);
  const api = createEnergyClient(async () => new Response(JSON.stringify({ success: true, data: { ...grid, networkNodeID: 999 } })));
  await assert.rejects(api.connect("100", "token", 102), /different network node/);
});

test("energy grid accepts a legacy pre-radar response as an empty contact list", () => {
  const legacy = { ...grid } as EnergyGridStatus & { radarAssemblies?: EnergyGridStatus["radarAssemblies"] };
  delete legacy.radarAssemblies;
  assert.deepEqual(validateEnergyGridStatus(legacy as EnergyGridStatus, "100").radarAssemblies, []);
});

test("radar filters structure, network links, and active production independently", () => {
  assert.deepEqual(filterRadarContacts(grid.radarAssemblies, { structureType: "all", linkedOnly: true, producingOnly: false }).map(row => row.itemID), [101]);
  assert.deepEqual(filterRadarContacts(grid.radarAssemblies, { structureType: "industry", linkedOnly: false, producingOnly: true }).map(row => row.itemID), [103]);
  assert.deepEqual(filterRadarContacts(grid.radarAssemblies, { structureType: "storage_unit", linkedOnly: false, producingOnly: true }), []);
});

test("radar projection uses all three relative coordinates and preserves the node origin", () => {
  assert.deepEqual(projectRadarContact({ relativePosition: { x: 0, y: 0, z: 0 } }, 80000), { x: 50, y: 50, depth: 0 });
  assert.deepEqual(projectRadarContact({ relativePosition: { x: 80000, y: 0, z: 0 } }, 80000), { x: 84, y: 50, depth: 0 });
  assert.deepEqual(projectRadarContact({ relativePosition: { x: 0, y: 80000, z: 0 } }, 80000), { x: 50, y: 20, depth: 0 });
  assert.deepEqual(projectRadarContact({ relativePosition: { x: 0, y: 0, z: 80000 } }, 80000), { x: 64, y: 62, depth: 1 });
});

test("energy routes reject malformed and unsafe item IDs before sending requests", async () => {
  let requests = 0;
  const api = createEnergyClient(async () => { requests++; return new Response(); });
  for (const id of ["0", "-1", "1.5", "1/connect", "9007199254740992"])
    assert.throws(() => energyItemId(id), /valid game assembly ID/);
  await assert.rejects(api.connect("100", "token", Number.MAX_SAFE_INTEGER + 1), /valid game assembly ID/);
  await assert.rejects(api.status("100/anything", "token"), /valid game assembly ID/);
  assert.equal(requests, 0);
});

test("ownership, radius and capacity errors retain the server explanation", async () => {
  for (const [code, message, status] of [
    ["ASSEMBLY_ACCESS_DENIED", "You do not own this assembly.", 403],
    ["NETWORK_NODE_OUT_OF_RANGE", "The assembly is outside the node's radius.", 409],
    ["NETWORK_NODE_ENERGY_EXCEEDED", "The grid has insufficient energy.", 409],
  ] as const) {
    const api = createEnergyClient(async () => new Response(JSON.stringify({ success: false, errorMsg: code, message }), { status }));
    await assert.rejects(api.connect("100", "token", 102), (error: unknown) => error instanceof EnergyApiError && error.code === code && error.status === status && error.message === message);
  }
});

test("ambiguous connection outcomes instruct the user to refresh before retrying", async () => {
  const unavailable = createEnergyClient(async () => { throw new Error("offline"); });
  await assert.rejects(unavailable.connect("100", "token", 102), /Refresh the grid to check whether the connection changed/);
  const invalid = createEnergyClient(async () => new Response("invalid", { status: 502 }));
  await assert.rejects(invalid.disconnect("100", "token", 102), /Refresh the grid before trying again/);
});
