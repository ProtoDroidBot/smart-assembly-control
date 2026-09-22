import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildPublicEnvironment } from "../scripts/configure-local.mjs";
import { createStaticServer, getRelativeAsset } from "../scripts/serve.mjs";
import { testTls } from "./fixtures/tls.mjs";

test("game document routes fall back to index without masking missing assets", () => {
  for (const route of [
    "/",
    "/client/root/",
    "/client/behaviour/",
    "/client/storage/",
    "/client/industry",
    "/client/industry/",
    "/client/gate/",
    "/client/networknode/monitor/",
    "/client/networknode/scanning/",
    "/client/networknode/scanning/results/",
  ]) {
    assert.equal(
      getRelativeAsset(`${route}?tenant=dev&itemId=123`),
      "index.html",
    );
  }
  assert.equal(getRelativeAsset("/assets/missing.js"), "assets/missing.js");
  assert.equal(getRelativeAsset("/unknown-route"), "unknown-route");
});

test("static path parsing refuses traversal, hidden files, Windows paths, and malformed encoding", () => {
  for (const route of [
    "/../.env",
    "/%2e%2e/package.json",
    "/assets/../../secret",
    "/%5c..%5csecret",
    "/C:/secret",
    "/.env.local",
    "/assets/.secret",
    "/%00file",
    "/%ZZ",
  ]) {
    assert.equal(getRelativeAsset(route), null, route);
  }
});

const artifact = {
  network: "localnet",
  world: {
    packageId: "0x1",
    objectRegistry: "0x2",
    energyConfig: "0x3",
    fuelConfig: "0x4",
    adminAcl: "0x5",
    privateKey: "never-export-me",
    governorCap: "0x6",
  },
  features: {
    npc: { packageId: "0x11", registryId: "0x12" },
    catapult: { packageId: "0x21", registryId: "0x22" },
    smartIndustry: { packageId: "0x31", registryId: "0x32" },
    transponder: { packageId: "0x41", registryId: "0x42" },
    assemblyAccess: { packageId: "0x51", registryId: "0x52" },
    actionQueue: { packageId: "0x61", registryId: "0x62" },
    industryActions: { packageId: "0x71", registryId: "0x72" },
    logisticsActions: { packageId: "0x81", registryId: "0x82" },
    infrastructureActions: { packageId: "0x91", registryId: "0x92" },
    automation: { packageId: "0xa1", registryId: "0xa2" },
  },
  secret: "never-export-me",
};
const featureDeployment = {
  chainId: "0609212e",
  worldPackageId: "0x1",
  objectRegistryId: "0x2",
  adminAclId: "0x5",
  packageId: "0x11",
  typeOrigin: "0x13",
  npcRegistryId: "0x12",
  catapultPackageId: "0x21",
  catapultTypeOrigin: "0x23",
  catapultRegistryId: "0x22",
  industryPackageId: "0x31",
  industryTypeOrigin: "0x33",
  industryRegistryId: "0x32",
  transponderPackageId: "0x41",
  transponderTypeOrigin: "0x43",
  transponderRegistryId: "0x42",
  accessPackageId: "0x51",
  accessTypeOrigin: "0x53",
  accessRegistryId: "0x52",
  actionPackageId: "0x61",
  actionTypeOrigin: "0x63",
  actionRegistryId: "0x62",
  industryActionsPackageId: "0x71",
  industryActionsTypeOrigin: "0x73",
  industryActionsRegistryId: "0x72",
  logisticsPackageId: "0x81",
  logisticsTypeOrigin: "0x83",
  logisticsRegistryId: "0x82",
  infrastructurePackageId: "0x91",
  infrastructureTypeOrigin: "0x93",
  infrastructureRegistryId: "0x92",
  automationPackageId: "0xa1",
  automationTypeOrigin: "0xa3",
  automationRegistryId: "0xa2",
};

test("public configuration exports only the required IDs and network settings", () => {
  const result = buildPublicEnvironment(artifact, { featureDeployment });
  assert.match(result, /VITE_SUI_NETWORK="localnet"/u);
  assert.match(result, /VITE_EVE_WORLD_PACKAGE_ID="0x0{63}1"/u);
  assert.doesNotMatch(result, /never-export-me|privateKey|governorCap|secret/u);
  assert.equal(
    result.split("\n").filter((line) => line.startsWith("VITE_")).length,
    42,
  );
});

test("public configuration rejects mismatched deployment networks and credential URLs", () => {
  assert.throws(
    () => buildPublicEnvironment(artifact, { network: "testnet", featureDeployment }),
    /does not match/u,
  );
  assert.throws(() => buildPublicEnvironment({ world: {} }, { featureDeployment }), /packageId/u);
  assert.throws(
    () =>
      buildPublicEnvironment(artifact, {
        rpcUrl: "http://user:password@localhost:9000",
        featureDeployment,
      }),
    /credentials/u,
  );
  assert.throws(
    () =>
      buildPublicEnvironment(artifact, {
        rpcUrl: "http://localhost:9000?key=private",
        featureDeployment,
      }),
    /credentials/u,
  );
  assert.throws(
    () => buildPublicEnvironment(artifact, { tenant: "dev\nINJECT=value", featureDeployment }),
    /Tenant/u,
  );
});

