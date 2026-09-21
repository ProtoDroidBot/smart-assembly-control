import assert from "node:assert/strict";
import test from "node:test";
import { assemblyKind } from "../src/assembly/client.ts";
import { configFromEnv, resolveAssemblyId } from "../src/assembly/config.ts";
import { loadRuntimeConfig } from "../src/assembly/runtime-config.ts";

const baked = {
  VITE_SUI_NETWORK: "testnet",
  VITE_SUI_RPC_URL: "https://fullnode.testnet.sui.io",
  VITE_TENANT: "old",
  VITE_EVE_WORLD_PACKAGE_ID: "0xaa",
  VITE_OBJECT_REGISTRY_ID: "0xbb",
  VITE_ENERGY_CONFIG_ID: "0xcc",
  VITE_FUEL_CONFIG_ID: "0xdd",
  VITE_ITEM_ID: "18446744073709551615",
  VITE_OBJECT_ID: "0xab",
};
const deployed = {
  VITE_SUI_NETWORK: "localnet",
  VITE_SUI_RPC_URL: "http://127.0.0.1:9000",
  VITE_SUI_CHAIN_ID: "0609212e",
  VITE_TENANT: "dev",
  VITE_EVE_WORLD_PACKAGE_ID:
    "0x1d00e32095be319c16ce24de9f8a6a4cb905f45c74b71eb0138f7019b5a611a0",
  VITE_EVE_WORLD_TYPE_ORIGIN:
    "0x1d00e32095be319c16ce24de9f8a6a4cb905f45c74b71eb0138f7019b5a611a0",
  VITE_OBJECT_REGISTRY_ID: "0x2",
  VITE_ADMIN_ACL_ID: "0x5",
  VITE_ENERGY_CONFIG_ID: "0x3",
  VITE_FUEL_CONFIG_ID: "0x4",
  VITE_NPC_PACKAGE_ID: "0x11",
  VITE_NPC_TYPE_ORIGIN: "0x13",
  VITE_NPC_REGISTRY_ID: "0x12",
  VITE_CATAPULT_PACKAGE_ID: "0x21",
  VITE_CATAPULT_TYPE_ORIGIN: "0x23",
  VITE_CATAPULT_REGISTRY_ID: "0x22",
  VITE_SMART_INDUSTRY_PACKAGE_ID: "0x31",
  VITE_SMART_INDUSTRY_TYPE_ORIGIN: "0x33",
  VITE_SMART_INDUSTRY_REGISTRY_ID: "0x32",
  VITE_TRANSPONDER_PACKAGE_ID: "0x41",
  VITE_TRANSPONDER_TYPE_ORIGIN: "0x43",
  VITE_TRANSPONDER_REGISTRY_ID: "0x42",
  VITE_ASSEMBLY_ACCESS_PACKAGE_ID: "0x51",
  VITE_ASSEMBLY_ACCESS_TYPE_ORIGIN: "0x53",
  VITE_ASSEMBLY_ACCESS_REGISTRY_ID: "0x52",
};
const respond =
  (payload: unknown): typeof fetch =>
  async () =>
    Response.json(payload);

test("bootstrap uses the current world and preserves assembly selection defaults", async () => {
  const original = { ...baked };
  const { env, error } = await loadRuntimeConfig(
    baked,
    respond({
      ...deployed,
      VITE_ITEM_ID: "1",
      VITE_OBJECT_ID: "0x5",
      EXTRA_SETTING: "ignored",
    }),
  );
  assert.equal(error, "");
  assert.deepEqual(env, { ...baked, ...deployed });
  assert.deepEqual(baked, original);
  const config = configFromEnv(env);
  assert.equal(
    assemblyKind(
      `${deployed.VITE_EVE_WORLD_PACKAGE_ID}::network_node::NetworkNode`,
      config,
    ),
    "network_node",
  );
  const params = new URLSearchParams({ itemId: "18446744073709551615" });
  assert.equal(
    resolveAssemblyId(config, params),
    resolveAssemblyId(configFromEnv(deployed), params),
  );
  assert.notEqual(
    resolveAssemblyId(config, params),
    resolveAssemblyId(configFromEnv(baked), params),
  );
});

