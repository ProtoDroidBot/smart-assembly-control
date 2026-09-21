import assert from "node:assert/strict";
import test from "node:test";
import type { SuiObjectResponse } from "@mysten/sui/jsonRpc";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import {
  fuelTypeName,
  loadNetworkNodeFuel,
  projectFuel,
} from "../src/assembly/fuel.ts";
import type { FuelReader, NetworkNodeFuelSnapshot } from "../src/assembly/fuel.ts";
import type { AssemblyConfig } from "../src/assembly/types.ts";

const id = (value: string) => normalizeSuiObjectId(`0x${value}`);
const config: AssemblyConfig = {
  network: "localnet", rpcUrl: "http://127.0.0.1:9000", packageId: id("a"),
  objectRegistryId: id("b"), energyConfigId: id("c"), fuelConfigId: id("d"),
};
const snapshot = (overrides: Partial<NetworkNodeFuelSnapshot> = {}): NetworkNodeFuelSnapshot => ({
  typeId: "88319", quantity: "499", isBurning: true, burnRateMs: "3000000", efficiency: "15",
  previousCycleElapsedMs: "0", burnStartTimeMs: "1000000", chainNowMs: "1100000", observedAtMs: 0,
  ...overrides,
});

function object(objectId: string, type: string, values: Record<string, unknown>): SuiObjectResponse {
  return { data: {
    objectId, type, version: "1", digest: "11111111111111111111111111111111",
    content: { dataType: "moveObject", type, hasPublicTransfer: false, fields: values },
  } } as SuiObjectResponse;
}

function readerFixture() {
  const objects = new Map<string, SuiObjectResponse>([
    [id("10"), object(id("10"), `${config.packageId}::network_node::NetworkNode`, { fuel: { fields: {
      type_id: { vec: ["88319"] }, quantity: "499", is_burning: true, burn_rate_in_ms: "3000000",
      previous_cycle_elapsed_time: "40000", burn_start_time: "1000000",
    } } })],
    [id("6"), object(id("6"), "0x2::clock::Clock", { timestamp_ms: "1100000" })],
    [id("d"), object(id("d"), `${config.packageId}::fuel::FuelConfig`, { fuel_efficiency: { fields: { id: { id: id("e") } } } })],
  ]);
  let efficiency: SuiObjectResponse = object(id("f"), "0x2::dynamic_field::Field<u64, u64>", { name: "88319", value: "15" });
  const calls: unknown[] = [];
  const reader: FuelReader = {
    async getObject(input) {
      calls.push(input);
      const found = objects.get(input.id);
      assert.ok(found, `Unexpected object ${input.id}`);
      return found;
    },
    async getDynamicFieldObject(input) {
      calls.push(input);
      assert.deepEqual(input, { parentId: id("e"), name: { type: "u64", value: "88319" } });
      return efficiency;
    },
  };
  return { objects, reader, calls, setEfficiency(value: SuiObjectResponse) { efficiency = value; } };
}

test("D2 countdown describes the current unit, independent of the tank reserve", () => {
  const reading = projectFuel(snapshot(), 1000);
  assert.equal(reading.typeName, "D2 Fuel");
  assert.equal(reading.unitDurationMs, 450000);
  assert.equal(reading.remainingUnitMs, 349000);
  assert.equal(reading.state, "burning");
  assert.equal(projectFuel(snapshot({ quantity: "1" }), 1000).remainingUnitMs, 349000);
});

test("the final active unit remains visible with zero reserve, then expires at the boundary", () => {
  const fuel = snapshot({ quantity: "0", chainNowMs: "1449999" });
  assert.equal(projectFuel(fuel).remainingUnitMs, 1);
  assert.equal(projectFuel(fuel).state, "burning");
  assert.deepEqual(projectFuel(fuel, 1), {
    typeId: null, typeName: "No fuel", state: "empty", remainingUnitMs: 0, unitDurationMs: 450000,
  });
});

test("crossing a unit boundary resets the timer only while reserve can supply another unit", () => {
  const fuel = snapshot({ quantity: "1", chainNowMs: "1450000" });
  assert.equal(projectFuel(fuel).remainingUnitMs, 450000);
  assert.equal(projectFuel(fuel).state, "burning");
  assert.equal(projectFuel(fuel, 449999).remainingUnitMs, 1);
  assert.equal(projectFuel(fuel, 450000).state, "empty");
});

test("saved partial burn time contributes to the cycle and stays fixed while paused", () => {
  assert.equal(projectFuel(snapshot({ previousCycleElapsedMs: "70000" })).remainingUnitMs, 280000);
  const paused = snapshot({ isBurning: false, burnStartTimeMs: "0", quantity: "0", previousCycleElapsedMs: "70000" });
  assert.equal(projectFuel(paused, 5000000).state, "paused");
  assert.equal(projectFuel(paused, 5000000).remainingUnitMs, 380000);
  assert.equal(projectFuel(snapshot({ isBurning: false, burnStartTimeMs: "0" })).remainingUnitMs, 450000);
});

test("a confirmed fuel update preserves the projected time at the current unit", () => {
  const before = snapshot({ chainNowMs: "1680000", previousCycleElapsedMs: "20000" });
  // fuel::consume_fuel_units removes one reserve and moves start back by the remainder.
  const after = snapshot({ quantity: "498", chainNowMs: "1680000", burnStartTimeMs: "1430000" });
  assert.deepEqual(projectFuel(before), projectFuel(after));
});

