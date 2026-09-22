import assert from "node:assert/strict";
import https from "node:https";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createDeploymentMiddleware,
  readDeploymentEnvironment,
} from "../scripts/deployment-config.mjs";
import { createStaticServer } from "../scripts/serve.mjs";
import { testTls } from "./fixtures/tls.mjs";

const publicIdFields = {
  packageId: "VITE_EVE_WORLD_PACKAGE_ID",
  objectRegistry: "VITE_OBJECT_REGISTRY_ID",
  energyConfig: "VITE_ENERGY_CONFIG_ID",
  fuelConfig: "VITE_FUEL_CONFIG_ID",
  adminAcl: "VITE_ADMIN_ACL_ID",
};
const featureFields = {
  npc: ["NPC", "packageId", "typeOrigin", "npcRegistryId"],
  catapult: ["CATAPULT", "catapultPackageId", "catapultTypeOrigin", "catapultRegistryId"],
  smartIndustry: ["SMART_INDUSTRY", "industryPackageId", "industryTypeOrigin", "industryRegistryId"],
  transponder: ["TRANSPONDER", "transponderPackageId", "transponderTypeOrigin", "transponderRegistryId"],
  assemblyAccess: ["ASSEMBLY_ACCESS", "accessPackageId", "accessTypeOrigin", "accessRegistryId"],
  actionQueue: ["ACTION_QUEUE", "actionPackageId", "actionTypeOrigin", "actionRegistryId"],
  industryActions: ["INDUSTRY_ACTIONS", "industryActionsPackageId", "industryActionsTypeOrigin", "industryActionsRegistryId"],
  logisticsActions: ["LOGISTICS_ACTIONS", "logisticsPackageId", "logisticsTypeOrigin", "logisticsRegistryId"],
  infrastructureActions: ["INFRASTRUCTURE_ACTIONS", "infrastructurePackageId", "infrastructureTypeOrigin", "infrastructureRegistryId"],
  automation: ["AUTOMATION", "automationPackageId", "automationTypeOrigin", "automationRegistryId"],
};
const privateMarker = "private-deployment-value-never-export";
const indexDocument = "<!doctype html><title>Deployment sync test</title>";

function artifact(firstId) {
  const featureEntries = Object.fromEntries(
    Object.keys(featureFields).map((name, index) => [
      name,
      {
        packageId: `0x${(firstId + 16 + index * 3).toString(16)}`,
        registryId: `0x${(firstId + 17 + index * 3).toString(16)}`,
      },
    ]),
  );
  return {
    network: "localnet",
    world: {
      ...Object.fromEntries(
        Object.keys(publicIdFields).map((field, index) => [
          field,
          `0x${(firstId + index).toString(16)}`,
        ]),
      ),
      governorCap: privateMarker,
      privateKey: privateMarker,
    },
    features: featureEntries,
    secret: privateMarker,
  };
}

function featureDeployment(firstId) {
  const deployment = {
    chainId: "0609212e",
    worldPackageId: `0x${firstId.toString(16)}`,
    objectRegistryId: `0x${(firstId + 1).toString(16)}`,
    adminAclId: `0x${(firstId + 4).toString(16)}`,
  };
  for (const [name, [, packageField, originField, registryField]] of Object.entries(featureFields)) {
    const feature = artifact(firstId).features[name];
    deployment[packageField] = feature.packageId;
    deployment[originField] = `0x${(firstId + 18 + Object.keys(featureFields).indexOf(name) * 3).toString(16)}`;
    deployment[registryField] = feature.registryId;
  }
  return deployment;
}

