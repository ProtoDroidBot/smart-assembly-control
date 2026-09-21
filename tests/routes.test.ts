import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv, resolveAssemblyId } from "../src/assembly/config.ts";
import {
  assemblyInput,
  assemblySelection,
  assemblyView,
  assemblyViewUrl,
} from "../src/assembly/routes.ts";

const config = configFromEnv({
  VITE_EVE_WORLD_PACKAGE_ID: "0xa",
  VITE_OBJECT_REGISTRY_ID: "0xb",
  VITE_OBJECT_ID: "0xc",
});

test("client root and behaviour URLs open distinct views of the same game assembly", () => {
  const search = "?tenant=test-tenant&itemId=18446744073709551615";
  const objectId = resolveAssemblyId(config, new URLSearchParams(search));
  for (const [view, path] of [
    ["overview", "/client/root/"],
    ["behaviour", "/client/behaviour/"],
    ["storage", "/client/storage/"],
    ["industry", "/client/industry/"],
    ["gate", "/client/gate/"],
    ["network", "/client/networknode/monitor/"],
    ["scanning", "/client/networknode/scanning/"],
    ["scanResults", "/client/networknode/scanning/results/"],
  ] as const) {
    const url = new URL(
      assemblyViewUrl(view, search),
      "https://dev.dapps.evefrontier.com",
    );
    assert.equal(url.origin, "https://dev.dapps.evefrontier.com");
    assert.equal(url.port, "");
    assert.equal(url.pathname, path);
    assert.equal(url.search, search);
    assert.equal(assemblyView(url.pathname), view);
    assert.equal(assemblyView(path.slice(0, -1)), view);
    assert.equal(resolveAssemblyId(config, url.searchParams), objectId);
    assert.equal(
      assemblyInput(config, url.searchParams),
      "18446744073709551615",
    );
  }
  assert.equal(assemblyView("/"), "overview");
  assert.equal(assemblyView("/something-monitor"), "overview");
});

test("changing assembly removes conflicting ID aliases while retaining client context", () => {
  const params = assemblySelection(
    "?tenant=old&objectId=0x1&object_id=0x2&itemId=3&item_id=4&lang=en&context=a%2Bb",
    "18446744073709551615",
    "test-tenant",
  );
  assert.deepEqual([...params.keys()].sort(), [
    "context",
    "itemId",
    "lang",
    "tenant",
  ]);
  assert.equal(params.get("itemId"), "18446744073709551615");
  assert.equal(params.get("context"), "a+b");
  const objectId = resolveAssemblyId(config, params);
  const behaviourUrl = new URL(
    assemblyViewUrl("behaviour", params.toString()),
    "https://dev.dapps.evefrontier.com",
  );
  assert.equal(resolveAssemblyId(config, behaviourUrl.searchParams), objectId);
  const nodeParams = assemblySelection(
    behaviourUrl.search,
    " 0xd ",
    "test-tenant",
  );
  assert.equal(nodeParams.get("objectId"), "0xd");
  assert.equal(nodeParams.has("itemId"), false);
  assert.equal(nodeParams.get("lang"), "en");
  assert.equal(assemblyInput(config, nodeParams), "0xd");
});