test("missing efficiency does not fabricate a burn time or discard a known fuel name", () => {
  const reading = projectFuel(snapshot({ efficiency: null }));
  assert.equal(reading.typeName, "D2 Fuel");
  assert.equal(reading.state, "unavailable");
  assert.equal(reading.remainingUnitMs, null);
  assert.equal(projectFuel(snapshot({ efficiency: "0" })).state, "unavailable");
  assert.equal(projectFuel(snapshot({ burnRateMs: "18446744073709551615", efficiency: "100" })).remainingUnitMs, null);
});

test("chain time and full u64 arithmetic avoid workstation skew and rounded quantities", () => {
  const fuel = snapshot({ quantity: "18446744073709551615", burnStartTimeMs: "18446744073709000000", chainNowMs: "18446744073709100000" });
  assert.equal(projectFuel(fuel, 1000).remainingUnitMs, 349000);
  assert.equal(projectFuel(snapshot({ chainNowMs: "999999" }), -1000).remainingUnitMs, 450000);
});

test("empty reserves and fuel names are explicit", () => {
  assert.equal(projectFuel(snapshot({ typeId: null, quantity: "0", isBurning: false, burnStartTimeMs: "0", efficiency: null })).state, "empty");
  assert.equal(fuelTypeName("77818"), "Unstable Fuel");
  assert.equal(fuelTypeName("88335"), "D1 Fuel");
  assert.equal(fuelTypeName("18446744073709551615"), "Fuel type 18446744073709551615");
});

test("public reader loads node fuel, the configured efficiency, and chain clock", async () => {
  const { reader, calls } = readerFixture();
  const before = Date.now();
  const result = await loadNetworkNodeFuel(config, id("10"), reader);
  assert.equal(result.typeId, "88319");
  assert.equal(result.efficiency, "15");
  assert.equal(result.chainNowMs, "1100000");
  assert.ok(result.observedAtMs >= before && result.observedAtMs <= Date.now());
  assert.equal(projectFuel(result).remainingUnitMs, 310000);
  assert.equal(calls.length, 4);
});

test("a missing chain efficiency entry keeps the type visible with an unavailable timer", async () => {
  const fixture = readerFixture();
  for (const code of ["dynamicFieldNotFound", "notExists"]) {
    fixture.setEfficiency({ error: { code, parent_object_id: id("e"), object_id: id("f") } } as SuiObjectResponse);
    const result = await loadNetworkNodeFuel(config, id("10"), fixture.reader);
    assert.equal(result.efficiency, null);
    assert.equal(projectFuel(result).typeName, "D2 Fuel");
  }
});

test("reader accepts flattened and wrapped RPC options and table IDs", async () => {
  for (const typeId of ["88319", 88319, ["88319"], { vec: ["88319"] }, { fields: { vec: ["88319"] } }]) {
    const fixture = readerFixture();
    fixture.objects.set(id("10"), object(id("10"), `${config.packageId}::network_node::NetworkNode`, { fuel: {
      type_id: typeId, quantity: "499", is_burning: true, burn_rate_in_ms: "3000000",
      previous_cycle_elapsed_time: "0", burn_start_time: "1000000",
    } }));
    fixture.objects.set(id("d"), object(id("d"), `${config.packageId}::fuel::FuelConfig`, { fuel_efficiency: { id: id("e") } }));
    assert.equal((await loadNetworkNodeFuel(config, id("10"), fixture.reader)).typeId, "88319");
  }
  for (const typeId of [null, [], { vec: [] }, { fields: { vec: [] } }]) {
    const fixture = readerFixture();
    fixture.objects.set(id("10"), object(id("10"), `${config.packageId}::network_node::NetworkNode`, { fuel: {
      type_id: typeId, quantity: "0", is_burning: false, burn_rate_in_ms: "3000000",
      previous_cycle_elapsed_time: "0", burn_start_time: "0",
    } }));
    assert.equal(projectFuel(await loadNetworkNodeFuel(config, id("10"), fixture.reader)).state, "empty");
    assert.equal(fixture.calls.length, 2);
  }
});

test("reader rejects wrong nodes, world configuration, fuel type entries, and malformed integers", async () => {
  const fixture = readerFixture();
  const node = fixture.objects.get(id("10"))!;
  fixture.objects.set(id("10"), { ...node, data: { ...node.data!, objectId: id("11") } });
  await assert.rejects(loadNetworkNodeFuel(config, id("10"), fixture.reader), /does not match/);
  fixture.objects.set(id("10"), node);
  const originalConfig = fixture.objects.get(id("d"))!;
  fixture.objects.set(id("d"), object(id("d"), `${id("aa")}::fuel::FuelConfig`, {}));
  await assert.rejects(loadNetworkNodeFuel(config, id("10"), fixture.reader), /different world/);
  fixture.objects.set(id("d"), originalConfig);
  fixture.setEfficiency(object(id("f"), "0x2::dynamic_field::Field<u64,u64>", { name: "88335", value: "15" }));
  await assert.rejects(loadNetworkNodeFuel(config, id("10"), fixture.reader), /does not match/);
  fixture.setEfficiency(object(id("f"), "0x2::dynamic_field::Field<u64,u64>", { name: "88319", value: Number.MAX_SAFE_INTEGER + 1 }));
  await assert.rejects(loadNetworkNodeFuel(config, id("10"), fixture.reader), /64-bit/);
});
