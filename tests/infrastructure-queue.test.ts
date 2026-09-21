import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { configFromEnv } from "../src/assembly/config.ts";
import type { AssemblySnapshot } from "../src/assembly/types.ts";
import type { EnergyGridStatus } from "../src/energy/client.ts";
import type { GateStatus } from "../src/gate/client.ts";
import { executeInfrastructureTask } from "../src/tasks/infrastructure.ts";
import type { TaskDraft, TaskExecutionContext } from "../src/tasks/types.ts";
import type { WalletSession } from "../src/wallet.ts";

const id = (value: string) => normalizeSuiAddress(`0x${value}`);
const address = id("99");
const config = configFromEnv({});
const assembly: AssemblySnapshot = {
  id: id("10"), itemId: "100", tenant: "dev", kind: "gate", name: "Home gate", state: "online",
  ownerAddress: address, characterId: id("30"), ownerCapId: id("20"),
  ownerCapRef: { objectId: id("20"), version: "1", digest: "11111111111111111111111111111111" },
  networkNodeId: id("40"), networkNodeState: "online", connectedAssemblies: [], observedAt: new Date().toISOString(),
};
const gate: GateStatus = {
  gate: { itemID: 100, typeID: 872, name: "Home gate", solarSystemID: 1, assemblyStatus: 1, destinationGateID: null, rangeLightYears: 4.5 },
  destination: null,
  candidates: [{ itemID: 101, typeID: 872, name: "Other gate", solarSystemID: 2, assemblyStatus: 1, destinationGateID: null, rangeLightYears: 4.5, distanceLightYears: 4, eligible: true, reason: null }],
  rangeLightYears: 4.5, chain: { status: "synced", gateObjectID: assembly.id },
};
const grid: EnergyGridStatus = {
  networkNodeID: 100, online: true, radiusMeters: 80000, maxEnergy: 1000, energyUsed: 0, energyAvailable: 1000,
  connectedAssemblies: [],
  nearbyAssemblies: [{ itemID: 101, typeID: 871, name: "Storage", assemblyStatus: 1, energyRequired: 200, energyUsed: 0, networkNodeID: 0 }],
  radarAssemblies: [],
};
const task = (kind: "gate-link" | "gate-unlink" | "energy-connect" | "energy-disconnect"): TaskDraft => ({
  title: kind, details: "Fixture task", assembly: { ...assembly, kind: kind.startsWith("gate") ? "gate" : "network_node" },
  operation: { kind, targetID: 101 },
});

async function fixture(t: TestContext, readings: GateStatus | EnergyGridStatus, result = readings) {
  const challenge = new Transaction();
  challenge.setSender(address);
  challenge.setGasOwner(address);
  challenge.setGasBudget(1);
  challenge.setGasPrice(1);
  challenge.setGasPayment([{ objectId: id("66"), version: "1", digest: "11111111111111111111111111111111" }]);
  const transactionData = await challenge.toJSON();
  const calls: { url: string; body: unknown }[] = [];
  let signatures = 0;
  let valid = true;
  let afterResponse = (_url: string) => {};
  let mutationError = false;
  let freshAssembly: AssemblySnapshot = { ...assembly, kind: "gate" in readings ? "gate" : "network_node" };
  let afterAssemblyRead = () => {};
  let assemblyReads = 0;
  const dependencies = {
    async loadAssembly(settings: typeof config, objectID: string) {
      assert.equal(settings, config);
      assert.equal(objectID, assembly.id);
      assemblyReads++;
      afterAssemblyRead();
      return freshAssembly;
    },
  };
  t.mock.method(globalThis, "fetch", async (url: unknown, options: RequestInit) => {
    const route = String(url);
    calls.push({ url: route, body: JSON.parse(String(options.body)) });
    const authentication = route.endsWith("/auth/challenge") || route.endsWith("/auth/session");
    if (!authentication) assert.equal(new Headers(options.headers).get("Authorization"), "Bearer fixture-token");
    const data = route.endsWith("/auth/challenge") ? { challengeId: "fixture-challenge", transactionData }
      : route.endsWith("/auth/session") ? { token: "fixture-token", walletAddress: address, characterID: 200, expiresAt: Date.now() + 60000 }
        : route.endsWith("/status") ? readings : result;
    afterResponse(route);
    if (!authentication && !route.endsWith("/status") && mutationError) throw new Error("Response lost");
    return new Response(JSON.stringify({ success: true, data }));
  });
  const wallet = { address, async signTransaction(tx: Transaction) {
    signatures++;
    return { bytes: toBase64(await tx.build()), signature: "fixture-signature" };
  } } as WalletSession;
  const context: TaskExecutionContext = {
    config, wallet, assertCurrent() { if (!valid) throw new Error("Wallet context changed"); }, progress() {},
  };
  return {
    context, calls, dependencies,
    setAssembly: (next: AssemblySnapshot) => { freshAssembly = next; },
    afterAssemblyRead: (callback: () => void) => { afterAssemblyRead = callback; },
    assemblyReads: () => assemblyReads,
    signatures: () => signatures,
    invalidate: () => { valid = false; },
    afterResponse: (callback: (url: string) => void) => { afterResponse = callback; },
    loseMutation: () => { mutationError = true; },
    mutations: () => calls.filter(call => !/\/(?:challenge|session|status)$/.test(call.url)),
  };
}