test("each bootstrap rereads the deployment through an absolute uncached request", async () => {
  let nextDeployment = deployed;
  let requests = 0;
  const fetcher: typeof fetch = async (url, options) => {
    requests++;
    assert.equal(url, "/assembly-config.json");
    assert.equal(options?.cache, "no-store");
    assert.ok(options?.signal instanceof AbortSignal);
    return Response.json(nextDeployment);
  };
  const first = await loadRuntimeConfig(baked, fetcher);
  nextDeployment = { ...deployed, VITE_EVE_WORLD_PACKAGE_ID: "0x42" };
  const second = await loadRuntimeConfig(baked, fetcher);
  assert.equal(
    first.env.VITE_EVE_WORLD_PACKAGE_ID,
    deployed.VITE_EVE_WORLD_PACKAGE_ID,
  );
  assert.equal(second.env.VITE_EVE_WORLD_PACKAGE_ID, "0x42");
  assert.equal(requests, 2);
});

test("static hosts retain baked config for absent endpoints and SPA HTML fallback", async () => {
  for (const response of [
    new Response(null, { status: 204 }),
    new Response("Not found", { status: 404 }),
    new Response("<!doctype html><html><body>App</body></html>", {
      headers: { "Content-Type": "text/html" },
    }),
    new Response("  <HTML><body>App</body></HTML>"),
  ]) {
    assert.deepEqual(await loadRuntimeConfig(baked, async () => response), {
      env: baked,
      error: "",
    });
  }
});

test("invalid JSON and incomplete or unsafe deployed config block stale config", async () => {
  const invalid: unknown[] = [
    null,
    [],
    "configuration",
    {},
    { ...deployed, VITE_TENANT: " " },
    { ...deployed, VITE_SUI_NETWORK: "unknown" },
    { ...deployed, VITE_SUI_RPC_URL: "file:///private" },
    { ...deployed, VITE_SUI_RPC_URL: "https://user:secret@example.com" },
    { ...deployed, VITE_EVE_WORLD_PACKAGE_ID: "wrong" },
    { ...deployed, VITE_OBJECT_REGISTRY_ID: "0xzz" },
    { ...deployed, VITE_ENERGY_CONFIG_ID: 42 },
    { ...deployed, VITE_FUEL_CONFIG_ID: "" },
  ];
  for (const payload of invalid) {
    const result = await loadRuntimeConfig(baked, respond(payload));
    assert.deepEqual(result.env, {}, JSON.stringify(payload));
    assert.match(result.error, /reload this page/);
  }
  const invalidJson = await loadRuntimeConfig(
    baked,
    async () => new Response("{broken"),
  );
  assert.deepEqual(invalidJson.env, {});
  assert.match(invalidJson.error, /not valid JSON/);
});

test("server and network failures block instead of reverting to an old world", async () => {
  for (const status of [401, 500, 503]) {
    const result = await loadRuntimeConfig(
      baked,
      async () => new Response("<html>Error</html>", { status }),
    );
    assert.deepEqual(result.env, {});
    assert.match(result.error, new RegExp(`HTTP ${status}`));
  }
  const networkFailure = await loadRuntimeConfig(baked, async () => {
    throw new TypeError("Network unavailable");
  });
  assert.deepEqual(networkFailure.env, {});
  assert.match(networkFailure.error, /Network unavailable/);
});

test("configuration timeouts abort requests and leave wallet configuration unavailable", async () => {
  let signal: AbortSignal | null | undefined;
  const result = await loadRuntimeConfig(
    baked,
    async (_url, options) => {
      signal = options?.signal;
      return new Promise<Response>(() => {});
    },
    10,
  );
  assert.equal(signal?.aborted, true);
  assert.deepEqual(result.env, {});
  assert.match(result.error, /timed out/);
});

test("the timeout also covers a stalled response body", async () => {
  const result = await loadRuntimeConfig(
    baked,
    async () =>
      new Response(new ReadableStream({ start() {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    10,
  );
  assert.deepEqual(result.env, {});
  assert.match(result.error, /timed out/);
});
