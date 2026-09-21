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
test("browser starts server Industry jobs, keeps production live, and isolates assembly changes", {
  skip: !process.env.DAPP_BROWSER_SMOKE,
  timeout: 90000,
}, async t => {
  const cleanup = [];
  t.after(async () => {
    const errors = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Industry browser cleanup failed");
  });
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react-swc");
  const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const cache = path.join(root, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const profile = await mkdtemp(path.join(cache, "industry-browser-"));
  cleanup.push(async () => {
    const relative = path.relative(cache, path.resolve(profile));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const id = value => normalizeSuiAddress(`0x${value}`);
  const address = id("99");
  const config = { network: "localnet", rpcUrl: "http://127.0.0.1:1", packageId: id("a"), objectRegistryId: id("b"), energyConfigId: id("c"), fuelConfigId: id("d") };
  const assembly = { id: id("10"), itemId: "100", kind: "industry", name: "Home Industry", ownerAddress: address };
  const otherAssembly = { ...assembly, id: id("11"), itemId: "101", name: "Remote Industry" };
  const auth = new Transaction();
  auth.setSender(address);
  auth.setGasOwner(address);
  auth.setGasBudget(1);
  auth.setGasPrice(1);
  auth.setGasPayment([{ objectId: id("66"), version: "1", digest: "11111111111111111111111111111111" }]);
  const authData = await auth.toJSON();
  const calls = [];
  const serverErrors = [];
  let production = null;
  let inputQuantity = "100";
  let outputQuantity = "1";
  let failNext = 0;
  let delayNext = false;
  let delayedResponse;
  let delayNextAuth = false;
  let delayedAuthResponse;
  let chainStatus = "synced";
  let startFailure = false;
  let delayNextStart = false;
  let delayedStartResponse;
  let storageQuantity = 30;
  let delayNextTransfer = false;
  let delayedTransferResponse;
  let transferFailure = false;
  const blueprintHash = "a".repeat(64);
  const readings = (itemId = "100", blueprintId = itemId === "100" ? "900" : "901") => ({
    blueprintHash,
    facility: {
      itemId, typeId: 9001, status: 2, production,
      snapshot: {
        owner_id: "200", solar_system_id: "300001", blueprint_id: blueprintId, run_time: "60",
        inputs: [{ type_id: "34", quantity: inputQuantity }],
        outputs: [{ type_id: "35", quantity: outputQuantity }],
        blueprint_inputs: [{ type_id: "34", quantity: "2", max_quantity: "1000" }],
        blueprint_outputs: [{ type_id: "35", quantity: "1", max_quantity: "100" }],
      },
    },
    production,
    chain: {
      status: chainStatus, assemblyObjectID: itemId === "100" ? assembly.id : otherAssembly.id,
      industryObjectID: id("55"), revision: "1", observedAtMs: String(Date.now()), syncedAtMs: String(Date.now()),
      productionMirrored: true, production,
    },
  });
  // Vite still injects its WebSocket client with hmr:false. A dedicated dynamic
  // port keeps concurrent browser fixtures away from the shared 24678 default.
  const hmrServer = http.createServer();
  await new Promise(resolve => hmrServer.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { hmrServer.close(resolve); hmrServer.closeAllConnections(); }));
  const vite = await createServer({
    configFile: false, root, envFile: false, logLevel: "error", cacheDir: path.join(profile, "vite-cache"),
    plugins: [react(), {
      name: "isolated-industry-fixture",
      resolveId(source) { if (source === "/industry-fixture.ts") return "\0industry-fixture"; },
      load(source) {
        if (source !== "\0industry-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { toBase64 } from '@mysten/sui/utils';
          import { IndustryPanel } from '/src/components/IndustryPanel.tsx';
          import '/src/main.css';
          window.testSignatures = 0;
          window.testDocumentVisibility = 'visible';
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.testDocumentVisibility });
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testDocumentVisibility === 'hidden' });
          window.testSetDocumentVisibility = value => {
            window.testDocumentVisibility = value;
            document.dispatchEvent(new Event('visibilitychange'));
          };
          const wallet = { address: ${JSON.stringify(address)}, signTransaction: async tx => {
            window.testSignatures++;
            return { bytes: toBase64(await tx.build()), signature: 'fixture-owner-signature' };
          }};
          const config = ${JSON.stringify(config)};
          function Fixture() {
            const [visible, setVisible] = React.useState(true);
            const [assembly, setAssembly] = React.useState(${JSON.stringify(assembly)});
            window.testSetVisible = setVisible;
            window.testSwitchAssembly = (itemId = '101') => setAssembly(itemId === '100' ? ${JSON.stringify(assembly)} : ${JSON.stringify(otherAssembly)});
            return React.createElement('div', { hidden: !visible, 'data-facility': assembly.itemId }, React.createElement(IndustryPanel, {
              assembly, config, wallet,
              disabled: false, visible, isOwner: true,
            }));
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
      if (req.url === "/industry-test") {
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><title>Industry browser fixture</title></head><body><div id="root"></div><script type="module" src="/industry-fixture.ts"></script></body></html>'));
        return;
      }
      if (req.url.startsWith("/evejs/industry/")) {
        assert.equal(req.method, "POST");
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        calls.push({ url: req.url, body, at: Date.now() });
        if (req.url.endsWith("/auth/challenge")) {
          assert.equal(body.walletAddress, address);
          return send({ success: true, data: { challengeId: "industry-challenge", transactionData: authData, expiresAt: Date.now() + 60000 } });
        }
        if (req.url.endsWith("/auth/session")) {
          assert.equal(body.signature, "fixture-owner-signature");
          const reply = () => send({ success: true, data: { token: "industry-token", walletAddress: address, characterID: 200, expiresAt: Date.now() + 600000 } });
          if (delayNextAuth) {
            delayNextAuth = false;
            delayedAuthResponse = reply;
            return;
          }
          return reply();
        }
        assert.equal(req.headers.authorization, "Bearer industry-token");
        if (req.url.endsWith("/storage-sync")) {
          assert.deepEqual(body, { storageUnitID: "300" });
          return send({ success: true, data: { status: "synced", industryStatus: "synced", storageStatus: "synced" } });
        }
        if (req.url.endsWith("/storage")) {
          assert.deepEqual(body, {});
          return send({ success: true, data: { storageUnits: [{ storageUnitID: 300, name: "Nearby storage", capacity: 1000, usedVolume: storageQuantity * 0.1,
            items: [{ itemID: 301, typeID: 34, name: "Material", quantity: Math.min(10, storageQuantity), unitVolume: 0.1 },
              { itemID: 302, typeID: 34, name: "Material", quantity: storageQuantity - Math.min(10, storageQuantity), unitVolume: 0.1 }].filter(item => item.quantity > 0),
          }] } });
        }
        if (req.url.endsWith("/transfer")) {
          assert.match(body.requestID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
          assert.equal(body.storageUnitID, "300");
          assert.ok(["deposit", "withdraw"].includes(body.direction));
          assert.ok(["inputs", "outputs"].includes(body.side));
          assert.ok(Number.isSafeInteger(Number(body.quantity)) && Number(body.quantity) > 0);
          if (transferFailure) {
            transferFailure = false;
            res.statusCode = 500;
            return send({ success: false, errorMsg: "TRANSFER_FAILED", message: "Fixture transfer result unavailable." });
          }
          if (body.direction === "deposit") {
            assert.equal(body.side, "inputs");
            assert.equal(body.typeID, "34");
            storageQuantity -= Number(body.quantity);
            inputQuantity = String(Number(inputQuantity) + Number(body.quantity));
          } else if (body.side === "inputs") {
            assert.equal(body.typeID, "34");
            storageQuantity += Number(body.quantity);
            inputQuantity = String(Number(inputQuantity) - Number(body.quantity));
          } else {
            assert.equal(body.typeID, "35");
            outputQuantity = String(Number(outputQuantity) - Number(body.quantity));
          }
          const reply = () => send({ success: true, data: {
            requestID: body.requestID, gameCommitted: true, storageUnitID: 300,
            direction: body.direction, side: body.side, items: { [body.typeID]: Number(body.quantity) },
            chain: { status: "pending", industryStatus: "synced", storageStatus: "pending" },
          } });
          if (delayNextTransfer) { delayNextTransfer = false; delayedTransferResponse = reply; return; }
          return reply();
        }
        if (req.url.endsWith("/start")) {
          assert.match(req.url, /^\/evejs\/industry\/(100|101)\/start$/);
          const itemId = req.url.split("/")[3];
          assert.deepEqual(Object.keys(body).sort(), ["blueprintHash", "blueprintID", "expectedJobID", "runs"]);
          assert.equal(body.blueprintID, itemId === "100" ? "900" : "901");
          assert.equal(body.blueprintHash, blueprintHash);
          assert.equal(body.expectedJobID, production?.job_id ?? null);
          assert.ok(body.runs === null || (typeof body.runs === "string" && /^[1-9]\d*$/.test(body.runs) && Number.isSafeInteger(Number(body.runs))));
          if (startFailure) {
            startFailure = false;
            res.statusCode = 409;
            return send({ success: false, errorMsg: "INDUSTRY_START_REJECTED", message: "Fixture start rejected. Refresh the facility before starting again." });
          }
          const startedAt = Date.now();
          production = {
            job_id: String(BigInt(body.expectedJobID || "0") + 1n), state: "RUNNING", requested_runs: body.runs, completed_runs: "0",
            run_started_at_ms: String(startedAt), run_end_at_ms: String(startedAt + 60000), stop_reason: null,
          };
          const data = { ...readings(itemId), gameCommitted: true, startedJobID: production.job_id };
          const reply = () => send({ success: true, data });
          if (delayNextStart) {
            delayNextStart = false;
            delayedStartResponse = reply;
            return;
          }
          return reply();
        }
        assert.deepEqual(body, {});
        if (req.url.endsWith("/sync")) {
          assert.match(req.url, /^\/evejs\/industry\/(100|101)\/sync$/);
          chainStatus = "synced";
          return send({ success: true, data: readings(req.url.split("/")[3]) });
        }
        assert.match(req.url, /^\/evejs\/industry\/(100|101)\/status$/);
        if (failNext) {
          res.statusCode = failNext;
          failNext = 0;
          return send({ success: false, errorMsg: res.statusCode === 401 ? "AUTH_EXPIRED" : "INDUSTRY_REQUEST_FAILED", message: res.statusCode === 401 ? "Fixture wallet session expired." : "Fixture temporary Industry outage." });
        }
        if (delayNext && req.url === "/evejs/industry/100/status") {
          delayNext = false;
          const old = readings("100", "777");
          delayedResponse = () => send({ success: true, data: old });
          return;
        }
        return send({ success: true, data: readings(req.url.split("/")[3]) });
      }
      vite.middlewares(req, res);
    } catch (error) { serverErrors.push(String(error)); res.statusCode = 500; send({ error: String(error) }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = spawn(process.env.DAPP_BROWSER_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  // Register before Browser.close can exit the process. exitCode stays null
  // after signal termination, so awaiting a newly registered exit event hangs.
  const browserClosed = new Promise(resolve => {
    browser.once("exit", resolve);
    browser.once("error", resolve);
  });
  cleanup.push(async () => {
    if (browser.exitCode === null && browser.signalCode === null) browser.kill();
    let timer;
    try {
      await Promise.race([
        browserClosed,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture browser did not exit during cleanup")), 5000); }),
      ]);
    } finally {
      clearTimeout(timer);
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
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1050, height: 1200, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(expression, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await pause(100);
    }
    throw new Error(`Browser condition timed out: ${expression}\n${await evaluate("document.body.innerText")}\nBrowser errors: ${JSON.stringify(errors)}\nServer errors: ${JSON.stringify(serverErrors)}`);
  }
  async function untilCall(predicate) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await pause(50);
    }
    throw new Error("Expected Industry API request did not arrive");
  }
  const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)})`;
  const text = "document.querySelector('[aria-label=\"Smart Industry status\"]')?.innerText || document.body.innerText";
  const statusCalls = () => calls.filter(call => call.url.endsWith("/status")).length;
  const startCalls = () => calls.filter(call => call.url.endsWith("/start"));
  const transferCalls = () => calls.filter(call => call.url.endsWith("/transfer"));
  const runsInput = "[...document.querySelectorAll('input')].find(input => [...(input.labels || [])].some(label => label.textContent.includes('Number of runs')))";
  const continuousInput = "[...document.querySelectorAll('input[type=checkbox]')].find(input => [...(input.labels || [])].some(label => label.textContent.includes('Continuous production')))";
  const setRuns = value => evaluate(`(() => {
    const input = ${runsInput};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const load = "Load industry status";
  const refresh = "Refresh industry status";
  const startJob = "Start production";
  await cdp("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/industry-test` }, sessionId);
  await until(`${button(load)} && !${button(load)}.disabled`);
  assert.equal(statusCalls(), 0, "reading owner inventory requires explicit initial authorization");
  await evaluate(`${button(load)}.click()`);
  await until(`(${text}).includes('No active job') && (${text}).includes('Blueprint #900')`);
  assert.equal(await evaluate("window.testSignatures"), 1);

  const transferForm = "document.querySelector('[aria-label=\"Transfer Industry inventory\"]')";
  const setTransferField = (name, value) => evaluate(`(() => {
    const input = ${transferForm}.querySelector('[name=${name}]');
    Object.getOwnPropertyDescriptor(input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(`!!${transferForm}?.querySelector('option[value="300"]')`);
  await setTransferField("storageUnitID", "300");
  await until(`${transferForm}.innerText.includes('30 available')`);
  await setTransferField("typeID", "34");
  await setTransferField("transferQuantity", "31");
  await until(`${button("Move items")}.disabled`);
  assert.equal(transferCalls().length, 0, "oversized transfers never reach the server");
  await setTransferField("transferQuantity", "15");
  await until(`!${button("Move items")}.disabled`);
  delayNextTransfer = true;
  const beforeTransferReads = statusCalls();
  const beforeStorageReads = calls.filter(call => call.url.endsWith("/storage")).length;
  await evaluate(`(() => { const button = ${button("Move items")}; button.click(); button.click(); button.click(); })()`);
  await untilCall(() => !!delayedTransferResponse);
  await until(`${button("Moving items…")}?.matches(':disabled')`);
  assert.equal(transferCalls().length, 1, "rapid clicks only transfer once");
  assert.deepEqual({ ...transferCalls()[0].body, requestID: "receipt" }, { requestID: "receipt", storageUnitID: "300", direction: "deposit", side: "inputs", typeID: "34", quantity: "15" });
  delayedTransferResponse();
  await until(`(${text}).includes('15 items moved from storage to Industry inputs on the server.') && (${text}).includes('storage: pending')`);
  await untilCall(() => statusCalls() > beforeTransferReads && calls.filter(call => call.url.endsWith("/storage")).length > beforeStorageReads);
  await until(`${transferForm}.innerText.includes('15 available')`);
  assert.equal(await evaluate("window.testSignatures"), 1, "transfers reuse the owner-authorized session");

  await until(`${button("Sync both inventories")} && !${button("Sync both inventories")}.disabled`);
  await evaluate(`${button("Sync both inventories")}.click()`);
  await until(`(${text}).includes('both blockchain inventories are synchronized.') && !${button("Sync both inventories")}`);
  assert.equal(transferCalls().length, 1, "synchronization never repeats the game transfer");
  assert.equal(calls.filter(call => call.url.endsWith("/storage-sync")).length, 1);
  await until(`!${transferForm}.querySelector('fieldset').disabled`);

  // Withdraw inputs and outputs through the same form, with a fresh request for each action.
  await setTransferField("direction", "withdraw");
  await setTransferField("side", "inputs");
  await setTransferField("typeID", "34");
  await setTransferField("transferQuantity", "15");
  await until(`!${button("Move items")}.matches(':disabled')`);
  await evaluate(`${button("Move items")}.click()`);
  await until(`(${text}).includes('15 items moved from Industry inputs to storage on the server.')`);
  await until(`!${transferForm}.querySelector('fieldset').disabled`);
  outputQuantity = "2";
  await until(`${button(refresh)} && !${button(refresh)}.disabled`);
  await evaluate(`${button(refresh)}.click()`);
  await until("[...document.querySelectorAll('tbody tr')].some(row => row.cells[0]?.textContent.includes('35') && row.cells[1]?.textContent === '2')");
  await setTransferField("side", "outputs");
  await setTransferField("typeID", "35");
  await setTransferField("transferQuantity", "1");
  await until(`!${button("Move items")}.matches(':disabled')`);
  await evaluate(`${button("Move items")}.click()`);
  await until(`(${text}).includes('1 item moved from Industry outputs to storage on the server.')`);
  await until(`!${transferForm}.querySelector('fieldset').disabled`);
  assert.equal(new Set(transferCalls().map(call => call.body.requestID)).size, 3);

  // Unknown results refresh inventories and retain the warning without resubmitting.
  transferFailure = true;
  await until(`!${button("Move items")}.matches(':disabled')`);
  await evaluate(`${button("Move items")}.click()`);
  await until(`(${text}).includes('Fixture transfer result unavailable.') && (${text}).includes('will not be retried automatically')`);
  await pause(3300);
  assert.equal(transferCalls().length, 4, "uncertain transfer requests never auto retry");

  // Validate the form before sending any owner-authorized mutation.
  await until(`${button(startJob)} && !${button(startJob)}.disabled && !!${runsInput}`);
  await setRuns("0");
  await until(`${button(startJob)}.disabled`);
  await setRuns("9007199254740992");
  await until(`${button(startJob)}.disabled`);
  assert.equal(startCalls().length, 0, "invalid run counts never reach the game server");
  await setRuns("3");
  await until(`!${button(startJob)}.disabled`);

  // Repeated clicks while the game request is pending must create exactly one job.
  chainStatus = "pending";
  delayNextStart = true;
  await evaluate(`(() => { const button = ${button(startJob)}; button.click(); button.click(); button.click(); })()`);
  await untilCall(() => !!delayedStartResponse);
  await until(`${button("Starting production…")}?.disabled`);
  assert.equal(startCalls().length, 1, "rapid clicks issue one start request");
  assert.deepEqual(startCalls()[0].body, { blueprintID: "900", blueprintHash, runs: "3", expectedJobID: null });
  delayedStartResponse();
  await until(`(${text}).includes('Job #1 started on the server.') && (${text}).includes('RUNNING') && (${text}).includes('PENDING')`);
  assert.equal(await evaluate("[...document.querySelectorAll('dt')].find(dt => dt.textContent === 'Requested runs')?.nextElementSibling?.textContent"), "3");
  assert.equal(await evaluate("window.testSignatures"), 1, "starting a job reuses the owner session");

  await until(`${button("Sync blockchain")} && !${button("Sync blockchain")}.disabled`);
  await evaluate(`${button("Sync blockchain")}.click()`);
  await until(`(${text}).includes('SYNCED') && !(${text}).includes('PENDING')`);
  assert.equal(calls.filter(call => call.url.endsWith("/sync")).length, 1);
  assert.equal(startCalls().length, 1, "blockchain retries do not start another game job");

  production = { ...production, state: "STOPPED", completed_runs: "3", stop_reason: "COMPLETED" };
  await until(`${button(refresh)} && !${button(refresh)}.disabled`);
  await evaluate(`${button(refresh)}.click()`);
  await until(`(${text}).includes('STOPPED') && !${button(startJob)}.disabled`);
  await evaluate(`${continuousInput}.click()`);
  await until(`${continuousInput}.checked`);

  // A status request made before the start must not overwrite its committed result.
  delayNext = true;
  await until(`!${button(refresh)}.disabled`);
  await evaluate(`${button(refresh)}.click()`);
  await untilCall(() => !!delayedResponse);
  await until(`!${button(startJob)}.disabled`);
  await evaluate(`${button(startJob)}.click()`);
  await until(`(${text}).includes('Job #2 started on the server.') && (${text}).includes('RUNNING')`);
  assert.deepEqual(startCalls()[1].body, { blueprintID: "900", blueprintHash, runs: null, expectedJobID: "1" });
  delayedResponse();
  delayedResponse = undefined;
  await pause(400);
  assert.ok((await evaluate(text)).includes("Blueprint #900"));
  assert.ok(!(await evaluate(text)).includes("Blueprint #777"), "a pre-start status cannot overwrite the successful start");
  assert.equal(await evaluate("[...document.querySelectorAll('dt')].find(dt => dt.textContent === 'Requested runs')?.nextElementSibling?.textContent"), "Continuous");

  // A rejected mutation refreshes readings, preserves its explanation, and never retries itself.
  production = { ...production, state: "STOPPED", stop_reason: "USER_REQUESTED" };
  await until(`${button(refresh)} && !${button(refresh)}.disabled`);
  await evaluate(`${button(refresh)}.click()`);
  await until(`(${text}).includes('STOPPED') && !${button(startJob)}.disabled`);
  startFailure = true;
  const beforeFailedStartRead = statusCalls();
  await evaluate(`${button(startJob)}.click()`);
  await until("document.body.innerText.includes('Fixture start rejected.')");
  await untilCall(() => statusCalls() > beforeFailedStartRead);
  await pause(3300);
  assert.equal(startCalls().length, 3, "a failed start is not automatically submitted again");
  assert.ok((await evaluate(text)).includes("Fixture start rejected."), "refreshing readings preserves the start failure");
  assert.equal(await evaluate("window.testSignatures"), 1);

  // Simulate a new request arriving from the game while the tab remains open.
  const started = Date.now();
  production = { job_id: "700", state: "RUNNING", requested_runs: "4", completed_runs: "0", run_started_at_ms: String(started), run_end_at_ms: String(started + 60000), stop_reason: null };
  inputQuantity = "98";
  await until(`(${text}).includes('RUNNING') && (${text}).includes('700')`);
  assert.equal(await evaluate("window.testSignatures"), 1, "new requests appear without another wallet approval");
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await writeFile(path.join(cache, "industry-browser.png"), Buffer.from(screenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sessionId);
  await until("window.innerWidth === 390");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "the Industry panel fits a narrow viewport");
  const mobileScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await writeFile(path.join(cache, "industry-browser-mobile.png"), Buffer.from(mobileScreenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1050, height: 1200, deviceScaleFactor: 1, mobile: false }, sessionId);

  production = { ...production, state: "STOPPED", completed_runs: "4", stop_reason: "COMPLETED" };
  inputQuantity = "92";
  outputQuantity = "5";
  await until(`(${text}).includes('STOPPED') && [...document.querySelectorAll('dt')].some(dt => dt.textContent === 'Completed runs' && dt.nextElementSibling?.textContent === '4')`);
  const rows = await evaluate("[...document.querySelectorAll('tbody tr')].map(row => [...row.cells].map(cell => cell.textContent))");
  assert.ok(rows.some(row => row[0].includes("34") && row[1] === "92"), "completed runs update input inventory");
  assert.ok(rows.some(row => row[0].includes("35") && row[1] === "5"), "completed runs update output inventory");
  assert.equal(await evaluate("window.testSignatures"), 1);

  // Both the panel's selected state and browser visibility suspend periodic reads.
  await evaluate("window.testSetVisible(false)");
  await pause(200);
  const hiddenCalls = statusCalls();
  await pause(3300);
  assert.equal(statusCalls(), hiddenCalls, "inactive tabs stop polling");
  outputQuantity = "6";
  await evaluate("window.testSetVisible(true)");
  await until("[...document.querySelectorAll('tbody tr')].some(row => row.cells[0]?.textContent.includes('35') && row.cells[1]?.textContent === '6')", 2000);
  await evaluate("window.testSetDocumentVisibility('hidden')");
  await pause(200);
  const backgroundCalls = statusCalls();
  await pause(3300);
  assert.equal(statusCalls(), backgroundCalls, "background documents stop polling");
  outputQuantity = "7";
  await evaluate("window.testSetDocumentVisibility('visible')");
  await until("[...document.querySelectorAll('tbody tr')].some(row => row.cells[0]?.textContent.includes('35') && row.cells[1]?.textContent === '7')", 2000);

  failNext = 500;
  await until("document.body.innerText.includes('Fixture temporary Industry outage.')");
  outputQuantity = "8";
  await until("[...document.querySelectorAll('tbody tr')].some(row => row.cells[0]?.textContent.includes('35') && row.cells[1]?.textContent === '8') && !document.body.innerText.includes('Fixture temporary Industry outage.')");
  assert.equal(await evaluate("window.testSignatures"), 1, "transient failures retry the current session");

  failNext = 401;
  await until("document.body.innerText.includes('expired')");
  const expiredCalls = statusCalls();
  await pause(3300);
  assert.equal(statusCalls(), expiredCalls, "expired sessions stop automatic requests");
  assert.equal(await evaluate("window.testSignatures"), 1, "background requests never open wallet approvals");
  await until(`${button(refresh)} && !${button(refresh)}.disabled`);
  await evaluate(`${button(refresh)}.click()`);
  await until("window.testSignatures === 2 && !document.body.innerText.includes('expired')");

  // Complete a previous facility's delayed request only after the new context has loaded.
  delayNext = true;
  await until(`${button(refresh)} && !${button(refresh)}.disabled`);
  await evaluate(`${button(refresh)}.click()`);
  await untilCall(() => !!delayedResponse);
  await evaluate("window.testSwitchAssembly()");
  await until(`${button(load)} && !${button(load)}.disabled`);
  assert.ok(!(await evaluate(text)).includes("Blueprint #900"), "switching assemblies clears previous readings");
  await evaluate(`${button(load)}.click()`);
  await until(`(${text}).includes('Blueprint #901')`);
  delayedResponse();
  await pause(400);
  const finalText = await evaluate(text);
  assert.ok(finalText.includes("Blueprint #901"));
  assert.ok(!finalText.includes("Blueprint #777"), "late responses cannot replace the current assembly's readings");
  assert.equal(await evaluate("window.testSignatures"), 3, "the new assembly context requires explicit owner authorization");

  // A connection approved for an obsolete context must not start polling the new one.
  delayNextAuth = true;
  await evaluate("window.testSwitchAssembly('100')");
  await until(`${button(load)} && !${button(load)}.disabled`);
  const beforeObsoleteAuth = statusCalls();
  await evaluate(`${button(load)}.click()`);
  await untilCall(() => !!delayedAuthResponse);
  await evaluate("window.testSwitchAssembly('101')");
  await until("!!document.querySelector('[data-facility=\"101\"]')");
  delayedAuthResponse();
  await until(`${button(load)} && !${button(load)}.disabled`);
  await pause(400);
  assert.equal(statusCalls(), beforeObsoleteAuth, "a late authorization does not load another assembly");
  assert.equal(await evaluate("window.testSignatures"), 4);
  assert.ok(!(await evaluate(text)).includes("Blueprint #"), "the new context stays unloaded until explicitly authorized");

  // A server mutation can complete after navigation without changing the new facility's UI.
  await evaluate("window.testSwitchAssembly('100')");
  await until(`${button(load)} && !${button(load)}.disabled`);
  await evaluate(`${button(load)}.click()`);
  await until(`(${text}).includes('Blueprint #900') && ${button(startJob)} && !${button(startJob)}.disabled`);
  delayedStartResponse = undefined;
  delayNextStart = true;
  await evaluate(`${button(startJob)}.click()`);
  await untilCall(() => !!delayedStartResponse);
  await evaluate("window.testSwitchAssembly('101')");
  await until("!!document.querySelector('[data-facility=\"101\"]')");
  assert.ok(!(await evaluate(text)).includes("Blueprint #900"), "navigating away clears the starting facility's readings");
  delayedStartResponse();
  await until(`${button(load)} && !${button(load)}.disabled`);
  assert.ok(!(await evaluate(text)).includes("Blueprint #900"), "a late start does not load the obsolete facility");
  assert.ok(!(await evaluate(text)).includes("Job #701 started on the server."), "a late start does not confirm in the new context");
  await evaluate(`${button(load)}.click()`);
  await until(`(${text}).includes('Blueprint #901')`);
  await pause(400);
  const afterObsoleteStart = await evaluate(text);
  assert.ok(afterObsoleteStart.includes("Blueprint #901"));
  assert.ok(!afterObsoleteStart.includes("Blueprint #900"), "a late start result cannot replace the selected facility");
  assert.ok(!afterObsoleteStart.includes("Job #701 started on the server."), "start confirmation belongs only to its originating facility");
  assert.equal(startCalls().length, 4);
  assert.equal(await evaluate("window.testSignatures"), 6);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(errors, []);
});