test("queued gate links authenticate and recheck fresh eligibility before one mutation", async t => {
  const linked = { ...gate, gate: { ...gate.gate, destinationGateID: 101 }, destination: gate.candidates[0], chain: { ...gate.chain, status: "pending" as const } };
  const f = await fixture(t, gate, linked);
  const result = await executeInfrastructureTask(task("gate-link"), f.context, f.dependencies);
  assert.equal(f.signatures(), 1);
  assert.deepEqual(f.calls.map(call => call.url), ["/evejs/gates/auth/challenge", "/evejs/gates/auth/session", "/evejs/gates/100/status", "/evejs/gates/100/link"]);
  assert.deepEqual(f.mutations()[0].body, { destinationGateID: 101 });
  assert.match(result.message, /Linked.*in game.*pending/);
  assert.equal(f.assemblyReads(), 1);
});

test("queued unlink preserves its intended destination when the current link changes", async t => {
  const status = { ...gate, gate: { ...gate.gate, destinationGateID: 102 }, destination: { ...gate.candidates[0], itemID: 102 } };
  const f = await fixture(t, status);
  await assert.rejects(executeInfrastructureTask(task("gate-unlink"), f.context, f.dependencies), /destination changed/);
  assert.equal(f.mutations().length, 0);
});

test("queued gates reject a different chain object and changed candidate eligibility", async t => {
  for (const [readings, reason] of [
    [{ ...gate, chain: { ...gate.chain, gateObjectID: id("11") } }, /different chain object/],
    [{ ...gate, candidates: [] }, /no longer an available owned gate/],
    [{ ...gate, candidates: [{ ...gate.candidates[0], eligible: false, reason: "SMART_GATE_MUST_BE_OFFLINE" }] }, /offline/],
  ] as const) await t.test(reason.source, async sub => {
    const f = await fixture(sub, readings);
    await assert.rejects(executeInfrastructureTask(task("gate-link"), f.context, f.dependencies), reason);
    assert.equal(f.mutations().length, 0);
  });
});

test("queued authentication never signs after a wallet context change during challenge loading", async t => {
  const f = await fixture(t, gate);
  f.afterResponse(url => { if (url.endsWith("/challenge")) f.invalidate(); });
  await assert.rejects(executeInfrastructureTask(task("gate-link"), f.context, f.dependencies), /Wallet context changed/);
  assert.equal(f.signatures(), 0);
  assert.equal(f.calls.length, 1);
});

test("queued infrastructure never mutates after a wallet context change during its fresh read", async t => {
  const f = await fixture(t, grid);
  f.afterResponse(url => { if (url.endsWith("/status")) f.invalidate(); });
  await assert.rejects(executeInfrastructureTask(task("energy-connect"), f.context, f.dependencies), /Wallet context changed/);
  assert.equal(f.mutations().length, 0);
});

