import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, preview } from "vite";
import { testTls } from "./fixtures/tls.mjs";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const keyFile = fileURLToPath(
  new URL("./fixtures/localhost-test-key.pem", import.meta.url),
);
const certFile = fileURLToPath(
  new URL("./fixtures/localhost-test-cert.pem", import.meta.url),
);
const indexDocument = "<!doctype html><title>Vite HTTPS fixture</title>";

function request(port, route, secure = true, host = "localhost") {
  return new Promise((resolve, reject) => {
    const outgoing = (secure ? https : http).get(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        agent: false,
        headers: { Host: host },
        ...(secure ? { ca: testTls.cert, servername: host } : {}),
      },
      (response) => {
        let body = "";
        const authorized = response.socket.authorized;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            authorized,
            body,
          }),
        );
      },
    );
    outgoing.setTimeout(3000, () => {
      outgoing.destroy(new Error("Local Vite request timed out."));
    });
    outgoing.on("error", reject);
  });
}

async function assertHttpsRoutes(port) {
  for (const route of ["/client/root/", "/client/behaviour/"]) {
    const page = await request(
      port,
      `${route}?tenant=dev&itemId=9988400000137`,
    );
    assert.equal(page.authorized, true);
    assert.equal(page.status, 200);
    assert.match(page.body, /Vite HTTPS fixture/u);
  }
  const runtime = await request(port, "/assembly-config.json");
  assert.equal(runtime.authorized, true);
  // The real config plugin can be configured, unconfigured, or waiting for a
  // deployment on this checkout; every state must use the runtime endpoint.
  assert.ok([200, 204, 503].includes(runtime.status));
  assert.equal(runtime.headers["cache-control"], "no-store");
  assert.doesNotMatch(runtime.body, /<!doctype|Vite HTTPS fixture/u);
  if (runtime.status === 200) {
    assert.match(runtime.headers["content-type"], /application\/json/u);
    assert.equal(typeof JSON.parse(runtime.body).VITE_SUI_NETWORK, "string");
  } else if (runtime.status === 204) {
    assert.equal(runtime.body, "");
  } else {
    assert.equal(typeof JSON.parse(runtime.body).error, "string");
  }
  const dappHost = "dev.dapps.evefrontier.com";
  const mappedPage = await request(
    port,
    "/client/root/?tenant=dev&itemId=9988400000137",
    true,
    dappHost,
  );
  assert.equal(mappedPage.authorized, true);
  assert.equal(mappedPage.status, 200);
  assert.match(mappedPage.body, /Vite HTTPS fixture/u);
  const mappedRuntime = await request(
    port,
    "/assembly-config.json",
    true,
    dappHost,
  );
  assert.equal(mappedRuntime.authorized, true);
  assert.equal(mappedRuntime.status, runtime.status);
  assert.equal(mappedRuntime.headers["cache-control"], "no-store");

  // HTTPS listeners may reset plaintext connections or return an HTTP/2 error
  // response. Neither outcome may serve the app over plaintext HTTP.
  try {
    const plaintext = await request(port, "/client/root/", false);
    assert.ok(plaintext.status >= 400);
    assert.doesNotMatch(plaintext.body, /Vite HTTPS fixture/u);
  } catch (error) {
    assert.ok(
      error.code === "ECONNRESET" || error.code?.startsWith("HPE_"),
      `Unexpected plaintext response: ${error.code || error.message}`,
    );
  }
}

test("Vite dev and preview use trusted HTTPS and dev cannot serve private PEM files", async (context) => {
  const cache = path.join(appDirectory, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(path.join(cache, "vite-https-test-"));
  const savedEnvironment = {
    DAPP_TLS_KEY_FILE: process.env.DAPP_TLS_KEY_FILE,
    DAPP_TLS_CERT_FILE: process.env.DAPP_TLS_CERT_FILE,
  };
  const servers = [];
  context.after(async () => {
    try {
      for (const server of servers.reverse()) await server.close();
    } finally {
      for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const relative = path.relative(cache, path.resolve(temporary));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Temporary test path escaped the workspace cache.");
      await rm(temporary, { recursive: true, force: true });
    }
  });
  process.env.DAPP_TLS_KEY_FILE = keyFile;
  process.env.DAPP_TLS_CERT_FILE = certFile;
  const build = path.join(temporary, "dist");
  await mkdir(build);
  await mkdir(path.join(temporary, ".certs"));
  await writeFile(path.join(temporary, "index.html"), indexDocument);
  await writeFile(path.join(build, "index.html"), indexDocument);
  await writeFile(
    path.join(temporary, ".certs/localhost-key.pem"),
    testTls.key,
  );
  const common = {
    configFile: path.join(appDirectory, "vite.config.mts"),
    root: temporary,
    cacheDir: path.join(temporary, ".vite"),
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    build: { outDir: build },
  };
  const development = await createServer({
    ...common,
    server: {
      host: "127.0.0.1",
      port: 0,
      watch: null,
      fs: { allow: [appDirectory, temporary] },
    },
  });
  servers.push(development);
  await development.listen();
  const devPort = development.httpServer.address().port;
  await assertHttpsRoutes(devPort);
  for (const route of [
    "/.certs/localhost-key.pem",
    `/@fs/${keyFile.replaceAll("\\", "/")}`,
  ]) {
    const response = await request(devPort, route);
    assert.equal(response.authorized, true);
    assert.ok(
      [403, 404].includes(response.status),
      `PEM route was served: ${route}`,
    );
    assert.equal(response.body.includes("PRIVATE KEY"), false);
  }

  const productionPreview = await preview({
    ...common,
    preview: { host: "127.0.0.1", port: 0 },
  });
  servers.push(productionPreview);
  await assertHttpsRoutes(productionPreview.httpServer.address().port);
});
