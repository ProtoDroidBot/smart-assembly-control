import assert from "node:assert/strict";
import test from "node:test";
import type { AssemblyConfig, AssemblySnapshot } from "../src/assembly/types.ts";
import { createTaskQueue } from "../src/tasks/queue.ts";
import {
  MAX_IMPORTED_QUEUE_BYTES,
  parseTaskQueue,
  serializeTaskQueue,
} from "../src/tasks/portable.ts";
import type { TaskDraft, TaskOperation } from "../src/tasks/types.ts";

const id = (value: string) => `0x${value.padStart(64, "0")}`;
const walletAddress = id("99");
const config: AssemblyConfig = {
  network: "localnet",
  rpcUrl: "http://127.0.0.1:9000",
  chainId: "0609212e",
  packageId: id("a"),
  worldTypeOrigin: id("aa"),
  objectRegistryId: id("b"),
  energyConfigId: id("c"),
  fuelConfigId: id("d"),
  features: {
    npc: { packageId: id("11"), typeOrigin: id("12"), registryId: id("13") },
    catapult: { packageId: id("21"), typeOrigin: id("22"), registryId: id("23") },
    smartIndustry: { packageId: id("31"), typeOrigin: id("32"), registryId: id("33") },
    transponder: { packageId: id("41"), typeOrigin: id("42"), registryId: id("43") },
    assemblyAccess: { packageId: id("51"), typeOrigin: id("52"), registryId: id("53") },
    actionQueue: { packageId: id("61"), typeOrigin: id("62"), registryId: id("63") },
    industryActions: { packageId: id("71"), typeOrigin: id("72"), registryId: id("73") },
    logisticsActions: { packageId: id("81"), typeOrigin: id("82"), registryId: id("83") },
    infrastructureActions: { packageId: id("91"), typeOrigin: id("92"), registryId: id("93") },
    automation: { packageId: id("a1"), typeOrigin: id("a2"), registryId: id("a3") },
  },
};
const assembly: AssemblySnapshot = {
  id: id("10"),
  itemId: "100",
  tenant: "dev",
  kind: "assembly",
  name: "Portable assembly",
  description: "A queue export fixture",
  url: "https://example.invalid/assembly",
  extensionTypes: ["fixture::Extension"],
  state: "online",
  ownerCapId: id("20"),
  ownerCapRef: {
    objectId: id("20"),
    version: "3",
    digest: "11111111111111111111111111111111",
  },
  characterId: id("30"),
  ownerAddress: walletAddress,
  ownerName: "Queue owner",
  networkNodeId: id("40"),
  networkNodeState: "online",
  connectedAssemblies: [],
  observedAt: "2026-09-14T12:00:00.000Z",
};
const expected = {
  expectedBlueprintID: "22",
  expectedBlueprintHash: "a".repeat(64),
  expectedJobID: null,
};

const operations: TaskOperation[] = [
  { kind: "assembly-state", action: "offline", snapshot: assembly },
  { kind: "storage-transfer", direction: "deposit", selected: 34, quantity: "5" },
  { kind: "industry-start", request: { blueprintID: "22", blueprintHash: "a".repeat(64), runs: "2", expectedJobID: null } },
  { kind: "industry-transfer", request: {
    requestID: "a7949ad2-56c0-4a98-a970-83b293a4df93", storageUnitID: "300",
    direction: "deposit", side: "inputs", typeID: "34", quantity: "5",
  } },
  { kind: "industry-blueprint", request: {
    requestID: "b7949ad2-56c0-4a98-a970-83b293a4df93", ...expected,
    blueprintID: "23", blueprintHash: "b".repeat(64),
  }, blueprint: {
    blueprintID: "23", blueprintHash: "b".repeat(64), name: "New recipe", runTime: "60",
    inputs: [{ type_id: "34", quantity: "2", max_quantity: "100" }],
    outputs: [{ type_id: "35", quantity: "1", max_quantity: "100" }],
  } },
  { kind: "industry-empty", request: {
    requestID: "c7949ad2-56c0-4a98-a970-83b293a4df93", ...expected, storageUnitID: "300",
  } },
  { kind: "gate-link", targetID: 101 },
  { kind: "gate-unlink", targetID: 101 },
  { kind: "energy-connect", targetID: 102 },
  { kind: "energy-disconnect", targetID: 102 },
  { kind: "remote-scan", actionID: "d7949ad2-56c0-4a98-a970-83b293a4df93",
    actionObjectID: id("77"), request: {
      operationKey: "sui-action/d7949ad2-56c0-4a98-a970-83b293a4df93",
      targetSystemID: 30000005, mode: "deep", rangeJumps: 2,
      layers: ["sites", "resources", "celestials", "entities"],
    } },
  { kind: "inventory-listener", request: { targetKind: "smart-assembly", targetID: 300,
    inventory: "outputs", requested: [{ typeID: 34, quantity: 5 }, { typeID: 35, quantity: 2 }] },
    retryAfterSeconds: 30, timeoutSeconds: 3600 },
  { kind: "queue-delay", seconds: 60 },
  { kind: "queue-timeout", seconds: 7200 },
  { kind: "queue-repeat" },
];

function draft(operation: TaskOperation, index: number): TaskDraft {
  const kind = operation.kind.startsWith("gate-") ? "gate" :
    (operation.kind.startsWith("energy-") || operation.kind === "remote-scan") ? "network_node" :
      operation.kind === "storage-transfer" ? "storage_unit" : assembly.kind;
  const snapshot = { ...assembly, kind };
  return {
    title: `Task ${index + 1}`,
    details: `Portable ${operation.kind} action`,
    assembly: snapshot,
    operation: operation.kind === "assembly-state"
      ? { ...operation, snapshot }
      : operation,
  };
}