test("queued connection reads current state and verifies the resulting connection", async t => {
  const connected = { ...grid, connectedAssemblies: [{ ...grid.nearbyAssemblies[0], networkNodeID: 100 }], nearbyAssemblies: [] };
  const f = await fixture(t, grid, connected);
  const result = await executeInfrastructureTask(task("energy-connect"), f.context, f.dependencies);
  assert.match(result.message, /connected to/);
  assert.equal(f.mutations().length, 1);
  assert.deepEqual(f.mutations()[0].body, { assemblyID: 101 });
  assert.equal(f.assemblyReads(), 1);
});

test("queued disconnection revalidates offline state and immutable chain anchoring", async t => {
  for (const target of [
    { ...grid.nearbyAssemblies[0], assemblyStatus: 2 },
    { ...grid.nearbyAssemblies[0], canDisconnect: false, disconnectReason: "Anchored to chain node" },
  ]) await t.test(String(target.assemblyStatus) + ("canDisconnect" in target), async sub => {
    const f = await fixture(sub, { ...grid, connectedAssemblies: [target], nearbyAssemblies: [] });
    await assert.rejects(executeInfrastructureTask(task("energy-disconnect"), f.context, f.dependencies), /offline|Anchored/);
    assert.equal(f.mutations().length, 0);
  });
});

test("queued infrastructure failures propagate without retrying an uncertain mutation", async t => {
  const f = await fixture(t, grid);
  f.loseMutation();
  await assert.rejects(executeInfrastructureTask(task("energy-connect"), f.context, f.dependencies), /Refresh the grid to check whether/);
  assert.equal(f.mutations().length, 1);
});

test("queued infrastructure rejects wrong owners and unsafe targets before authentication", async t => {
  const f = await fixture(t, grid);
  await assert.rejects(executeInfrastructureTask({ ...task("energy-connect"), assembly: { ...assembly, ownerAddress: id("88") } }, f.context, f.dependencies), /owns this queued assembly/);
  await assert.rejects(executeInfrastructureTask({ ...task("energy-connect"), operation: { kind: "energy-connect", targetID: Number.MAX_SAFE_INTEGER + 1 } }, f.context, f.dependencies), /valid game assembly ID/);
  assert.equal(f.calls.length, 0);
});

test("queued gate and energy tasks verify current chain identity and ownership before mutation", async t => {
  for (const kind of ["gate-link", "energy-connect"] as const) {
    for (const change of [{ id: id("11") }, { itemId: "101" }, { kind: "assembly" as const }, { ownerAddress: id("88") }]) {
      await t.test(`${kind}: ${Object.keys(change)[0]}`, async sub => {
        const f = await fixture(sub, kind === "gate-link" ? gate : grid);
        f.setAssembly({ ...task(kind).assembly, ...change });
        await assert.rejects(executeInfrastructureTask(task(kind), f.context, f.dependencies), /queued assembly, game identity, or owner changed/);
        assert.equal(f.assemblyReads(), 1);
        assert.equal(f.mutations().length, 0);
      });
    }
  }
});

test("missing queued chain objects block reused game IDs after a deployment reset", async t => {
  const f = await fixture(t, grid);
  f.afterAssemblyRead(() => { throw new Error("Assembly could not be read from this Sui network"); });
  await assert.rejects(executeInfrastructureTask(task("energy-connect"), f.context, f.dependencies), /could not be read/);
  assert.equal(f.mutations().length, 0);
});

test("wallet changes during the chain identity check prevent the queued mutation", async t => {
  const f = await fixture(t, gate);
  f.afterAssemblyRead(f.invalidate);
  await assert.rejects(executeInfrastructureTask(task("gate-link"), f.context, f.dependencies), /Wallet context changed/);
  assert.equal(f.mutations().length, 0);
});

test("gate and energy clients validate source game IDs before queued mutations", async t => {
  for (const [kind, readings] of [
    ["gate-link", { ...gate, gate: { ...gate.gate, itemID: 999 } }],
    ["energy-connect", { ...grid, networkNodeID: 999 }],
  ] as const) await t.test(kind, async sub => {
    const f = await fixture(sub, readings);
    await assert.rejects(executeInfrastructureTask(task(kind), f.context, f.dependencies), /different gate|different network node/);
    assert.equal(f.mutations().length, 0);
  });
});
