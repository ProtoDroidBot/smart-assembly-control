import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { deriveObjectID, toBase64 } from "@mysten/sui/utils";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  ASSEMBLY_ACTION_FLAG,
  buildRemoteScanActionTransaction,
  REMOTE_SCAN_ACTION_TYPE,
  REMOTE_SCAN_ALERT_ACTION_TYPE,
  loadRemoteScanAlerts,
  loadRemoteScanQueueActions,
} from "../src/actions/chain.ts";
import type { AssemblyConfig, AssemblySnapshot } from "../src/assembly/types.ts";

const id = (value: string) => `0x${value.padStart(64, "0")}`;
const owner = id("99");
const config: AssemblyConfig = {
  network: "localnet",
  rpcUrl: "http://127.0.0.1:9000",
  chainId: "test-chain",
  packageId: id("a"),
  worldTypeOrigin: id("aa"),
  objectRegistryId: id("b"),
  energyConfigId: id("c"),
  fuelConfigId: id("d"),
  features: {
    assemblyAccess: { packageId: id("51"), typeOrigin: id("52"), registryId: id("53") },
    actionQueue: { packageId: id("61"), typeOrigin: id("62"), registryId: id("63") },
  },
};
const node: AssemblySnapshot = {
  id: id("10"),
  itemId: "100",
  tenant: "dev",
  kind: "network_node",
  name: "Scanner",
  description: "",
  url: "",
  extensionTypes: [],
  state: "online",
  ownerCapId: id("20"),
  ownerCapRef: {
    objectId: id("20"),
    version: "3",
    digest: "11111111111111111111111111111111",
  },
  characterId: id("30"),
  ownerAddress: owner,
  ownerName: "Queue owner",
  networkNodeId: id("10"),
  networkNodeState: "online",
  connectedAssemblies: [],
  observedAt: "2026-09-21T12:00:00.000Z",
};

test("remote scanning creates one deterministic owner-authorized Sui action", async () => {
  const actionID = "d7949ad2-56c0-4a98-a970-83b293a4df93";
  const action = await buildRemoteScanActionTransaction(config, node, owner, {
    targetSystemID: 30000005,
    mode: "deep",
    rangeJumps: 2,
    layers: ["sites", "resources", "celestials", "entities"],
  }, { actionID, now: 1_000 });

  assert.equal(action.actionID, actionID);
  assert.equal(action.actionType, REMOTE_SCAN_ACTION_TYPE);
  assert.equal(action.expiresAtMs, 86_401_000);
  assert.equal(action.payload.operationKey, `sui-action/${actionID}`);
  assert.match(action.actionObjectID, /^0x[0-9a-f]{64}$/);
  const calls = action.transaction.getData().commands.filter(command => command.$kind === "MoveCall");
  assert.deepEqual(calls.map(command => command.MoveCall.function), [
    "borrow_owner_cap",
    "queue_action",
    "return_owner_cap",
  ]);
  assert.equal(
    ASSEMBLY_ACTION_FLAG.PLAYER_INITIATED | ASSEMBLY_ACTION_FLAG.INTELLIGENCE,
    258,
  );
});

async function actionFixture(legacy = false) {
  const settings = legacy ? { ...config, features: { ...config.features, actionQueue: config.features!.assemblyAccess } } : config;
  const feature = settings.features!.actionQueue!;
  const queueId = legacy ? feature.registryId : deriveObjectID(feature.registryId,
    `${feature.typeOrigin}::action_queue::AssemblyQueueKey`, bcs.Address.serialize(node.id).toBytes());
  const action = await buildRemoteScanActionTransaction(settings, node, owner, {
    targetSystemID: 30000005, mode: "survey", rangeJumps: 1, layers: ["sites"],
  }, { actionID: "d7949ad2-56c0-4a98-a970-83b293a4df93", now: 1000 });
  const payloadBytes = new TextEncoder().encode(JSON.stringify(action.payload));
  const values: Record<string, unknown> = {
    registry_id: feature.registryId, queue_id: queueId,
    action_id: [...Buffer.from(action.actionID.replaceAll("-", ""), "hex")],
    source_assembly_id: node.id, target_assembly_id: node.id,
    action_type: [...new TextEncoder().encode(REMOTE_SCAN_ACTION_TYPE)],
    payload: [...payloadBytes],
    payload_commitment: [...new Uint8Array(await crypto.subtle.digest("SHA-256", payloadBytes))],
    created_at_ms: "1000", expires_at_ms: "86401000", status: 0, priority: "100", priority_flags: "258", server_action: false,
  };
  const object = { objectId: action.actionObjectID,
    type: `${feature.typeOrigin}::${legacy ? "assembly_access::AssemblyAction" : "action_queue::Action"}`, json: values };
  const calls: unknown[] = [];
  const claim = { $kind: "DynamicField", fieldId: id("71"),
    name: { type: "0x2::derived_object::Claimed", bcs: bcs.Address.serialize(action.actionObjectID).toBytes() },
    type: "0x2::dynamic_field::Field<0x2::derived_object::Claimed,0x2::derived_object::ClaimedStatus>", valueType: "0x2::derived_object::ClaimedStatus" };
  const reader = {
    async listDynamicFields(input: { parentId: string; cursor: string | null }) {
      calls.push(input);
      if (!legacy && input.parentId === feature.registryId) return {
        dynamicFields: [{ ...claim, name: { ...claim.name, bcs: bcs.Address.serialize(queueId).toBytes() } }],
        hasNextPage: false, cursor: null,
      };
      assert.equal(input.parentId, queueId);
      // The useful claim is deliberately beyond the first page.
      return input.cursor === null
        ? { dynamicFields: [], hasNextPage: true, cursor: "second-page" }
        : { dynamicFields: [claim], hasNextPage: false, cursor: null };
    },
    async getObjects(input: { objectIds: string[]; include: unknown }) {
      calls.push(input);
      if (input.objectIds[0] === queueId) return { objects: [{ objectId: queueId,
        type: `${feature.typeOrigin}::action_queue::AssemblyActionQueue`,
        json: { registry_id: feature.registryId, assembly_id: node.id } }] };
      assert.deepEqual(input, { objectIds: [action.actionObjectID], include: { json: true } });
      return { objects: [object] };
    },
  } as unknown as Pick<SuiGrpcClient, "getObjects" | "listDynamicFields">;
  return { settings, action, values, object, calls, claim, reader };
}