test("queue files round-trip every supported action and omit runtime state", () => {
  const wallet = {};
  const queue = createTaskQueue();
  const drafts = operations.map(draft);
  assert.equal(queue.importTasks(drafts, wallet, walletAddress), drafts.length);
  const source = serializeTaskQueue(queue.getSnapshot().tasks, config, walletAddress);
  const decoded = JSON.parse(source) as Record<string, unknown>;

  assert.equal(decoded.format, "eve-frontier-task-queue");
  assert.equal(decoded.version, 2);
  assert.equal(source.includes("walletIdentity"), false);
  assert.equal(source.includes('"status"'), false);
  assert.equal(source.includes('"result"'), false);
  assert.deepEqual(parseTaskQueue(source, config, walletAddress), drafts);
});

test("exports include only pending actions and imports append atomically with a new wallet binding", async () => {
  const sourceWallet = {};
  const source = createTaskQueue();
  source.enqueue(draft(operations[0], 0), sourceWallet, walletAddress);
  source.enqueue(draft(operations[1], 1), sourceWallet, walletAddress);
  await source.run(async task => {
    if (task.id === 1) return { message: "Completed" };
    throw new Error("Keep a failed fixture out of exports");
  });
  source.remove(2);
  source.enqueue(draft(operations[2], 2), sourceWallet, walletAddress);

  const parsed = parseTaskQueue(serializeTaskQueue(source.getSnapshot().tasks, config, walletAddress), config, walletAddress);
  assert.deepEqual(parsed.map(item => item.operation.kind), ["industry-start"]);

  const target = createTaskQueue();
  const importedWallet = {};
  target.enqueue(draft(operations[3], 3), importedWallet, walletAddress);
  assert.equal(target.importTasks(parsed, importedWallet, walletAddress), 1);
  assert.deepEqual(target.getSnapshot().tasks.map(item => item.operation.kind), ["industry-transfer", "industry-start"]);
  assert.ok(target.getSnapshot().tasks.every(item => item.walletIdentity === importedWallet && item.status === "queued"));
});

test("imports reject other wallets, deployments, unsupported versions, oversized input, and malformed actions", () => {
  const queue = createTaskQueue();
  queue.enqueue(draft(operations[3], 0), {}, walletAddress);
  const valid = serializeTaskQueue(queue.getSnapshot().tasks, config, walletAddress);

  assert.throws(() => parseTaskQueue(valid, config, id("98")), /different wallet/);
  assert.throws(() => parseTaskQueue(valid, { ...config, packageId: id("ff") }, walletAddress), /different network or world deployment/);
  assert.throws(
    () =>
      parseTaskQueue(
        valid,
        {
          ...config,
          features: {
            ...config.features!,
            catapult: {
              ...config.features!.catapult,
              packageId: id("ff"),
            },
          },
        },
        walletAddress,
      ),
    /different network or world deployment/,
  );

  const unsupported = JSON.parse(valid);
  unsupported.version = 1;
  assert.throws(() => parseTaskQueue(JSON.stringify(unsupported), config, walletAddress), /version 1 is not supported/);

  assert.throws(() => parseTaskQueue("x".repeat(MAX_IMPORTED_QUEUE_BYTES + 1), config, walletAddress), /no larger/);
  assert.throws(() => parseTaskQueue("not json", config, walletAddress), /not valid JSON/);

  const malformed = JSON.parse(valid);
  malformed.tasks[0].operation.request.direction = "sideways";
  assert.throws(() => parseTaskQueue(JSON.stringify(malformed), config, walletAddress), /direction is not supported/);
});

test("failed validation never changes the destination queue", () => {
  const source = createTaskQueue();
  source.enqueue(draft(operations[0], 0), {}, walletAddress);
  const file = JSON.parse(serializeTaskQueue(source.getSnapshot().tasks, config, walletAddress));
  file.tasks.push({ ...file.tasks[0], operation: { kind: "unknown-action" } });

  const destination = createTaskQueue();
  destination.enqueue(draft(operations[1], 1), {}, walletAddress);
  assert.throws(() => {
    const parsed = parseTaskQueue(JSON.stringify(file), config, walletAddress);
    destination.importTasks(parsed, {}, walletAddress);
  }, /operation kind is not supported/);
  assert.equal(destination.getSnapshot().tasks.length, 1);
});

test("portable read-only and Storage queues allow access-scoped non-owner assemblies", () => {
  const visitor = id("98");
  const sharedAssembly = { ...assembly, kind: "storage_unit" as const, ownerAddress: id("97") };
  const queue = createTaskQueue();
  const listenerOperation = operations.find(operation => operation.kind === "inventory-listener")!;
  const listener = { ...draft(listenerOperation, 0), assembly: sharedAssembly };
  const transfer = { ...draft(operations[1], 1), assembly: sharedAssembly };
  queue.enqueue(listener, {}, visitor);
  queue.enqueue(transfer, {}, visitor);
  const source = serializeTaskQueue(queue.getSnapshot().tasks, config, visitor);
  assert.deepEqual(parseTaskQueue(source, config, visitor), [listener, transfer]);

  const ownerAction = createTaskQueue();
  ownerAction.enqueue({ ...draft(operations[0], 0), assembly: sharedAssembly }, {}, visitor);
  assert.throws(() => serializeTaskQueue(ownerAction.getSnapshot().tasks, config, visitor), /owner-scoped/);
});
