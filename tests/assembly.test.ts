import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { deriveObjectID, normalizeSuiObjectId } from "@mysten/sui/utils";
import {
  ASSEMBLY_TYPES,
  assemblyKind,
  buildAssemblyTransaction,
  configFromEnv,
  loadAssembly,
  resolveAssemblyId,
} from "../src/assembly/index.ts";
import type {
  AssemblyConfig,
  AssemblyKind,
  AssemblyReader,
  AssemblySnapshot,
} from "../src/assembly/index.ts";
import type { SuiObjectResponse } from "@mysten/sui/jsonRpc";

const id = (hex: string) => normalizeSuiObjectId(`0x${hex}`);
const config: AssemblyConfig = {
  network: "localnet",
  rpcUrl: "http://127.0.0.1:9000",
  packageId: id("a"),
  objectRegistryId: id("b"),
  energyConfigId: id("c"),
  fuelConfigId: id("d"),
  defaultTenant: "dev",
};
const owner = id("99");
const digest = "11111111111111111111111111111111";
const snapshot = (kind: AssemblyKind = "assembly"): AssemblySnapshot => ({
  id: id("10"),
  kind,
  name: "Test assembly",
  state: "offline",
  ownerAddress: owner,
  ownerCapId: id("20"),
  ownerCapRef: { objectId: id("20"), version: "3", digest },
  characterId: id("30"),
  networkNodeId: kind === "network_node" ? undefined : id("40"),
  networkNodeState: "online",
  connectedAssemblies: [],
  observedAt: "2026-09-13T00:00:00.000Z",
});

test("in-game item IDs keep all u64 bits and use tenant in derived object key", () => {
  const itemId = "18446744073709551615";
  const params = new URLSearchParams({ itemId, tenant: "test-tenant" });
  const key = bcs
    .struct("TenantItemId", { id: bcs.u64(), tenant: bcs.string() })
    .serialize({ id: itemId, tenant: "test-tenant" })
    .toBytes();
  assert.equal(
    resolveAssemblyId(config, params),
    deriveObjectID(
      config.objectRegistryId,
      `${config.packageId}::in_game_id::TenantItemId`,
      key,
    ),
  );
  assert.throws(
    () =>
      resolveAssemblyId(
        config,
        new URLSearchParams({ itemId: "18446744073709551616" }),
      ),
    /64-bit/,
  );
  assert.throws(
    () => resolveAssemblyId(config, new URLSearchParams({ itemId: "1.5" })),
    /64-bit/,
  );
  assert.equal(
    resolveAssemblyId(config, new URLSearchParams({ objectId: "0x4", itemId })),
    id("4"),
  );
});

test("empty deployment config remains renderable but cannot derive an item", () => {
  const empty = configFromEnv({});
  assert.equal(empty.packageId, "");
  assert.equal(empty.rpcUrl, "http://127.0.0.1:9000");
  assert.throws(
    () => resolveAssemblyId(empty, new URLSearchParams({ itemId: "1" })),
    /Object Registry/,
  );
});

for (const kind of ["assembly", "storage_unit", "gate", "turret"] as const) {
  for (const action of ["online", "offline"] as const) {
    test(`${kind} ${action} borrows the correctly typed cap, executes, and returns the receipt`, () => {
      const assembly = {
        ...snapshot(kind),
        state: action === "online" ? ("offline" as const) : ("online" as const),
      };
      const data = buildAssemblyTransaction(
        config,
        assembly,
        action,
        owner,
      ).getData();
      const calls = data.commands.map((command) => command.MoveCall!);
      assert.deepEqual(
        calls.map((call) => `${call.module}::${call.function}`),
        [
          "character::borrow_owner_cap",
          `${kind}::${action}`,
          "character::return_owner_cap",
        ],
      );
      assert.deepEqual(calls[0].typeArguments, [
        `${config.packageId}::${ASSEMBLY_TYPES[kind]}`,
      ]);
      assert.deepEqual(calls[2].typeArguments, calls[0].typeArguments);
      assert.equal(data.sender, owner);
      assert.ok(
        data.inputs.some(
          (input) => input.Object?.Receiving?.objectId === assembly.ownerCapId,
        ),
      );
      assert.deepEqual(calls[1].arguments[3], {
        NestedResult: [0, 0],
        $kind: "NestedResult",
      });
      assert.deepEqual(calls[2].arguments[2], {
        NestedResult: [0, 1],
        $kind: "NestedResult",
      });
    });
  }
}

test("network node online uses its dedicated signature", () => {
  const calls = buildAssemblyTransaction(
    config,
    snapshot("network_node"),
    "online",
    owner,
  )
    .getData()
    .commands.map((command) => command.MoveCall!);
  assert.equal(calls[1].module, "network_node");
  assert.equal(calls[1].function, "online");
  assert.equal(calls[1].arguments.length, 3);
});

