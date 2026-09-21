import assert from "node:assert/strict";
import test from "node:test";
import type { AssemblyConfig, AssemblySnapshot } from "../src/assembly/types.ts";
import type { IndustryStatus, IndustryTransferRequest } from "../src/industry/client.ts";
import { executeIndustryTask, queuedIndustryStartRequest } from "../src/tasks/industry.ts";
import { createTaskQueue } from "../src/tasks/queue.ts";
import type { TaskDraft, TaskExecutionContext } from "../src/tasks/types.ts";
import type { WalletSession } from "../src/wallet.ts";

const config: AssemblyConfig = { network: "localnet", rpcUrl: "http://127.0.0.1:1", packageId: "0xa", objectRegistryId: "0xb", energyConfigId: "0xc", fuelConfigId: "0xd" };
const assembly: AssemblySnapshot = {
  id: "0x10", itemId: "100", kind: "assembly", name: "Industry", state: "online", ownerAddress: "0x99",
  ownerCapId: "0x11", ownerCapRef: { objectId: "0x11", version: "1", digest: "fixture" }, characterId: "0x12",
  connectedAssemblies: [], observedAt: new Date().toISOString(),
};
function readyStatus(): IndustryStatus {
  return {
    blueprintHash: "a".repeat(64), production: null, chain: { status: "pending", assemblyObjectID: assembly.id },
    facility: {
      itemId: "100", typeId: 9001, status: 2, production: null,
      snapshot: { owner_id: "200", solar_system_id: "300001", blueprint_id: "22", run_time: "60",
        inputs: [{ type_id: "34", quantity: "2" }], outputs: [],
        blueprint_inputs: [{ type_id: "34", quantity: "2", max_quantity: "100" }],
        blueprint_outputs: [{ type_id: "35", quantity: "1", max_quantity: "100" }],
      },
    },
  };
}
function fixture() {
  const status = readyStatus();
  let writes = 0;
  let signed = 0;
  let active = true;
  const calls: string[] = [];
  const wallet = { address: assembly.ownerAddress, signTransaction: async () => { signed++; return { bytes: "fixture", signature: "fixture" }; } } as unknown as WalletSession;
  const context: TaskExecutionContext = {
    config, wallet, progress() {}, assertCurrent() { if (!active) throw new Error("Wallet changed"); },
  };
  const task: TaskDraft = { title: "Production", details: "2 runs", assembly, operation: { kind: "industry-start", request: queuedIndustryStartRequest(status, "2") } };
  const dependencies = {
    api: {
      async authenticate() { calls.push("auth"); return { token: "fixture", characterID: 200, walletAddress: wallet.address, expiresAt: Date.now() + 60000 }; },
      async status() { calls.push("status"); return status; },
      async storage() { calls.push("storage"); return { storageUnits: [{ storageUnitID: 300, name: "Storage", capacity: 100, usedVolume: 20, items: [{ itemID: 301, typeID: 34, name: "Input", quantity: 20, unitVolume: 1 }] }] }; },
      async start(_itemID: string, _token: string, request: unknown) { calls.push("start"); writes++; assert.deepEqual(request, task.operation.kind === "industry-start" ? task.operation.request : null); return { ...status, gameCommitted: true as const, startedJobID: "1" }; },
      async transfer(_itemID: string, _token: string, request: IndustryTransferRequest) { calls.push("transfer"); writes++; return { requestID: request.requestID, gameCommitted: true as const, storageUnitID: 300, direction: request.direction, side: request.side, items: { [request.typeID]: Number(request.quantity) }, chain: { status: "pending" as const, industryStatus: "synced" as const, storageStatus: "pending" as const } }; },
    },
    async loadAssembly() { calls.push("chain"); return assembly; },
  };
  return { task, context, dependencies, status, calls, writes: () => writes, signed: () => signed, invalidate: () => { active = false; } };
}

test("Industry staging captures a valid recipe while prerequisites are pending without modifying readings", () => {
  const status = readyStatus();
  status.facility.status = 1;
  status.facility.snapshot.inputs = [];
  status.facility.snapshot.outputs = [{ type_id: "35", quantity: "100" }];
  const before = structuredClone(status);
  assert.deepEqual(queuedIndustryStartRequest(status, "3"), {
    blueprintID: "22", blueprintHash: "a".repeat(64), runs: "3", expectedJobID: null,
  });
  assert.deepEqual(status, before);
  for (const runs of ["0", "1.5", "9007199254740992"])
    assert.throws(() => queuedIndustryStartRequest(status, runs), /whole run count/);
  status.blueprintHash = null;
  assert.throws(() => queuedIndustryStartRequest(status, "1"), /blueprint hash/);
});

test("Industry execution reads fresh state and chain owner before one exact production request", async () => {
  const f = fixture();
  f.status.facility.snapshot.inputs[0].quantity = "50";
  const result = await executeIndustryTask(f.task, f.context, f.dependencies);
  assert.deepEqual(f.calls, ["auth", "status", "chain", "start"]);
  assert.equal(f.writes(), 1);
  assert.match(result.message, /started on the server.*synchronization is pending/);
});

test("Industry execution blocks changed recipes, missing inputs, wrong owners, and stale wallet sessions", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.status.blueprintHash = "b".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.status.facility.snapshot.inputs = []; },
    (f: ReturnType<typeof fixture>) => { f.status.facility.snapshot.owner_id = "201"; },
    (f: ReturnType<typeof fixture>) => { f.dependencies.loadAssembly = async () => ({ ...assembly, ownerAddress: "0x98" }); },
    (f: ReturnType<typeof fixture>) => { f.dependencies.loadAssembly = async () => { f.invalidate(); return assembly; }; },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(executeIndustryTask(f.task, f.context, f.dependencies));
    assert.equal(f.writes(), 0);
  }
});

