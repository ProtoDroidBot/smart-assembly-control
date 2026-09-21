import assert from "node:assert/strict";
import test from "node:test";
import type { AssemblySnapshot } from "../src/assembly/types.ts";
import { industryBlueprintExpectation } from "../src/industry/client.ts";
import type { IndustryBlueprint, IndustryStatus, IndustryStorageUnit } from "../src/industry/client.ts";
import { queuedIndustryStartRequest } from "../src/tasks/industry.ts";
import { projectIndustryQueue } from "../src/tasks/industry-projection.ts";
import type { QueuedTask } from "../src/tasks/queue.ts";
import type { TaskOperation } from "../src/tasks/types.ts";

function fixture() {
  const assembly = { id: "0x10", itemId: "100", name: "Industry", kind: "assembly", ownerAddress: "0x99" } as AssemblySnapshot;
  const identity = {};
  const production = { job_id: "9", state: "STOPPED" as const, requested_runs: "1", completed_runs: "1",
    run_started_at_ms: "1000", run_end_at_ms: "61000", stop_reason: "COMPLETED" };
  const status: IndustryStatus = { production, blueprintHash: "a".repeat(64), chain: { status: "pending" },
    facility: { itemId: "100", typeId: 1, status: 2, production,
      snapshot: { owner_id: "200", solar_system_id: "300001", blueprint_id: "22", run_time: "60",
        inputs: [{ type_id: "34", quantity: "2" }], outputs: [{ type_id: "35", quantity: "1" }],
        blueprint_inputs: [{ type_id: "34", quantity: "2", max_quantity: "100" }],
        blueprint_outputs: [{ type_id: "35", quantity: "1", max_quantity: "100" }] } } };
  const units: IndustryStorageUnit[] = [{ storageUnitID: 300, name: "Storage", capacity: 200, usedVolume: 65,
    items: [{ itemID: 1, typeID: 34, name: "A input", quantity: 5, unitVolume: 1 },
      { itemID: 2, typeID: 36, name: "B input", quantity: 20, unitVolume: 2 },
      { itemID: 3, typeID: 38, name: "C input", quantity: 20, unitVolume: 1 }] }];
  const blueprint: IndustryBlueprint = { blueprintID: "23", blueprintHash: "b".repeat(64), name: "B", runTime: "90",
    inputs: [{ type_id: "36", quantity: "3", max_quantity: "12" }], outputs: [{ type_id: "37", quantity: "2", max_quantity: "40" }] };
  let id = 0;
  const task = (operation: TaskOperation): QueuedTask => ({ id: ++id, title: "Industry", details: "", assembly,
    walletIdentity: identity, walletAddress: "0x99", status: "queued", operation });
  const expected = industryBlueprintExpectation(status);
  const empty = task({ kind: "industry-empty", request: { ...expected, requestID: "empty", storageUnitID: "300" } });
  const change = task({ kind: "industry-blueprint", blueprint, request: { ...expected, requestID: "change",
    blueprintID: blueprint.blueprintID, blueprintHash: blueprint.blueprintHash } });
  const deposit = (amount = "12", typeID = "36") => task({ kind: "industry-transfer", request: { requestID: "transfer", storageUnitID: "300",
    direction: "deposit", side: "inputs", typeID, quantity: amount } });
  const project = (tasks: QueuedTask[]) => projectIndustryQueue(status, units, tasks, assembly, identity);
  return { assembly, identity, status, units, blueprint, empty, change, task, deposit, project };
}

test("empty A, change to B, deposit and start all use B's recipe and preserve the stopped job expectation", () => {
  const f = fixture();
  const tasks = [f.empty, f.change, f.deposit()];
  const beforeStart = f.project(tasks);
  assert.equal(beforeStart.error, "");
  assert.equal(beforeStart.status.facility.snapshot.blueprint_id, "23");
  assert.equal(beforeStart.status.facility.snapshot.run_time, "90");
  assert.deepEqual(beforeStart.status.facility.snapshot.blueprint_inputs, f.blueprint.inputs);
  assert.deepEqual(beforeStart.status.facility.snapshot.blueprint_outputs, f.blueprint.outputs);
  const request = queuedIndustryStartRequest(beforeStart.status, "2");
  assert.deepEqual(request, { blueprintID: "23", blueprintHash: "b".repeat(64), runs: "2", expectedJobID: "9" });
  const result = f.project([...tasks, f.task({ kind: "industry-start", request })]);
  assert.equal(result.error, "");
  assert.equal(result.pendingCount, 4);
  assert.equal(result.productionQueued, true);
  assert.deepEqual(result.status.facility.snapshot.inputs, [{ type_id: "36", quantity: "9" }]);
  assert.deepEqual(result.status.facility.snapshot.outputs, []);
  assert.equal(result.status.production?.job_id, "9");
  assert.equal(result.storageUnits?.[0].items.find(item => item.typeID === 34)?.quantity, 7);
  assert.equal(result.storageUnits?.[0].items.find(item => item.typeID === 36)?.quantity, 8);
  assert.equal(result.storageUnits?.[0].items.find(item => item.typeID === 35)?.name, "Type #35");
  assert.equal(result.storageUnits?.[0].usedVolume, 65);
});

