import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import https from "node:https";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { testTls } from "./fixtures/tls.mjs";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const cacheDirectory = path.join(appDirectory, "node_modules/.cache");
const contextResources = new WeakMap();

function resourcesFor(context) {
  if (contextResources.has(context)) return contextResources.get(context);
  const resources = { children: [], directories: [] };
  contextResources.set(context, resources);
  context.after(async () => {
    // A running Windows process holds its cwd open. Stop every fixture child
    // before removing any directory, including after an assertion fails.
    for (const state of resources.children.toReversed()) {
      if (state.ended) continue;
      state.child.kill("SIGTERM");
      if (
        !(await Promise.race([
          state.exit.then(() => true),
          delay(2000, false, { ref: false }),
        ]))
      ) {
        state.child.kill("SIGKILL");
        assert.ok(
          await Promise.race([
            state.exit.then(() => true),
            delay(2000, false, { ref: false }),
          ]),
          "Test child did not exit during cleanup.",
        );
      }
    }
    for (const directory of resources.directories.toReversed()) {
      const relative = path.relative(cacheDirectory, path.resolve(directory));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Restart fixture escaped the workspace cache.");
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  return resources;
}

function startChild(context, args, options = {}) {
  const child = spawn(process.execPath, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const state = { child, output: () => output, ended: false };
  state.exit = new Promise((resolve) => {
    child.once("error", (error) => {
      state.ended = true;
      resolve({ error });
    });
    child.once("exit", (code, signal) => {
      state.ended = true;
      resolve({ code, signal });
    });
  });
  resourcesFor(context).children.push(state);
  return state;
}

async function createFixture(context, { build = true, tls = true } = {}) {
  await mkdir(cacheDirectory, { recursive: true });
  const directory = await mkdtemp(
    path.join(cacheDirectory, "dapp-restart-test-"),
  );
  resourcesFor(context).directories.push(directory);
  await mkdir(path.join(directory, "scripts"));
  const sourceScripts = path.join(appDirectory, "scripts");
  for (const name of await readdir(sourceScripts)) {
    if (name.endsWith(".mjs")) {
      await copyFile(
        path.join(sourceScripts, name),
        path.join(directory, "scripts", name),
      );
    }
  }
  if (build) {
    await mkdir(path.join(directory, "dist"));
    await writeFile(
      path.join(directory, "dist/index.html"),
      "<!doctype html><title>Restart fixture</title>",
    );
  }
  if (tls) {
    await mkdir(path.join(directory, ".certs"));
    await writeFile(
      path.join(directory, ".certs/localhost-key.pem"),
      testTls.key,
    );
    await writeFile(path.join(directory, ".certs/localhost.pem"), testTls.cert);
  }
  return directory;
}

async function startListener(context) {
  const state = startChild(
    context,
    [
      "--input-type=module",
      "--eval",
      `
    import net from "node:net";
    const server = net.createServer(socket => socket.end("restart conflict fixture"));
    server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const message = await Promise.race([
    new Promise((resolve) => state.child.once("message", resolve)),
    state.exit.then((result) => {
      throw new Error(
        `Listener exited: ${JSON.stringify(result)} ${state.output()}`,
      );
    }),
    delay(5000, undefined, { ref: false }).then(() => {
      throw new Error("Listener did not start.");
    }),
  ]);
  assert.ok(Number.isInteger(message.port) && message.port > 1024);
  return { ...state, port: message.port, isAlive: () => !state.ended };
}

function startRestart(context, directory, args) {
  const env = { ...process.env };
  // The fixture must never load the live dApp's TLS overrides.
  delete env.DAPP_TLS_KEY_FILE;
  delete env.DAPP_TLS_CERT_FILE;
  return startChild(
    context,
    [path.join(directory, "scripts/restart.mjs"), ...args],
    {
      cwd: directory,
      env,
    },
  );
}

function getPage(port) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/client/root/?tenant=dev&itemId=123",
        ca: testTls.cert,
        servername: "localhost",
        agent: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode, body }),
        );
      },
    );
    request.setTimeout(1000, () =>
      request.destroy(new Error("Fixture HTTPS request timed out.")),
    );
    request.on("error", reject);
  });
}

async function waitForRestart(state, port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    assert.equal(state.ended, false, `Restart exited early: ${state.output()}`);
    try {
      const page = await getPage(port);
      if (page.status === 200 && page.body.includes("Restart fixture"))
        return page;
    } catch {
      // The old TCP fixture is deliberately not a TLS server.
    }
    await delay(100);
  }
  assert.fail(`Restart did not serve the fixture: ${state.output()}`);
}

async function assertRejected(state) {
  const result = await Promise.race([
    state.exit,
    delay(10000, undefined, { ref: false }).then(() => {
      throw new Error(
        `Restart did not reject invalid startup: ${state.output()}`,
      );
    }),
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.code, 1, state.output());
}

test(
  "npm restart replaces an isolated port listener with the HTTPS dApp and preserves another port",
  { timeout: 45000 },
  async (context) => {
    const packageJson = JSON.parse(
      await readFile(path.join(appDirectory, "package.json"), "utf8"),
    );
    assert.equal(packageJson.scripts.restart, "node scripts/restart.mjs");
    const directory = await createFixture(context);
    const conflicting = await startListener(context);
    const unrelated = await startListener(context);
    const restart = startRestart(context, directory, [
      "--port",
      String(conflicting.port),
    ]);
    const page = await waitForRestart(restart, conflicting.port);
    assert.equal(page.status, 200);
    await conflicting.exit;
    assert.equal(conflicting.isAlive(), false);
    assert.equal(
      unrelated.isAlive(),
      true,
      "Restart stopped an unrelated listener.",
    );
  },
);

test(
  "restart rejects invalid options before stopping an existing listener",
  { timeout: 45000 },
  async (context) => {
    const directory = await createFixture(context);
    const conflicting = await startListener(context);
    for (const extra of [
      ["--host", "0.0.0.0"],
      ["--unknown", "value"],
      ["--port", "0"],
    ]) {
      const restart = startRestart(context, directory, [
        "--port",
        String(conflicting.port),
        ...extra,
      ]);
      await assertRejected(restart);
      assert.equal(
        conflicting.isAlive(),
        true,
        `Invalid arguments stopped the listener: ${extra.join(" ")}`,
      );
    }
  },
);

test(
  "restart starts the HTTPS dApp when its selected port is already free",
  { timeout: 45000 },
  async (context) => {
    const directory = await createFixture(context);
    const reservation = await startListener(context);
    reservation.child.kill("SIGTERM");
    await reservation.exit;
    const restart = startRestart(context, directory, [
      "--port",
      String(reservation.port),
    ]);
    const page = await waitForRestart(restart, reservation.port);
    assert.equal(page.status, 200);
    assert.doesNotMatch(restart.output(), /Stopping .*PID/iu);
  },
);

test(
  "restart checks build and TLS before stopping an existing listener",
  { timeout: 45000 },
  async (context) => {
    const conflicting = await startListener(context);
    for (const options of [{ build: false }, { tls: false }]) {
      const directory = await createFixture(context, options);
      const restart = startRestart(context, directory, [
        "--port",
        String(conflicting.port),
      ]);
      await assertRejected(restart);
      assert.match(
        restart.output(),
        /build|dist|index\.html|TLS|certificate|HTTPS/iu,
      );
      assert.equal(
        conflicting.isAlive(),
        true,
        `Invalid startup stopped the listener: ${JSON.stringify(options)}`,
      );
    }
  },
);
