import assert from "node:assert/strict";
import test from "node:test";
import { executeIndustryBlueprintTask } from "../src/tasks/industry-blueprint.ts";
import { executeIndustryTask, queuedIndustryStartRequest } from "../src/tasks/industry.ts";
import { projectIndustryQueue } from "../src/tasks/industry-projection.ts";
import { createTaskQueue } from "../src/tasks/queue.ts";
import type { TaskDraft, TaskExecutionContext } from "../src/tasks/types.ts";
import type { IndustryStatus, IndustryBlueprint, IndustryBlueprintChangeRequest, IndustryEmptyRequest, IndustryStartRequest, IndustryTransferRequest } from "../src/industry/client.ts";
import type { AssemblySnapshot } from "../src/assembly/types.ts";
import type { WalletSession } from "../src/wallet.ts";

function fixture() {
  const assembly = { id: "0x10", itemId: "100", name: "Industry", kind: "assembly", ownerAddress: "0x99" } as AssemblySnapshot;
  const config = { network: "localnet" as const, rpcUrl: "http://127.0.0.1:1", packageId: "0xa", objectRegistryId: "0xb", energyConfigId: "0xc", fuelConfigId: "0xd" };
  let active = true;
  const calls: string[] = [];
  const status: IndustryStatus = { production: null, blueprintHash: "a".repeat(64), chain: { status: "pending" },
    facility: { itemId: "100", typeId: 1, status: 2, production: null,
      snapshot: { owner_id: "200", solar_system_id: "300001", blueprint_id: "22", run_time: "60", inputs: [{ type_id: "34", quantity: "2" }], outputs: [{ type_id: "35", quantity: "1" }],
        blueprint_inputs: [{ type_id: "34", quantity: "2", max_quantity: "100" }], blueprint_outputs: [{ type_id: "35", quantity: "1", max_quantity: "100" }] } } };
  const expected = { expectedBlueprintID: "22", expectedBlueprintHash: status.blueprintHash!, expectedJobID: null };
  const empty: TaskDraft = { title: "Empty", details: "All materials", assembly, operation: { kind: "industry-empty", request: { ...expected, requestID: "e7949ad2-56c0-4a98-a970-83b293a4df93", storageUnitID: "300" } } };
  const change: TaskDraft = { title: "Change", details: "New recipe", assembly, operation: { kind: "industry-blueprint", request: { ...expected, requestID: "a7949ad2-56c0-4a98-a970-83b293a4df93", blueprintID: "23", blueprintHash: "b".repeat(64) } } };
  const wallet = { address: "0x99", async signTransaction() { calls.push("sign"); return { bytes: "", signature: "" }; } } as unknown as WalletSession;
  const context: TaskExecutionContext = { config, wallet, progress() {}, assertCurrent() { if (!active) throw new Error("Wallet changed"); } };
  const dependencies = { api: {
    async authenticate() { return { token: "session", characterID: 200, walletAddress: wallet.address, expiresAt: Date.now() + 60000 }; },
    async status() { calls.push("status"); return structuredClone(status); },
    async storage() { return { storageUnits: [{ storageUnitID: 300, name: "Storage", items: [], capacity: 100, usedVolume: 0 }] }; },
    async blueprints() { return { blueprints: [{ blueprintID: "23", blueprintHash: "b".repeat(64), name: "Recipe", runTime: "60", inputs: [], outputs: [] }] }; },
    async changeBlueprint(_id: string, _token: string, request: IndustryBlueprintChangeRequest) {
      calls.push("change"); status.facility.snapshot.blueprint_id = request.blueprintID; status.blueprintHash = request.blueprintHash;
      return { ...status, requestID: request.requestID, gameCommitted: true as const, selectedBlueprintID: request.blueprintID };
    },
    async emptyBlueprint(_id: string, _token: string, request: IndustryEmptyRequest) {
      calls.push("empty"); status.facility.snapshot.inputs = []; status.facility.snapshot.outputs = [];
      return { requestID: request.requestID, gameCommitted: true as const, storageUnitID: Number(request.storageUnitID), inputs: { "34": 2 }, outputs: { "35": 1 }, chain: { status: "pending" as const, industryStatus: "pending" as const, storageStatus: "pending" as const } };
    },
  }, async loadAssembly() { calls.push("chain"); return assembly; } };
  return { empty, change, status, calls, context, dependencies, invalidate: () => { active = false; } };
}

