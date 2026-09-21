import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

// All wallet and API responses are fixtures; this browser never touches the game or Sui.
test("browser links compatible gates, unlinks, and recovers pending chain synchronization", {
  skip: !process.env.DAPP_BROWSER_SMOKE,
  timeout: 60000,
}, async t => {
  const cleanup = [];
  t.after(async () => {
    const errors = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Gate browser cleanup failed");
  });
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react-swc");
  const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const cache = path.join(root, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const profile = await mkdtemp(path.join(cache, "gate-browser-"));
  cleanup.push(async () => {
    const relative = path.relative(cache, path.resolve(profile));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const id = value => normalizeSuiAddress(`0x${value}`);
  const address = id("99");
  const config = { network: "localnet", rpcUrl: "http://127.0.0.1:1", packageId: id("a"), objectRegistryId: id("b"), energyConfigId: id("c"), fuelConfigId: id("d") };
  const assembly = { id: id("10"), itemId: "100", kind: "gate", name: "Home gate", ownerAddress: address };
  const auth = new Transaction();
  auth.setSender(address);
  auth.setGasOwner(address);
  auth.setGasBudget(1);
  auth.setGasPrice(1);
  auth.setGasPayment([{ objectId: id("66"), version: "1", digest: "11111111111111111111111111111111" }]);
  const authData = await auth.toJSON();
  const calls = [];
  let linked = false;
  let chainStatus = "synced";
  const gate = { itemID: 100, typeID: 872, name: "Home gate", solarSystemID: 300001, assemblyStatus: 1, destinationGateID: null, rangeLightYears: 4.5 };
  const destination = { ...gate, itemID: 101, name: "Remote gate", solarSystemID: 300002 };
  const readings = () => ({
    gate: { ...gate, destinationGateID: linked ? 101 : null },
    destination: linked ? { ...destination, destinationGateID: 100 } : null,
    candidates: [
      { ...destination, destinationGateID: linked ? 100 : null, distanceLightYears: 4.5, distanceMeters: "42573287126613600", eligible: !linked, reason: linked ? "SMART_GATE_ALREADY_LINKED" : null },
      { ...destination, itemID: 102, name: "Out of range gate", distanceLightYears: 5, distanceMeters: "47303652362904000", eligible: false, reason: "SMART_GATE_OUT_OF_RANGE" },
    ],
    rangeLightYears: 4.5,
    // A different chain value is informational: the client config will replace it.
    chain: { status: chainStatus, maxDistanceMeters: "9460730472580800", gateObjectID: assembly.id, linkedGateObjectID: linked ? id("11") : null },
  });
  // Give the injected Vite client its own port when browser fixtures run together.
  const hmrServer = http.createServer();
  await new Promise(resolve => hmrServer.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { hmrServer.close(resolve); hmrServer.closeAllConnections(); }));
  const vite = await createServer({
    configFile: false, root, envFile: false, logLevel: "error",
    cacheDir: path.join(profile, "vite-cache"),
    plugins: [react(), {
      name: "isolated-gate-fixture",
      resolveId(source) { if (source === "/gate-fixture.ts") return "\0gate-fixture"; },
      load(source) {
        if (source !== "\0gate-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { toBase64 } from '@mysten/sui/utils';
          import { GatePanel } from '/src/components/GatePanel.tsx';
          import '/src/main.css';
          window.testSignatures = 0;
          const wallet = { address: ${JSON.stringify(address)}, signTransaction: async tx => {
            window.testSignatures++;
            return { bytes: toBase64(await tx.build()), signature: 'fixture-owner-signature' };
          }};
          function Fixture() {
            const [busy, setBusy] = React.useState('');
            return React.createElement(GatePanel, {
              assembly: ${JSON.stringify(assembly)}, config: ${JSON.stringify(config)}, wallet,
              disabled: !!busy, visible: true, isOwner: true, onBusyChange: setBusy,
            });
          }
          createRoot(document.getElementById('root')).render(React.createElement(Fixture));
        `;
      },
    }],
    server: { middlewareMode: true, hmr: { server: hmrServer, host: "127.0.0.1", clientPort: hmrServer.address().port } },
  });
  cleanup.push(() => vite.close());
  const server = http.createServer(async (req, res) => {
    const send = data => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
    try {
      if (req.url === "/gate-test") {
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><title>Gate browser fixture</title></head><body><div id="root"></div><script type="module" src="/gate-fixture.ts"></script></body></html>'));
        return;
      }
      if (req.url.startsWith("/evejs/gates/")) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        calls.push({ url: req.url, body });
        if (req.url.endsWith("/auth/challenge")) return send({ success: true, data: { challengeId: "gate-challenge", transactionData: authData } });
        if (req.url.endsWith("/auth/session")) {
          assert.equal(body.signature, "fixture-owner-signature");
          return send({ success: true, data: { token: "gate-token", walletAddress: address, characterID: 200, expiresAt: Date.now() + 600000 } });
        }
        assert.equal(req.headers.authorization, "Bearer gate-token");
        if (req.url === "/evejs/gates/100/link") {
          assert.deepEqual(body, { destinationGateID: 101 });
          assert.equal(linked, false);
          linked = true;
          chainStatus = "pending";
        } else if (req.url === "/evejs/gates/100/unlink") {
          assert.deepEqual(body, { destinationGateID: 101 });
          assert.equal(linked, true);
          linked = false;
          chainStatus = "error";
        } else if (req.url === "/evejs/gates/101/sync") {
          assert.deepEqual(body, {});
          return send({ success: true, data: { ...readings(), gate: destination, destination: null, candidates: [] } });
        } else if (req.url === "/evejs/gates/100/sync") {
          assert.deepEqual(body, {});
          chainStatus = "synced";
        } else assert.equal(req.url, "/evejs/gates/100/status");
        return send({ success: true, data: readings() });
      }
      vite.middlewares(req, res);
    } catch (error) { res.statusCode = 500; send({ error: String(error) }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = spawn(process.env.DAPP_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  cleanup.push(async () => {
    if (browser.exitCode === null) {
      const closed = new Promise(resolve => browser.once("exit", resolve));
      browser.kill(); await closed;
    }
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Browser startup timeout")), 15000);
    browser.once("error", error => { clearTimeout(timer); reject(error); });
    browser.stderr.on("data", chunk => {
      output += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DevTools connection timed out")), 5000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = error => { clearTimeout(timer); reject(error); };
  });
  let next = 0;
  cleanup.push(async () => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++next, method: "Browser.close" }));
    await new Promise(resolve => setTimeout(resolve, 200));
    socket.close();
  });
  const pending = new Map();
  const errors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id) {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
  };
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools ${method} timed out`)); }, 5000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1050, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  async function until(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Browser condition timed out: ${expression}\n${await evaluate("document.body.innerText")}`);
  }
  const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)})`;
  await cdp("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/gate-test` }, sessionId);
  await until(`${button("Load gate links")} && !${button("Load gate links")}.disabled`);
  await evaluate(`${button("Load gate links")}.click()`);
  await until(`${button("Link gate")} && !${button("Link gate")}.disabled`);
  assert.equal(await evaluate("window.testSignatures"), 1);
  assert.match(await evaluate("document.body.innerText"), /Configured game range\n4.5 ly/);
  assert.match(await evaluate("document.body.innerText"), /Blockchain maximum\n1 ly/);
  assert.equal(await evaluate("[...document.querySelectorAll('tbody tr')][1].querySelector('button').disabled"), true);
  await evaluate(`${button("Sync gate")}.click()`);
  await until("document.body.innerText.includes('Gate 101 matches the blockchain.')");
  assert.equal(calls.filter(call => call.url === "/evejs/gates/101/sync").length, 1);
  if (process.env.DAPP_BROWSER_SCREENSHOT) {
    const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
    await writeFile(path.resolve(process.env.DAPP_BROWSER_SCREENSHOT), Buffer.from(screenshot.data, "base64"));
  }
  await evaluate(`${button("Link gate")}.click()`);
  await until("document.body.innerText.includes('PENDING') && document.body.innerText.includes('Linked to Remote gate in game.')");
  assert.equal(await evaluate(`${button("Link gate")}.disabled`), true);
  await evaluate(`${button("Sync chain")}.click()`);
  await until(`${button("Unlink gates")} && !${button("Unlink gates")}.disabled && document.body.innerText.includes('Gate 100 matches the blockchain.')`);
  assert.equal(calls.filter(call => call.url.endsWith("/link")).length, 1);
  await evaluate(`${button("Unlink gates")}.click()`);
  await until("document.body.innerText.includes('SYNC FAILED') && document.body.innerText.includes('This gate has no linked destination.')");
  await evaluate(`${button("Sync chain")}.click()`);
  await until(`${button("Link gate")} && !${button("Link gate")}.disabled`);
  assert.equal(calls.filter(call => call.url.endsWith("/unlink")).length, 1);
  assert.equal(calls.filter(call => call.url === "/evejs/gates/100/sync").length, 2);
  assert.equal(await evaluate("window.testSignatures"), 1, "sync retries reuse auth without repeating pair changes");
  assert.deepEqual(errors, []);
});