test("production host serves trusted HTTPS routes and rejects plaintext HTTP and files outside the build root", async (context) => {
  const cache = path.resolve(
    fileURLToPath(new URL("../", import.meta.url)),
    "node_modules/.cache",
  );
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(path.join(cache, "assembly-host-smoke-"));
  context.after(async () => {
    const relative = path.relative(cache, path.resolve(temporary));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Temporary test path escaped the workspace cache.");
    await rm(temporary, { recursive: true, force: true });
  });
  const build = path.join(temporary, "dist");
  const outside = path.join(temporary, "outside");
  await mkdir(path.join(build, "assets"), { recursive: true });
  await mkdir(outside);
  await writeFile(
    path.join(build, "index.html"),
    "<!doctype html><title>Assembly test</title>",
  );
  await writeFile(
    path.join(build, "assets/app-12345678.js"),
    "export const ready = true;",
  );
  await writeFile(path.join(outside, "private.txt"), "outside-build-root");
  await symlink(
    outside,
    path.join(build, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const forwarded = [];
  const upstream = http.createServer((req, res) => {
    forwarded.push({ path: req.url, method: req.method });
    req.resume();
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, errorMsg: "AUTH_REQUIRED" }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const server = await createStaticServer(build, {
    appDirectory: temporary,
    tls: testTls,
    storageServerUrl: `http://127.0.0.1:${upstream.address().port}`,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  const request = (
    route,
    method = "GET",
    host = "localhost",
    servername = "localhost",
  ) =>
    new Promise((resolve, reject) => {
      const outgoing = https.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: route,
          method,
          headers: { Host: host },
          agent: false,
          ca: testTls.cert,
          // Validate the TLS peer independently of the Host header under test.
          servername,
        },
        (response) => {
          assert.equal(response.socket.authorized, true);
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body,
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  const page = await request("/client/root/?tenant=dev&itemId=123");
  assert.equal(page.status, 200);
  assert.match(page.body, /Assembly test/u);
  assert.match(page.headers["content-type"], /text\/html/u);
  assert.equal(page.headers["cache-control"], "no-store");
  const industryPage = await request("/client/industry/?tenant=dev&itemId=123");
  assert.equal(industryPage.status, 200);
  assert.match(industryPage.body, /Assembly test/u);
  assert.equal(industryPage.headers["cache-control"], "no-store");
  const head = await request("/client/behaviour/", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.ok(Number(head.headers["content-length"]) > 0);
  const runtime = await request("/assembly-config.json");
  assert.equal(runtime.status, 204);
  assert.equal(runtime.body, "");
  assert.equal(runtime.headers["cache-control"], "no-store");
  const dappHost = "dev.dapps.evefrontier.com";
  const mappedPage = await request(
    "/client/root/?tenant=dev&itemId=123",
    "GET",
    dappHost,
    dappHost,
  );
  assert.equal(mappedPage.status, 200);
  assert.match(mappedPage.body, /Assembly test/u);
  assert.equal(
    (await request("/assembly-config.json", "GET", dappHost, dappHost)).status,
    204,
  );
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const outgoing = http.get(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/client/root/?tenant=dev&itemId=123",
            agent: false,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        outgoing.setTimeout(3000, () => {
          outgoing.destroy(new Error("Plaintext HTTP request timed out."));
        });
        outgoing.on("error", reject);
      }),
    { code: "ECONNRESET" },
  );
  const asset = await request("/assets/app-12345678.js");
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"], /javascript/u);
  assert.match(asset.headers["cache-control"], /immutable/u);
  for (const route of [
    "/assets/missing.js",
    "/unknown-route",
    "/escape/private.txt",
  ]) {
    assert.equal((await request(route)).status, 404, route);
  }
  for (const route of [
    "/.env.local",
    "/%2e%2e/outside/private.txt",
    "/%5c..%5coutside/private.txt",
  ]) {
    assert.equal((await request(route)).status, 400, route);
  }
  assert.equal((await request("/", "POST")).status, 405);
  for (const [api, action] of [["admin", "prepare"], ["storage", "prepare"], ["gates", "link"], ["industry", "status"]]) {
    const result = await request(`/evejs/${api}/123/${action}`, "POST");
    assert.equal(result.status, 401);
    assert.equal(JSON.parse(result.body).errorMsg, "AUTH_REQUIRED");
  }
  assert.deepEqual(forwarded, [
    { path: "/evejs/admin/123/prepare", method: "POST" },
    { path: "/evejs/storage/123/prepare", method: "POST" },
    { path: "/evejs/gates/123/link", method: "POST" },
    { path: "/evejs/industry/123/status", method: "POST" },
  ]);
  assert.equal((await request("/", "GET", "attacker.example")).status, 403);
});