function expectedEnvironment(deployment) {
  return {
    VITE_SUI_NETWORK: "localnet",
    VITE_SUI_RPC_URL: "http://127.0.0.1:9000",
    VITE_SUI_CHAIN_ID: "0609212e",
    VITE_TENANT: "sync-test",
    ...Object.fromEntries(
      Object.entries(publicIdFields).map(([field, variable]) => [
        variable,
        `0x${deployment.world[field].slice(2).padStart(64, "0")}`,
      ]),
    ),
    VITE_EVE_WORLD_TYPE_ORIGIN: `0x${deployment.world.packageId.slice(2).padStart(64, "0")}`,
    ...Object.fromEntries(
      Object.entries(featureFields).flatMap(([name, [prefix, , originField]]) => {
        const feature = deployment.features[name];
        const manifest = featureDeployment(
          Number.parseInt(deployment.world.packageId.slice(2), 16),
        );
        return [
          [`VITE_${prefix}_PACKAGE_ID`, `0x${feature.packageId.slice(2).padStart(64, "0")}`],
          [`VITE_${prefix}_TYPE_ORIGIN`, `0x${manifest[originField].slice(2).padStart(64, "0")}`],
          [`VITE_${prefix}_REGISTRY_ID`, `0x${feature.registryId.slice(2).padStart(64, "0")}`],
        ];
      }),
    ),
  };
}

async function fixture(
  context,
  { configured = true, middlewareOnly = false } = {},
) {
  const cache = path.resolve(
    fileURLToPath(new URL("../", import.meta.url)),
    "node_modules/.cache",
  );
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(path.join(cache, "deployment-sync-test-"));
  let server;
  context.after(async () => {
    if (server?.listening) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
    const relative = path.relative(cache, path.resolve(temporary));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Temporary test path escaped the workspace cache.");
    }
    await rm(temporary, { recursive: true, force: true });
  });
  const build = path.join(temporary, "dist");
  const world = path.join(temporary, "world-contracts");
  const deploymentFile = path.join(
    world,
    "deployments/localnet/extracted-object-ids.json",
  );
  const featureDeploymentFile = path.join(
    world,
    "deployments/localnet/npc-deployment.json",
  );
  const descriptorFile = path.join(temporary, ".deployment-source.json");
  await mkdir(build, { recursive: true });
  await mkdir(path.dirname(deploymentFile), { recursive: true });
  await writeFile(path.join(build, "index.html"), indexDocument);
  // The runtime route must win over any stale file left in a previous build.
  await writeFile(
    path.join(build, "assembly-config.json"),
    "stale-built-config",
  );
  const descriptor = {
    worldDir: world,
    network: "localnet",
    rpcUrl: "http://127.0.0.1:9000",
    tenant: "sync-test",
  };
  if (configured) {
    await writeFile(descriptorFile, JSON.stringify(descriptor));
  }
  const writeDeployment = async (value, manifest) => {
    await Promise.all([
      writeFile(deploymentFile, JSON.stringify(value)),
      writeFile(featureDeploymentFile, JSON.stringify(manifest)),
    ]);
  };
  await writeDeployment(artifact(1), featureDeployment(1));
  if (middlewareOnly) {
    const middleware = createDeploymentMiddleware(temporary);
    server = https.createServer(testTls, (request, response) => {
      Promise.resolve(
        middleware(request, response, () => {
          response.writeHead(404);
          response.end("Passed through");
        }),
      ).catch((error) => response.destroy(error));
    });
  } else {
    server = await createStaticServer(build, {
      appDirectory: temporary,
      tls: testTls,
    });
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const request = (
    route = "/assembly-config.json",
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
          response.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  return {
    temporary,
    build,
    deploymentFile,
    featureDeploymentFile,
    descriptorFile,
    writeDeployment,
    request,
  };
}

test("a trusted HTTPS host follows redeployed world IDs without rebuilding or restarting", async (context) => {
  const app = await fixture(context);
  const first = await app.request();
  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], "no-store");
  assert.match(first.headers["content-type"], /application\/json/u);
  assert.deepEqual(JSON.parse(first.body), expectedEnvironment(artifact(1)));
  assert.doesNotMatch(
    first.body,
    /private-deployment-value|governorCap|privateKey|secret|worldDir/u,
  );
  assert.equal(first.body.includes(app.temporary), false);
  const root = await app.request(
    "/client/root/?tenant=sync-test&itemId=9988400000137",
  );
  assert.equal(root.status, 200);
  assert.equal(root.body, indexDocument);
  const dappHost = "dev.dapps.evefrontier.com";
  const mappedConfig = await app.request(
    "/assembly-config.json",
    "GET",
    dappHost,
    dappHost,
  );
  assert.equal(mappedConfig.status, 200);
  assert.deepEqual(
    JSON.parse(mappedConfig.body),
    expectedEnvironment(artifact(1)),
  );

  const replacement = artifact(17);
  await app.writeDeployment(replacement, featureDeployment(17));
  const next = await app.request("/assembly-config.json?reload=1");
  assert.equal(next.status, 200);
  assert.equal(next.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(next.body), expectedEnvironment(replacement));
  assert.deepEqual(
    await readDeploymentEnvironment(app.temporary),
    expectedEnvironment(replacement),
  );
  assert.equal(
    await readFile(path.join(app.build, "index.html"), "utf8"),
    indexDocument,
  );
  const head = await app.request("/assembly-config.json", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["cache-control"], "no-store");
  assert.match(head.headers["content-type"], /application\/json/u);
});

