import assert from "node:assert/strict";
import test from "node:test";
import {
  createTypeNameCatalog,
  displayTypeName,
  isPlaceholderTypeName,
  typeCatalogBase,
} from "../src/localization/type-names.ts";

test("type names preserve meaningful server names and replace numeric placeholders", () => {
  assert.equal(
    displayTypeName(88092, "Network Node", "Localized Node"),
    "Network Node",
  );
  assert.equal(
    displayTypeName(88092, "Type 88092", "Network Node"),
    "Network Node",
  );
  assert.equal(
    displayTypeName(88092, "typeID #88092", "Network Node"),
    "Network Node",
  );
  assert.equal(displayTypeName(88092, "", undefined), "Type 88092");
  assert.equal(isPlaceholderTypeName("Fuel type 88092", 88092), true);
  assert.equal(isPlaceholderTypeName("Network Node", 88092), false);
});

test("type catalog selects the current public environment hosts", () => {
  assert.equal(
    typeCatalogBase("utopia"),
    "https://world-api-utopia.uat.pub.evefrontier.com",
  );
  assert.equal(
    typeCatalogBase("dev"),
    "https://world-api-stillness.live.pub.evefrontier.com",
  );
});

test("type catalog validates, caches and softly rejects unavailable records", async () => {
  const requests: string[] = [];
  const catalog = createTypeNameCatalog(async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("/404"))
      return new Response("missing", { status: 404 });
    if (String(url).endsWith("/99"))
      return new Response(JSON.stringify({ id: 100, name: "Wrong type" }));
    return new Response(JSON.stringify({ id: 88092, name: "Network Node" }));
  });

  assert.deepEqual(
    await Promise.all([
      catalog.lookup(88092, "stillness"),
      catalog.lookup("88092", "stillness"),
    ]),
    ["Network Node", "Network Node"],
  );
  assert.equal(catalog.peek(88092, "stillness"), "Network Node");
  assert.equal(requests.length, 1);
  assert.equal(await catalog.lookup(404), undefined);
  assert.equal(await catalog.lookup(99), undefined);
  assert.equal(await catalog.lookup(0), undefined);
  assert.equal(requests.length, 3);
});
