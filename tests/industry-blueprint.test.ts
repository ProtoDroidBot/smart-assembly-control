import assert from "node:assert/strict";
import test from "node:test";
import { createIndustryClient, industryBlueprintExpectation, validateIndustryBlueprintExpectation } from "../src/industry/client.ts";
import type { IndustryBlueprintChangeRequest, IndustryEmptyRequest, IndustryStatus, IndustryBlueprint } from "../src/industry/client.ts";

const uuid = "e7949ad2-56c0-4a98-a970-83b293a4df93";
const sourceHash = "a".repeat(64);
const targetHash = "b".repeat(64);
const blueprint: IndustryBlueprint = { blueprintID: "23", blueprintHash: targetHash, name: "New recipe", runTime: "30",
  inputs: [{ type_id: "36", quantity: "3", max_quantity: "30" }], outputs: [{ type_id: "37", quantity: "1", max_quantity: "10" }] };
function status(): IndustryStatus {
  return { blueprintHash: sourceHash, production: null, chain: { status: "pending" },
    facility: { itemId: "100", typeId: 9001, status: 2, production: null,
      snapshot: { owner_id: "200", solar_system_id: "300001", blueprint_id: "22", run_time: "60",
        inputs: [{ type_id: "34", quantity: "2" }], outputs: [{ type_id: "35", quantity: "1" }],
        blueprint_inputs: [{ type_id: "34", quantity: "2", max_quantity: "100" }],
        blueprint_outputs: [{ type_id: "35", quantity: "1", max_quantity: "100" }] } } };
}
const change: IndustryBlueprintChangeRequest = { requestID: uuid, blueprintID: "23", blueprintHash: targetHash,
  expectedBlueprintID: "22", expectedBlueprintHash: sourceHash, expectedJobID: null };
const empty: IndustryEmptyRequest = { requestID: uuid, storageUnitID: "300", expectedBlueprintID: "22", expectedBlueprintHash: sourceHash, expectedJobID: null };
const emptyResult = { requestID: uuid, gameCommitted: true, storageUnitID: 300, inputs: { "34": 2 }, outputs: { "35": 1 },
  chain: { status: "pending", industryStatus: "synced", storageStatus: "pending" } };
function changeResult() {
  const next = status();
  next.blueprintHash = targetHash;
  next.facility.snapshot.blueprint_id = "23";
  next.facility.snapshot.inputs = [];
  next.facility.snapshot.outputs = [];
  next.facility.snapshot.blueprint_inputs = blueprint.inputs;
  next.facility.snapshot.blueprint_outputs = blueprint.outputs;
  return { ...next, requestID: uuid, gameCommitted: true, selectedBlueprintID: "23" };
}
function clientWith(data: unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const client = createIndustryClient(async (url, init) => {
    calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ success: true, data }), { status: 200 });
  });
  return { client, calls };
}

test("blueprint catalog validates unique recipes and names before display", async () => {
  const f = clientWith({ blueprints: [blueprint] });
  assert.deepEqual(await f.client.blueprints("100", "session"), { blueprints: [blueprint] });
  assert.equal(f.calls[0].path, "/evejs/industry/100/blueprints");
  for (const blueprints of [[blueprint, blueprint], [{ ...blueprint, blueprintHash: "bad" }], [{ ...blueprint, runTime: "-1" }], [{ ...blueprint, outputs: [{ type_id: "37", quantity: "3", max_quantity: "1" }] }]])
    await assert.rejects(clientWith({ blueprints }).client.blueprints("100", "session"), /incomplete or inconsistent/);
});

test("blueprint expectations bind selected recipe and job, allow queued emptying, and reject active production", () => {
  const read = status();
  assert.deepEqual(industryBlueprintExpectation(read), { expectedBlueprintID: "22", expectedBlueprintHash: sourceHash, expectedJobID: null });
  validateIndustryBlueprintExpectation(read, change);
  read.blueprintHash = targetHash;
  assert.throws(() => validateIndustryBlueprintExpectation(read, change), /blueprint or production job changed/);
  read.production = read.facility.production = { job_id: "1", state: "RUNNING", requested_runs: "1", completed_runs: "0", run_started_at_ms: "1", run_end_at_ms: "2", stop_reason: null };
  assert.throws(() => industryBlueprintExpectation(read), /Finish or stop production/);
});

test("change submits one exact reviewed request and accepts game commit with pending sync", async () => {
  const f = clientWith(changeResult());
  const result = await f.client.changeBlueprint("100", "session", change);
  assert.equal(result.gameCommitted, true);
  assert.equal(result.chain.status, "pending");
  assert.deepEqual(f.calls, [{ path: "/evejs/industry/100/blueprint", body: change }]);
  for (const altered of [{ selectedBlueprintID: "24" }, { requestID: "wrong" }, { blueprintHash: sourceHash }, { gameCommitted: false }])
    await assert.rejects(clientWith({ ...changeResult(), ...altered }).client.changeBlueprint("100", "session", change));
});

test("blueprint mutations reject malformed and stale identity fields before requests", async () => {
  for (const altered of [{ expectedBlueprintID: "-1" }, { expectedBlueprintHash: null }, { expectedJobID: "1.2" }, { requestID: "bad" }, { blueprintID: "22" }, { blueprintHash: "bad" }]) {
    const f = clientWith(changeResult());
    await assert.rejects(f.client.changeBlueprint("100", "session", { ...change, ...altered }));
    assert.equal(f.calls.length, 0);
  }
  const f = clientWith(emptyResult);
  await assert.rejects(f.client.emptyBlueprint("100", "session", { ...empty, storageUnitID: "0" }));
  assert.equal(f.calls.length, 0);
});

test("empty preserves both inventory receipts and destination identity", async () => {
  const f = clientWith(emptyResult);
  assert.deepEqual(await f.client.emptyBlueprint("100", "session", empty), emptyResult);
  assert.deepEqual(f.calls, [{ path: "/evejs/industry/100/empty", body: empty }]);
  for (const altered of [{ storageUnitID: 301 }, { requestID: "wrong" }, { inputs: { "34": -1 } }, { outputs: { "35": 1.5 } }, { inputs: { "34": 4294967295 }, outputs: { "34": 1 } }, { chain: { status: "synced", industryStatus: "synced", storageStatus: "error" } }, { gameCommitted: false }])
    await assert.rejects(clientWith({ ...emptyResult, ...altered }).client.emptyBlueprint("100", "session", empty));
});

test("neither blueprint mutation retries an uncertain response", async () => {
  let calls = 0;
  const client = createIndustryClient(async () => { calls++; throw new Error("Response lost"); });
  await assert.rejects(client.changeBlueprint("100", "session", change), /could not be reached/);
  assert.equal(calls, 1);
  await assert.rejects(client.emptyBlueprint("100", "session", empty), /could not be reached/);
  assert.equal(calls, 2);
});