test("a missing or invalid configured deployment fails without returning cached IDs", async (context) => {
  const app = await fixture(context);
  assert.equal((await app.request()).status, 200);
  const invalidDeployments = [
    null,
    "{ invalid JSON",
    JSON.stringify({ ...artifact(1), network: "testnet" }),
    JSON.stringify({
      ...artifact(1),
      world: { ...artifact(1).world, fuelConfig: "invalid" },
    }),
  ];
  let genericError;
  for (const invalid of invalidDeployments) {
    if (invalid === null) await rm(app.deploymentFile);
    else await writeFile(app.deploymentFile, invalid);
    const response = await app.request();
    assert.equal(response.status, 503);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.doesNotMatch(
      response.body,
      /0x[\da-f]{64}|private-deployment-value|world-contracts|extracted-object-ids|SyntaxError/u,
    );
    assert.equal(response.body.includes(app.temporary), false);
    if (genericError === undefined) genericError = response.body;
    else assert.equal(response.body, genericError);
  }
  const head = await app.request("/assembly-config.json", "HEAD");
  assert.equal(head.status, 503);
  assert.equal(head.body, "");
  await app.writeDeployment(artifact(33), featureDeployment(33));
  assert.deepEqual(
    JSON.parse((await app.request()).body),
    expectedEnvironment(artifact(33)),
  );
  await writeFile(app.descriptorFile, "{ invalid JSON");
  const invalidDescriptor = await app.request();
  assert.equal(invalidDescriptor.status, 503);
  assert.equal(invalidDescriptor.body, genericError);
});

test("an unconfigured host returns 204 and preserves game routes and ordinary missing routes", async (context) => {
  const app = await fixture(context, { configured: false });
  assert.equal(await readDeploymentEnvironment(app.temporary), null);
  for (const method of ["GET", "HEAD"]) {
    const response = await app.request("/assembly-config.json", method);
    assert.equal(response.status, 204);
    assert.equal(response.body, "");
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const game = await app.request(
    "/client/networknode/monitor/?tenant=dev&itemId=123",
  );
  assert.equal(game.status, 200);
  assert.equal(game.body, indexDocument);
  assert.equal((await app.request("/unknown-route")).status, 404);
  assert.equal((await app.request("/assets/missing.js")).status, 404);
});

test("deployment middleware itself restricts methods and hosts while passing unrelated routes through", async (context) => {
  const app = await fixture(context, { middlewareOnly: true });
  for (const host of ["localhost:5174", "127.0.0.1:5174", "[::1]:5174"]) {
    assert.equal(
      (await app.request("/assembly-config.json", "GET", host)).status,
      200,
    );
  }
  const forbidden = await app.request(
    "/assembly-config.json",
    "GET",
    "attacker.example",
  );
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers["cache-control"], "no-store");
  assert.doesNotMatch(forbidden.body, /VITE_|0x[\da-f]{64}/u);
  const post = await app.request("/assembly-config.json", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  assert.equal(post.headers["cache-control"], "no-store");
  const unrelated = await app.request("/unknown-route");
  assert.equal(unrelated.status, 404);
  assert.equal(unrelated.body, "Passed through");
});