test("a second blueprint change captures the first queued selection without retargeting stale requests", () => {
  const f = fixture();
  const first = f.project([f.empty, f.change]);
  const blueprint = { ...f.blueprint, blueprintID: "24", blueprintHash: "c".repeat(64), name: "C",
    inputs: [{ type_id: "38", quantity: "4", max_quantity: "16" }] };
  const second = f.task({ kind: "industry-blueprint", blueprint, request: { ...industryBlueprintExpectation(first.status), requestID: "second",
    blueprintID: blueprint.blueprintID, blueprintHash: blueprint.blueprintHash } });
  assert.equal(f.project([f.empty, f.change, second]).status.facility.snapshot.blueprint_id, "24");
  const removedFirst = f.project([f.empty, second]);
  assert.match(removedFirst.error, /active blueprint or production job changed/);
  assert.equal(removedFirst.status.facility.snapshot.blueprint_id, "22");
  assert.equal(second.operation.kind === "industry-blueprint" && second.operation.request.expectedBlueprintID, "23");
});

test("removing and reordering prerequisites reports the first invalid task and stops inventory replay", () => {
  const f = fixture();
  const deposit = f.deposit();
  const reordered = f.project([f.change, f.empty, deposit]);
  assert.match(reordered.error, /Empty all inputs and outputs/);
  assert.equal(reordered.pendingCount, 3);
  assert.deepEqual(reordered.status, f.status);
  assert.deepEqual(reordered.storageUnits, f.units);
  const removed = f.project([f.empty, deposit]);
  assert.match(removed.error, /projected blueprint does not accept/);
  assert.deepEqual(removed.status.facility.snapshot.inputs, []);
  assert.equal(removed.storageUnits?.[0].items.find(item => item.typeID === 36)?.quantity, 20);
});

test("projection is scoped to the exact wallet session, assembly and pending task states", () => {
  const f = fixture();
  const ignored: QueuedTask[] = [
    { ...f.empty, walletIdentity: {} },
    { ...f.empty, assembly: { ...f.assembly, id: "0x20" } },
    { ...f.empty, assembly: { ...f.assembly, itemId: "101" } },
    { ...f.empty, status: "completed" },
    { ...f.empty, status: "failed" },
    f.task({ kind: "gate-unlink", targetID: 1 }),
  ];
  assert.equal(f.project(ignored).pendingCount, 0);
  assert.deepEqual(f.project(ignored).status, f.status);
  const running = { ...f.empty, status: "running" as const, assembly: { ...f.assembly, id: `0x${"10".padStart(64, "0")}` } };
  assert.equal(f.project([...ignored, running]).pendingCount, 1);
  assert.deepEqual(f.project([...ignored, running]).status.facility.snapshot.inputs, []);
  assert.equal(projectIndustryQueue(f.status, f.units, [f.empty], f.assembly, null).pendingCount, 0);
});

test("projecting and editing the result never mutates live status, storage, recipe metadata or task requests", () => {
  const f = fixture();
  const tasks = [f.empty, f.change, f.deposit()];
  const original = structuredClone({ status: f.status, units: f.units, tasks });
  const result = f.project(tasks);
  assert.equal(result.error, "");
  result.status.facility.snapshot.blueprint_inputs[0].quantity = "100";
  result.status.production!.job_id = "100";
  result.storageUnits![0].items[0].quantity = 0;
  assert.deepEqual({ status: f.status, units: f.units, tasks }, original);
  assert.equal(tasks[0].walletIdentity, f.identity);
});

test("missing or mismatched captured recipes require removing and queueing the blueprint change again", () => {
  for (const kind of ["missing", "identity", "hash", "slots"] as const) {
    const f = fixture();
    if (f.change.operation.kind !== "industry-blueprint") throw new Error("Invalid fixture");
    if (kind === "missing") delete f.change.operation.blueprint;
    else if (kind === "identity") f.change.operation.blueprint!.blueprintID = "24";
    else if (kind === "hash") f.change.operation.blueprint!.blueprintHash = "c".repeat(64);
    else f.change.operation.blueprint!.inputs[0].max_quantity = "0";
    const result = f.project([f.empty, f.change, f.deposit()]);
    assert.match(result.error, /recipe is missing or inconsistent.*Remove.*queue it again/);
    assert.equal(result.status.facility.snapshot.blueprint_id, "22");
    assert.equal(result.pendingCount, 3);
  }
});