test("empty network shutdown still consumes OfflineAssemblies", () => {
  const node = { ...snapshot("network_node"), state: "online" as const };
  const calls = buildAssemblyTransaction(
    { ...config, energyConfigId: "" },
    node,
    "offline",
    owner,
  )
    .getData()
    .commands.map((command) => command.MoveCall!);
  assert.deepEqual(
    calls.map((call) => call.function),
    [
      "borrow_owner_cap",
      "offline",
      "destroy_offline_assemblies",
      "return_owner_cap",
    ],
  );
  assert.equal(calls[1].arguments.length, 4);
  assert.deepEqual(calls[2].arguments[0], {
    NestedResult: [1, 0],
    $kind: "NestedResult",
  });
});

test("network shutdown processes every connected type and threads the hot potato", () => {
  const node = { ...snapshot("network_node"), state: "online" as const };
  node.connectedAssemblies = (
    ["assembly", "storage_unit", "gate", "turret"] as const
  ).map((kind, index) => ({
    id: id(`${index + 50}`),
    kind,
    name: kind,
    state: "online",
    networkNodeId: node.id,
  }));
  const calls = buildAssemblyTransaction(config, node, "offline", owner)
    .getData()
    .commands.map((command) => command.MoveCall!);
  assert.deepEqual(
    calls.slice(2, 6).map((call) => `${call.module}::${call.function}`),
    [
      "assembly::offline_connected_assembly",
      "storage_unit::offline_connected_storage_unit",
      "gate::offline_connected_gate",
      "turret::offline_connected_turret",
    ],
  );
  for (let index = 2; index < 6; index++)
    assert.deepEqual(calls[index].arguments[1], {
      NestedResult: [index - 1, 0],
      $kind: "NestedResult",
    });
  assert.equal(calls[6].function, "destroy_offline_assemblies");
  assert.deepEqual(calls[6].arguments[0], {
    NestedResult: [5, 0],
    $kind: "NestedResult",
  });
});

test("ownership, operational state, node state and required IDs gate transaction construction", () => {
  assert.throws(
    () => buildAssemblyTransaction(config, snapshot(), "online", id("88")),
    /wallet that owns/,
  );
  assert.throws(
    () => buildAssemblyTransaction(config, snapshot(), "offline", owner),
    /already offline/,
  );
  assert.throws(
    () =>
      buildAssemblyTransaction(
        config,
        { ...snapshot(), state: "unknown" },
        "online",
        owner,
      ),
    /unknown state/,
  );
  assert.throws(
    () =>
      buildAssemblyTransaction(
        config,
        { ...snapshot(), networkNodeState: "offline" },
        "online",
        owner,
      ),
    /network node online/,
  );
  assert.throws(
    () =>
      buildAssemblyTransaction(
        { ...config, energyConfigId: "" },
        snapshot(),
        "online",
        owner,
      ),
    /Energy Config/,
  );
  assert.throws(
    () =>
      buildAssemblyTransaction(
        config,
        { ...snapshot(), networkNodeId: undefined },
        "online",
        owner,
      ),
    /network node ID/,
  );
  assert.throws(
    () => assemblyKind(`${config.packageId}::ship::Ship`, config),
    /Unsupported/,
  );
  assert.throws(
    () => assemblyKind(`${id("ff")}::assembly::Assembly`, config),
    /World package mismatch/,
  );
});

function moveResponse(
  objectId: string,
  type: string,
  values: Record<string, unknown>,
  responseOwner: unknown = { Shared: { initial_shared_version: "1" } },
): SuiObjectResponse {
  return {
    data: {
      objectId,
      digest,
      version: "3",
      type,
      owner: responseOwner,
      content: {
        dataType: "moveObject",
        type,
        hasPublicTransfer: false,
        fields: values,
      },
    },
  } as SuiObjectResponse;
}

function readerFixture(
  kind: AssemblyKind = "assembly",
  values: Record<string, unknown> = {},
) {
  const type = `${config.packageId}::${ASSEMBLY_TYPES[kind]}`;
  const objects = new Map([
    [
      id("10"),
      moveResponse(id("10"), type, {
        owner_cap_id: id("20"),
        key: { fields: { item_id: "18446744073709551615", tenant: "dev" } },
        status: { fields: { status: { variant: "OFFLINE", fields: {} } } },
        metadata: { fields: { name: "North relay" } },
        energy_source_id: id("40"),
        connected_assembly_ids: [],
        ...values,
      }),
    ],
    [
      id("20"),
      moveResponse(
        id("20"),
        `${config.packageId}::access::OwnerCap<${type}>`,
        { authorized_object_id: id("10") },
        { AddressOwner: id("30") },
      ),
    ],
    [
      id("30"),
      moveResponse(id("30"), `${config.packageId}::character::Character`, {
        character_address: owner,
        metadata: { fields: { vec: [{ fields: { name: "Test pilot" } }] } },
      }),
    ],
    [
      id("40"),
      moveResponse(id("40"), `${config.packageId}::network_node::NetworkNode`, {
        status: { fields: { status: { variant: "ONLINE", fields: {} } } },
      }),
    ],
  ]);
  const reader: AssemblyReader = {
    getObject: async ({ id: objectId }) =>
      objects.get(objectId) || {
        error: { code: "notExists", object_id: objectId },
      },
    multiGetObjects: async ({ ids }) =>
      ids.map((objectId) => objects.get(objectId)!),
  };
  return { reader, objects };
}