test("Industry guards the wallet after the asynchronous authentication challenge", async () => {
  const f = fixture();
  const authenticate = f.dependencies.api.authenticate;
  const dependencies = { ...f.dependencies, api: { ...f.dependencies.api, async authenticate(wallet: WalletSession) {
    f.invalidate();
    await wallet.signTransaction({} as never, config);
    return authenticate();
  } } };
  await assert.rejects(executeIndustryTask(f.task, f.context, dependencies), /Wallet changed/);
  assert.equal(f.signed(), 0);
  assert.equal(f.writes(), 0);
});

test("Industry transfers keep the queued request identifier and revalidate current inventory", async () => {
  const request: IndustryTransferRequest = { requestID: "d5b345fb-6611-4000-a000-4dc47c6d45fc", storageUnitID: "300", direction: "deposit", side: "inputs", typeID: "34", quantity: "5" };
  const f = fixture();
  f.task.operation = { kind: "industry-transfer", request };
  const result = await executeIndustryTask(f.task, f.context, f.dependencies);
  assert.deepEqual(f.calls, ["auth", "status", "storage", "chain", "transfer"]);
  assert.match(result.message, /5 items moved.*Industry: synced; storage: pending/);
  assert.equal(result.industryTransfer?.requestID, request.requestID);
  assert.equal(result.industryTransfer?.chain.storageStatus, "pending");
  assert.equal(f.writes(), 1);
  const other = fixture();
  other.task.operation = { kind: "industry-transfer", request: { ...request, quantity: "21" } };
  await assert.rejects(executeIndustryTask(other.task, other.context, other.dependencies), /no longer has enough/);
  assert.equal(other.writes(), 0);
});

test("continuous queue repetition stops before Industry can no longer receive the transfer", async () => {
  const f = fixture();
  const request: IndustryTransferRequest = { requestID: "d5b345fb-6611-4000-a000-4dc47c6d45fc", storageUnitID: "300", direction: "deposit", side: "inputs", typeID: "34", quantity: "5" };
  f.task.operation = { kind: "industry-transfer", request };
  f.status.facility.snapshot.inputs = [];
  f.status.facility.snapshot.blueprint_inputs[0].max_quantity = "10";
  let input = 0;
  const requestIDs: string[] = [];
  const status = f.dependencies.api.status;
  f.dependencies.api.status = async (...args) => {
    f.status.facility.snapshot.inputs = input ? [{ type_id: "34", quantity: String(input) }] : [];
    return status(...args);
  };
  const transfer = f.dependencies.api.transfer;
  f.dependencies.api.transfer = async (...args) => {
    requestIDs.push(args[2].requestID);
    const result = await transfer(...args);
    input += Number(args[2].quantity);
    return result;
  };

  const queue = createTaskQueue();
  queue.enqueue(f.task, f.context.wallet, f.context.wallet.address);
  queue.enqueueRepeat();
  await queue.run(task => executeIndustryTask(task, f.context, f.dependencies));

  assert.equal(f.writes(), 2, "only the two transfers that fit are submitted");
  assert.equal(input, 10);
  assert.equal(new Set(requestIDs).size, 2, "each successful pass uses a fresh request ID");
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.status), ["failed", "queued"]);
  assert.match(queue.getSnapshot().tasks[0].error || "", /no longer has room/);
});

test("Industry propagates an uncertain result without retrying or claiming completion", async () => {
  const f = fixture();
  let attempts = 0;
  f.dependencies.api.start = async () => { attempts++; throw new Error("Connection closed after submission"); };
  await assert.rejects(executeIndustryTask(f.task, f.context, f.dependencies), /Connection closed/);
  assert.equal(attempts, 1);
  const other = fixture();
  other.dependencies.api.start = async () => ({ ...other.status, gameCommitted: false as true, startedJobID: "1" });
  await assert.rejects(executeIndustryTask(other.task, other.context, other.dependencies), /could not be confirmed/);
});

test("Industry preserves a confirmed production receipt when the wallet changes during submission", async () => {
  const f = fixture();
  let finish!: () => void;
  const submitted = new Promise<void>(resolve => { finish = resolve; });
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  f.dependencies.api.start = async () => {
    started();
    await submitted;
    return { ...f.status, gameCommitted: true, startedJobID: "1" };
  };
  const result = executeIndustryTask(f.task, f.context, f.dependencies);
  await writing;
  f.invalidate();
  finish();
  assert.match((await result).message, /Job #1 started on the server/);
  assert.throws(f.context.assertCurrent, /Wallet changed/);
});

test("Industry preserves a confirmed transfer receipt when the wallet changes during submission", async () => {
  const f = fixture();
  const request: IndustryTransferRequest = { requestID: "d5b345fb-6611-4000-a000-4dc47c6d45fc", storageUnitID: "300", direction: "deposit", side: "inputs", typeID: "34", quantity: "5" };
  f.task.operation = { kind: "industry-transfer", request };
  let finish!: () => void;
  const submitted = new Promise<void>(resolve => { finish = resolve; });
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const transfer = f.dependencies.api.transfer;
  f.dependencies.api.transfer = async (...args) => { started(); await submitted; return transfer(...args); };
  const result = executeIndustryTask(f.task, f.context, f.dependencies);
  await writing;
  f.invalidate();
  finish();
  assert.match((await result).message, /5 items moved.*on the server/);
  assert.equal(f.writes(), 1);
  assert.throws(f.context.assertCurrent, /Wallet changed/);
});
