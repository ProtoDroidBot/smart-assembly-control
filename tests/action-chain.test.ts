import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSEMBLY_ACTION_FLAG,
  buildRemoteScanActionTransaction,
  REMOTE_SCAN_ACTION_TYPE,
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