test("queued empty then change use fresh inventory and retain the storage sync receipt", async () => {
  const f = fixture();
  const queue = createTaskQueue();
  queue.enqueue(f.empty, f.context.wallet, f.context.wallet.address);
  queue.enqueue(f.change, f.context.wallet, f.context.wallet.address);
  assert.deepEqual(f.calls, []);
  await queue.run(task => executeIndustryBlueprintTask(task, f.context, f.dependencies));
  assert.deepEqual(f.calls, ["status", "chain", "empty", "status", "chain", "change"]);
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.status), ["completed", "completed"]);
  assert.equal(f.status.facility.snapshot.blueprint_id, "23");
  assert.equal(queue.getSnapshot().tasks[0].result?.industryTransfer?.storageUnitID, 300);
});

test("queued blueprint change supplies the recipe and stopped job identity for subsequent deposit and production", async () => {
  const f = fixture();
  const queue = createTaskQueue();
  const blueprint: IndustryBlueprint = {
    blueprintID: "23", blueprintHash: "b".repeat(64), name: "New recipe", runTime: "120",
    inputs: [{ type_id: "36", quantity: "5", max_quantity: "100" }],
    outputs: [{ type_id: "37", quantity: "2", max_quantity: "100" }],
  };
  const previousProduction = {
    job_id: "7", state: "STOPPED" as const, requested_runs: "1", completed_runs: "1",
    run_started_at_ms: "1000", run_end_at_ms: "61000", stop_reason: "COMPLETED",
  };
  f.status.production = previousProduction;
  f.status.facility.production = previousProduction;
  assert.equal(f.empty.operation.kind, "industry-empty");
  assert.equal(f.change.operation.kind, "industry-blueprint");
  if (f.empty.operation.kind !== "industry-empty" || f.change.operation.kind !== "industry-blueprint") return;
  f.empty.operation.request.expectedJobID = "7";
  f.change.operation.request.expectedJobID = "7";
  f.change.operation.blueprint = blueprint;
  const storageUnits = [{ storageUnitID: 300, name: "Storage", capacity: 100, usedVolume: 20,
    items: [{ itemID: 301, typeID: 36, name: "New input", quantity: 20, unitVolume: 1 }] }];
  const enqueue = (draft: TaskDraft) => queue.enqueue(draft, f.context.wallet, f.context.wallet.address);
  enqueue(f.empty);
  enqueue(f.change);
  const project = () => projectIndustryQueue(f.status, storageUnits, queue.getSnapshot().tasks, f.empty.assembly, f.context.wallet);
  const changed = project();
  assert.equal(changed.error, "");
  assert.equal(changed.status.facility.snapshot.blueprint_id, "23");
  assert.equal(changed.status.production?.job_id, "7");
  const deposit: IndustryTransferRequest = {
    requestID: "b7949ad2-56c0-4a98-a970-83b293a4df93", storageUnitID: "300", direction: "deposit",
    side: "inputs", typeID: "36", quantity: "10",
  };
  enqueue({ title: "Deposit", details: "New recipe input", assembly: f.empty.assembly,
    operation: { kind: "industry-transfer", request: deposit } });
  const request = queuedIndustryStartRequest(project().status, "2");
  assert.deepEqual(request, { blueprintID: "23", blueprintHash: blueprint.blueprintHash, runs: "2", expectedJobID: "7" });
  enqueue({ title: "Start", details: "New recipe", assembly: f.empty.assembly, operation: { kind: "industry-start", request } });
  assert.deepEqual(f.calls, [], "staging the sequence does not issue any requests");
  assert.equal(f.status.facility.snapshot.blueprint_id, "22", "staging preserves the live reading");

  const dependencies = { ...f.dependencies, api: { ...f.dependencies.api,
    async blueprints() { return { blueprints: [blueprint] }; },
    async storage() { return { storageUnits: structuredClone(storageUnits) }; },
    async changeBlueprint(id: string, token: string, change: IndustryBlueprintChangeRequest) {
      Object.assign(f.status.facility.snapshot, {
        run_time: blueprint.runTime, blueprint_inputs: blueprint.inputs, blueprint_outputs: blueprint.outputs,
      });
      return f.dependencies.api.changeBlueprint(id, token, change);
    },
    async transfer(_id: string, _token: string, transfer: IndustryTransferRequest) {
      f.calls.push("transfer");
      assert.deepEqual(transfer, deposit);
      storageUnits[0].items[0].quantity -= Number(transfer.quantity);
      f.status.facility.snapshot.inputs = [{ type_id: transfer.typeID, quantity: transfer.quantity }];
      return { requestID: transfer.requestID, gameCommitted: true as const, storageUnitID: 300,
        direction: transfer.direction, side: transfer.side, items: { "36": Number(transfer.quantity) },
        chain: { status: "pending" as const, industryStatus: "pending" as const, storageStatus: "pending" as const } };
    },
    async start(_id: string, _token: string, start: IndustryStartRequest) {
      f.calls.push("start");
      assert.deepEqual(start, request);
      assert.equal(f.status.facility.snapshot.inputs[0].quantity, "10");
      f.status.facility.snapshot.inputs[0].quantity = "5";
      f.status.production = { ...previousProduction, job_id: "8", state: "RUNNING", requested_runs: "2", completed_runs: "0",
        run_started_at_ms: "61000", run_end_at_ms: "181000", stop_reason: null };
      f.status.facility.production = f.status.production;
      return { ...structuredClone(f.status), gameCommitted: true as const, startedJobID: "8" };
    },
  } };
  await queue.run(task => task.operation.kind === "industry-start" || task.operation.kind === "industry-transfer"
    ? executeIndustryTask(task, f.context, dependencies)
    : executeIndustryBlueprintTask(task, f.context, dependencies));
  assert.deepEqual(queue.getSnapshot().tasks.map(task => ({ status: task.status, error: task.error })),
    Array.from({ length: 4 }, () => ({ status: "completed", error: undefined })));
  assert.deepEqual(f.calls, ["status", "chain", "empty", "status", "chain", "change", "status", "chain", "transfer", "status", "chain", "start"]);
  assert.equal(f.status.facility.snapshot.blueprint_id, "23");
  assert.equal(f.status.production?.job_id, "8");
  assert.equal(f.status.facility.snapshot.inputs[0].quantity, "5");
});