test("a captured catalog recipe may have empty slot arrays even though it cannot start production", () => {
  const f = fixture();
  f.blueprint.inputs = [];
  f.blueprint.outputs = [];
  const result = f.project([f.empty, f.change]);
  assert.equal(result.error, "");
  assert.equal(result.status.facility.snapshot.blueprint_id, "23");
  assert.throws(() => queuedIndustryStartRequest(result.status, "1"), /invalid recipe/);
});

test("transfers account for preceding quantities and input slot capacity atomically", () => {
  const f = fixture();
  const full = f.project([f.empty, f.change, f.deposit("8"), f.deposit("6")]);
  assert.match(full.error, /input slot does not have room/);
  assert.deepEqual(full.status.facility.snapshot.inputs, [{ type_id: "36", quantity: "8" }]);
  assert.equal(full.storageUnits?.[0].items.find(item => item.typeID === 36)?.quantity, 12);
  f.units[0].items.find(item => item.typeID === 36)!.quantity = 5;
  const insufficient = f.project([f.empty, f.change, f.deposit("4"), f.deposit("2")]);
  assert.match(insufficient.error, /storage inventory does not have enough/);
  assert.deepEqual(insufficient.status.facility.snapshot.inputs, [{ type_id: "36", quantity: "4" }]);
  assert.equal(insufficient.storageUnits?.[0].items.find(item => item.typeID === 36)?.quantity, 1);
});

test("empty and withdraw actions reserve known storage capacity without replacing live volume readings", () => {
  const f = fixture();
  f.units[0].capacity = 66;
  const full = f.project([f.empty, f.change]);
  assert.match(full.error, /storage unit does not have room/);
  assert.deepEqual(full.status, f.status);
  assert.deepEqual(full.storageUnits, f.units);
  const deposit = f.deposit("3", "34");
  const withdraw = f.task({ kind: "industry-transfer", request: { requestID: "withdraw", storageUnitID: "300",
    direction: "withdraw", side: "inputs", typeID: "34", quantity: "4" } });
  const result = f.project([deposit, withdraw]);
  assert.equal(result.error, "");
  assert.equal(result.storageUnits?.[0].usedVolume, 65);
  assert.equal(result.storageUnits?.[0].items.find(item => item.typeID === 34)?.quantity, 6);
  const exceeded = f.project([deposit, withdraw, f.empty]);
  assert.match(exceeded.error, /storage unit does not have room/);
  assert.deepEqual(exceeded.status.facility.snapshot.inputs, [{ type_id: "34", quantity: "1" }]);
});

test("missing storage data or inaccessible queued storage stops inventory projection", () => {
  const f = fixture();
  const missing = projectIndustryQueue(f.status, null, [f.empty, f.change], f.assembly, f.identity);
  assert.match(missing.error, /Load nearby storage/);
  assert.equal(missing.storageUnits, null);
  const inaccessible = projectIndustryQueue(f.status, [], [f.empty], f.assembly, f.identity);
  assert.match(inaccessible.error, /no longer accessible/);
  assert.deepEqual(inaccessible.status, f.status);
});

test("production consumes only its first run and later recipe/job actions wait for server confirmation", () => {
  const f = fixture();
  const tasks = [f.empty, f.change, f.deposit()];
  const projected = f.project(tasks);
  const start = f.task({ kind: "industry-start", request: queuedIndustryStartRequest(projected.status, null) });
  const afterStart = f.project([...tasks, start]);
  assert.equal(afterStart.error, "");
  assert.deepEqual(afterStart.status.facility.snapshot.inputs, [{ type_id: "36", quantity: "9" }]);
  assert.deepEqual(afterStart.status.facility.snapshot.outputs, []);
  const deposited = f.project([...tasks, start, f.deposit("3")]);
  assert.equal(deposited.error, "");
  assert.deepEqual(deposited.status.facility.snapshot.inputs, [{ type_id: "36", quantity: "12" }]);
  const repeated = f.project([...tasks, start, start]);
  assert.match(repeated.error, /preceding production task creates a new job/);
  assert.equal(repeated.productionQueued, true);
  const empty = f.task({ kind: "industry-empty", request: { ...industryBlueprintExpectation(afterStart.status), requestID: "emptyB", storageUnitID: "300" } });
  assert.match(f.project([...tasks, start, empty]).error, /preceding production task creates a new job/);
});

test("production cannot use a removed deposit or a stale blueprint/job expectation", () => {
  const f = fixture();
  const tasks = [f.empty, f.change, f.deposit()];
  const request = queuedIndustryStartRequest(f.project(tasks).status, "1");
  const start = f.task({ kind: "industry-start", request });
  const removed = f.project([f.empty, f.change, start]);
  assert.match(removed.error, /Add the required inputs/);
  assert.equal(removed.productionQueued, false);
  request.expectedJobID = "8";
  const stale = f.project([...tasks, start]);
  assert.match(stale.error, /blueprint or production job differs/);
  assert.deepEqual(stale.status.facility.snapshot.inputs, [{ type_id: "36", quantity: "12" }]);
});