test("RPC loader handles live-world item_id, enum, flattened Option and AddressOwner through Character", async () => {
  const { reader } = readerFixture();
  const assembly = await loadAssembly(config, id("10"), reader);
  assert.equal(assembly.ownerAddress, owner);
  assert.equal(assembly.ownerName, "Test pilot");
  assert.equal(assembly.characterId, id("30"));
  assert.equal(assembly.name, "North relay");
  assert.equal(assembly.itemId, "18446744073709551615");
  assert.equal(assembly.state, "offline");
  assert.equal(assembly.networkNodeState, "online");
  assert.equal(assembly.networkNodeId, id("40"));
  assert.deepEqual(assembly.ownerCapRef, {
    objectId: id("20"),
    version: "3",
    digest,
  });
});

test("RPC loader exposes metadata from flattened and wrapped Move Options", async () => {
  const metadata = {
    fields: {
      name: "North relay",
      description: "Public access storage near the north gate.",
      url: "http://127.0.0.1:5174",
    },
  };
  for (const value of [metadata, { fields: { vec: [metadata] } }]) {
    const { reader } = readerFixture("storage_unit", { metadata: value });
    const assembly = await loadAssembly(config, id("10"), reader);
    assert.equal(assembly.description, metadata.fields.description);
    assert.equal(assembly.url, metadata.fields.url);
  }
  for (const value of [undefined, null, { fields: { vec: [] } }]) {
    const { reader } = readerFixture("assembly", { metadata: value });
    const assembly = await loadAssembly(config, id("10"), reader);
    assert.equal(assembly.description, undefined);
    assert.equal(assembly.url, undefined);
  }
});

test("RPC loader reads configured TypeName Options for storage units, gates and turrets", async () => {
  const typeName = `${id("aa")}::access_rules::Auth`;
  const extension = { fields: { name: typeName } };
  for (const kind of ["storage_unit", "gate", "turret"] as const) {
    for (const value of [extension, { fields: { vec: [extension] } }]) {
      const { reader } = readerFixture(kind, { extension: value });
      const assembly = await loadAssembly(config, id("10"), reader);
      assert.deepEqual(assembly.extensionTypes, [typeName]);
    }
    for (const value of [null, { fields: { vec: [] } }]) {
      const { reader } = readerFixture(kind, { extension: value });
      const assembly = await loadAssembly(config, id("10"), reader);
      assert.deepEqual(assembly.extensionTypes, []);
    }
  }
});

test("RPC loader supports legacy storage unit extension VecSets", async () => {
  const types = [`${id("aa")}::access_rules::Auth`, `${id("bb")}::trade::Auth`];
  for (const expected of [types, []]) {
    const { reader } = readerFixture("storage_unit", {
      allowed_extensions: {
        fields: { contents: expected.map((name) => ({ fields: { name } })) },
      },
    });
    const assembly = await loadAssembly(config, id("10"), reader);
    assert.deepEqual(assembly.extensionTypes, expected);
  }
});

test("RPC loader distinguishes unavailable extension data from confirmed default behaviour", async () => {
  const cases: [AssemblyKind, Record<string, unknown>][] = [
    ["storage_unit", {}],
    ["gate", {}],
    ["turret", {}],
    ["storage_unit", { allowed_extensions: { fields: {} } }],
    ["storage_unit", { allowed_extensions: { fields: { contents: [{}] } } }],
    ["gate", { extension: { fields: { name: 123 } } }],
    ["turret", { extension: { fields: { vec: [{}, {}] } } }],
    ["assembly", {}],
    ["network_node", {}],
  ];
  for (const [kind, values] of cases) {
    const { reader } = readerFixture(kind, values);
    const assembly = await loadAssembly(config, id("10"), reader);
    assert.equal(assembly.extensionTypes, undefined);
  }
});

test("RPC loader refuses a capability authorizing a different assembly", async () => {
  const { reader, objects } = readerFixture();
  objects.set(
    id("20"),
    moveResponse(
      id("20"),
      `${config.packageId}::access::OwnerCap<${config.packageId}::assembly::Assembly>`,
      { authorized_object_id: id("77") },
      { AddressOwner: id("30") },
    ),
  );
  await assert.rejects(
    loadAssembly(config, id("10"), reader),
    /does not authorize/,
  );
});

test("RPC loader refuses unknown connected types instead of guessing Assembly", async () => {
  const { reader, objects } = readerFixture("network_node");
  objects.set(
    id("10"),
    moveResponse(id("10"), `${config.packageId}::network_node::NetworkNode`, {
      owner_cap_id: id("20"),
      status: "ONLINE",
      connected_assembly_ids: [id("66")],
    }),
  );
  objects.set(
    id("66"),
    moveResponse(id("66"), `${config.packageId}::ship::Ship`, {}),
  );
  await assert.rejects(
    loadAssembly(config, id("10"), reader),
    /Unsupported assembly type/,
  );
});