test("gRPC recovers shared actions through paginated BCS claims for current and legacy queues", async () => {
  for (const legacy of [false, true]) {
    const fixture = await actionFixture(legacy);
    const result = await loadRemoteScanQueueActions(fixture.settings, node, fixture.reader);
    assert.equal(result.length, 1);
    assert.equal(result[0].actionObjectID, fixture.action.actionObjectID);
    assert.deepEqual(result[0].payload, fixture.action.payload);
    assert.equal(fixture.calls.length, 3);
  }
});

test("gRPC action recovery checks payload commitments, registry, queue and target bindings", async () => {
  for (const [key, value] of [["payload_commitment", [0]], ["registry_id", id("ff")], ["queue_id", id("ff")], ["target_assembly_id", id("ff")], ["payload", [300]]] as const) {
    const fixture = await actionFixture();
    fixture.values[key] = value;
    assert.deepEqual(await loadRemoteScanQueueActions(config, node, fixture.reader), []);
  }
});

test("gRPC action recovery accepts base64 Move byte vectors and filters server alerts", async () => {
  const fixture = await actionFixture();
  const payload = { version: 1, event: "remote_scan.detected", scanID: "scan", detectedAtMs: 1234,
    sourceSystemID: 1, targetSystemID: 2, neighboringSystemID: 3, mode: "survey", layers: ["sites"] };
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  fixture.values.server_action = true;
  const recipient = { ...node, id: id("ff") };
  fixture.values.target_assembly_id = recipient.id;
  fixture.values.action_id = toBase64(Uint8Array.from(fixture.values.action_id as number[]));
  fixture.values.action_type = toBase64(new TextEncoder().encode(REMOTE_SCAN_ALERT_ACTION_TYPE));
  fixture.values.payload = toBase64(raw);
  fixture.values.payload_commitment = toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
  const alerts = await loadRemoteScanAlerts(config, recipient, fixture.reader);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].payload, payload);
  assert.equal(alerts[0].sourceAssemblyObjectID, node.id);
  assert.equal(alerts[0].targetAssemblyObjectID, recipient.id);
  assert.deepEqual(await loadRemoteScanQueueActions(config, node, fixture.reader), []);
});

test("gRPC action recovery rejects truncated BCS claims and nonadvancing pagination", async () => {
  const fixture = await actionFixture();
  fixture.claim.name.bcs = new Uint8Array(31);
  await assert.rejects(loadRemoteScanQueueActions(config, node, fixture.reader), /invalid claimed object ID/);
  fixture.reader.listDynamicFields = async () => ({ dynamicFields: [], hasNextPage: true, cursor: "same" });
  await assert.rejects(loadRemoteScanQueueActions(config, node, fixture.reader), /pagination cursor/);
  fixture.reader.listDynamicFields = async () => { throw new Error("gRPC unavailable"); };
  await assert.rejects(loadRemoteScanQueueActions(config, node, fixture.reader), /gRPC unavailable/);
});

test("remote scan action construction rejects a non-node or another wallet", async () => {
  await assert.rejects(
    buildRemoteScanActionTransaction(config, { ...node, kind: "assembly" }, owner, {
      targetSystemID: 30000005,
      mode: "survey",
      rangeJumps: 1,
      layers: ["sites"],
    }),
    /Network Node/,
  );
  await assert.rejects(
    buildRemoteScanActionTransaction(config, node, id("98"), {
      targetSystemID: 30000005,
      mode: "survey",
      rangeJumps: 1,
      layers: ["sites"],
    }),
    /owns this Network Node/,
  );
});