test("change never proceeds when materials remain or selected recipe identity changed", async () => {
  const f = fixture();
  await assert.rejects(executeIndustryBlueprintTask(f.change, f.context, f.dependencies), /Empty all inputs and outputs/);
  f.status.facility.snapshot.inputs = []; f.status.facility.snapshot.outputs = []; f.status.blueprintHash = "c".repeat(64);
  await assert.rejects(executeIndustryBlueprintTask(f.change, f.context, f.dependencies), /active blueprint or production job changed/);
  assert.ok(!f.calls.includes("change"));
});

test("empty failure stops the queued switch without replaying the empty", async () => {
  const f = fixture();
  const queue = createTaskQueue();
  queue.enqueue(f.empty, f.context.wallet, "0x99"); queue.enqueue(f.change, f.context.wallet, "0x99");
  f.dependencies.api.emptyBlueprint = async () => { f.calls.push("failed-empty"); throw new Error("STORAGE_CAPACITY_EXCEEDED"); };
  await queue.run(task => executeIndustryBlueprintTask(task, f.context, f.dependencies));
  await queue.run(task => executeIndustryBlueprintTask(task, f.context, f.dependencies));
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.status), ["failed", "queued"]);
  assert.equal(f.calls.filter(call => call === "failed-empty").length, 1);
  assert.ok(!f.calls.includes("change"));
});

test("blueprint tasks stop on changed wallet or current chain owner before mutation", async () => {
  for (const walletChanged of [true, false]) {
    const f = fixture();
    f.dependencies.loadAssembly = async () => { if (walletChanged) f.invalidate(); return { ...f.empty.assembly, ownerAddress: walletChanged ? "0x99" : "0x98" }; };
    await assert.rejects(executeIndustryBlueprintTask(f.empty, f.context, f.dependencies), /Wallet changed|owner changed/);
    assert.ok(!f.calls.includes("empty"));
  }
});

test("confirmed empty result survives a wallet change during submission", async () => {
  const f = fixture();
  const original = f.dependencies.api.emptyBlueprint;
  f.dependencies.api.emptyBlueprint = async (...args) => { const result = await original(...args); f.invalidate(); return result; };
  const result = await executeIndustryBlueprintTask(f.empty, f.context, f.dependencies);
  assert.match(result.message, /Moved all 3 input and output items/);
  assert.equal(result.industryTransfer?.gameCommitted, true);
});
