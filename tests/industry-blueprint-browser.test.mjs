import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

// All game, chain, and wallet responses are local fixtures. No live writes occur.
test("browser empties both blueprint inventories, changes recipes, and queues guarded actions", {
  skip: !process.env.DAPP_BROWSER_SMOKE, timeout: 60000,
}, async t => {
  const cleanup = [];
  t.after(async () => {
    const errors = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Blueprint browser cleanup failed");
  });
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react-swc");
  const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const cache = path.join(root, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const profile = await mkdtemp(path.join(cache, "industry-blueprint-browser-"));
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
  const firstHash = "a".repeat(64);
  const secondHash = "b".repeat(64);
  let activeBlueprint = "900";
  let inputQuantity = "20";
  let outputQuantity = "3";
  let production = null;
  let capacityFailure = false;
  let delayNextEmpty = false;
  let delayedEmptyResponse;
  let delayNextBlueprint = false;
  let delayedBlueprintResponse;
  const slot = (type, quantity, max = "1000") => ({ type_id: type, quantity, max_quantity: max });
  const catalog = [
    { blueprintID: "900", blueprintHash: firstHash, name: "Basic material", runTime: "60", inputs: [slot("34", "2")], outputs: [slot("35", "1")] },
    { blueprintID: "901", blueprintHash: secondHash, name: "Advanced material", runTime: "120", inputs: [slot("36", "5")], outputs: [slot("37", "2")] },
  ];
  const readings = (itemId = "100") => {
    const blueprint = catalog.find(entry => entry.blueprintID === activeBlueprint);
    return {
      blueprintHash: blueprint.blueprintHash,
      facility: { itemId, typeId: 9001, status: 2, production, snapshot: {
        owner_id: "200", solar_system_id: "300001", blueprint_id: activeBlueprint, run_time: blueprint.runTime,
        inputs: inputQuantity === "0" ? [] : [{ type_id: "34", quantity: inputQuantity }],
        outputs: outputQuantity === "0" ? [] : [{ type_id: "35", quantity: outputQuantity }],
        blueprint_inputs: blueprint.inputs, blueprint_outputs: blueprint.outputs,
      } },
      production,
      chain: { status: "synced", assemblyObjectID: itemId === "100" ? assembly.id : otherAssembly.id,
        industryObjectID: id("55"), revision: "1", productionMirrored: true, production },
    };
  };
  const hmrServer = http.createServer();
  await new Promise(resolve => hmrServer.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { hmrServer.close(resolve); hmrServer.closeAllConnections(); }));
  const vite = await createServer({
    configFile: false, root, envFile: false, logLevel: "error", cacheDir: path.join(profile, "vite-cache"),
    plugins: [react(), {
      name: "isolated-blueprint-fixture",
      resolveId(source) { if (source === "/blueprint-fixture.ts") return "\0blueprint-fixture"; },
      load(source) {
        if (source !== "\0blueprint-fixture") return;
        return `
          import React, { useSyncExternalStore } from 'react';
          import { createRoot } from 'react-dom/client';
          import { toBase64 } from '@mysten/sui/utils';
          import { IndustryPanel } from '/src/components/IndustryPanel.tsx';
          import { createTaskQueue } from '/src/tasks/queue.ts';
          import '/src/main.css';
          window.testQueue = [];
          window.testSignatures = 0;
          const wallet = { address: ${JSON.stringify(address)}, signTransaction: async tx => {
            window.testSignatures++;
            return { bytes: toBase64(await tx.build()), signature: 'fixture-owner-signature' };
          }};
          const config = ${JSON.stringify(config)};
          const queue = createTaskQueue();
          window.testRemoveTask = id => queue.remove(id);
          window.testMoveTask = (id, direction) => queue.move(id, direction);
          window.testClearQueue = () => queue.clearPending();
          window.testForeignTasks = () => {
            const { title, details, assembly, operation } = window.testInitialQueue[1];
            const draft = { title, details, assembly, operation };
            queue.enqueue(draft, { ...wallet }, wallet.address);
            queue.enqueue({ ...draft, assembly: ${JSON.stringify(otherAssembly)} }, wallet, wallet.address);
          };
          function Fixture() {
            const [assembly, setAssembly] = React.useState(${JSON.stringify(assembly)});
            const queueState = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
            window.testQueue = queueState.tasks;
            window.testSwitchAssembly = () => setAssembly(${JSON.stringify(otherAssembly)});
            return React.createElement('div', { 'data-facility': assembly.itemId }, React.createElement(IndustryPanel, {
              assembly, config, wallet, disabled: false, visible: true, isOwner: true,
              queuedTasks: queueState.tasks,
              onQueueTask: task => queue.enqueue(task, wallet, wallet.address),
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
    const ok = data => send({ success: true, data });
    try {
      if (req.url === "/industry-test") {
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><title>Blueprint fixture</title></head><body><div id="root"></div><script type="module" src="/blueprint-fixture.ts"></script></body></html>'));
        return;
      }
      if (req.url.startsWith("/evejs/industry/")) {
        assert.equal(req.method, "POST");
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        calls.push({ url: req.url, body });
        if (req.url.endsWith("/auth/challenge")) return ok({ challengeId: "blueprint-challenge", transactionData: authData, expiresAt: Date.now() + 60000 });
        if (req.url.endsWith("/auth/session")) return ok({ token: "blueprint-token", walletAddress: address, characterID: 200, expiresAt: Date.now() + 600000 });
        assert.equal(req.headers.authorization, "Bearer blueprint-token");
        if (req.url.endsWith("/blueprints")) return ok({ blueprints: catalog });
        if (req.url.endsWith("/storage-sync")) {
          assert.deepEqual(body, { storageUnitID: "300" });
          return ok({ status: "synced", industryStatus: "synced", storageStatus: "synced" });
        }
        if (req.url.endsWith("/storage")) return ok({ storageUnits: [{ storageUnitID: 300, name: "Nearby storage", capacity: 1000, usedVolume: 4,
          items: [{ itemID: 301, typeID: 34, name: "Basic input", quantity: 20, unitVolume: 0.1 },
            { itemID: 302, typeID: 36, name: "Advanced input", quantity: 20, unitVolume: 0.1 }],
        }] });
        if (req.url.endsWith("/empty") || req.url.endsWith("/blueprint")) {
          assert.match(body.requestID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
          assert.equal(body.expectedBlueprintID, activeBlueprint);
          assert.equal(body.expectedBlueprintHash, activeBlueprint === "900" ? firstHash : secondHash);
          assert.equal(body.expectedJobID, production?.job_id ?? null);
          assert.ok(!production || production.state === "STOPPED");
          if (req.url.endsWith("/empty")) {
            assert.equal(body.storageUnitID, "300");
            if (capacityFailure) {
              capacityFailure = false;
              res.statusCode = 409;
              return send({ success: false, errorMsg: "STORAGE_CAPACITY_EXCEEDED", message: "Fixture storage cannot fit every material." });
            }
            const result = { requestID: body.requestID, gameCommitted: true, storageUnitID: 300,
              inputs: { 34: Number(inputQuantity) }, outputs: { 35: Number(outputQuantity) },
              chain: { status: "pending", industryStatus: "synced", storageStatus: "pending" } };
            inputQuantity = "0";
            outputQuantity = "0";
            if (delayNextEmpty) { delayNextEmpty = false; delayedEmptyResponse = () => ok(result); return; }
            return ok(result);
          }
          assert.equal(inputQuantity, "0");
          assert.equal(outputQuantity, "0");
          assert.equal(body.blueprintHash, body.blueprintID === "900" ? firstHash : secondHash);
          activeBlueprint = body.blueprintID;
          const result = { ...readings(), requestID: body.requestID, gameCommitted: true, selectedBlueprintID: activeBlueprint };
          if (delayNextBlueprint) { delayNextBlueprint = false; delayedBlueprintResponse = () => ok(result); return; }
          return ok(result);
        }
        assert.match(req.url, /^\/evejs\/industry\/(100|101)\/status$/);
        return ok(readings(req.url.split("/")[3]));
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
  const setField = (name, value) => evaluate(`(() => {
    const input = document.querySelector('[name=${name}]');
    const select = input instanceof HTMLSelectElement;
    Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true }));
  })()`);
  const callsFor = suffix => calls.filter(call => call.url.endsWith(suffix));
  const clickReady = async label => {
    await until(`${button(label)} && !${button(label)}.matches(':disabled')`);
    await evaluate(`${button(label)}.click()`);
  };
  const refresh = async () => {
    const count = callsFor("/status").length;
    await clickReady("Refresh industry status");
    await untilCall(() => callsFor("/status").length > count);
    await until(`!${button("Refresh industry status")}.matches(':disabled')`);
  };
  await cdp("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/industry-test` }, sessionId);
  await clickReady("Load industry status");
  await until("document.body.innerText.includes('Blueprint #900')");
  assert.equal(callsFor("/blueprints").length, 0, "catalog only loads on explicit request");
  await clickReady("Load available blueprints");
  await until("!!document.querySelector('[name=blueprintID] option[value=\"901\"]')");
  await setField("blueprintID", "901");
  await setField("emptyStorageUnitID", "300");
  await until(`!${button("Queue blueprint change")}.matches(':disabled')`);
  assert.equal(await evaluate(`${button("Change blueprint")}.matches(':disabled')`), true, "materials block direct blueprint changes");
  await clickReady("Queue empty blueprint");
  await clickReady("Queue blueprint change");
  await until("window.testQueue.length === 2 && document.body.innerText.includes('Queue preview') && document.body.innerText.includes('Blueprint #901')");
  await evaluate("window.testInitialQueue = window.testQueue.slice()");
  const queued = await evaluate("window.testQueue.map(task => task.operation)");
  assert.deepEqual(queued.map(task => task.kind), ["industry-empty", "industry-blueprint"]);
  for (const task of queued) {
    assert.equal(task.request.expectedBlueprintID, "900");
    assert.equal(task.request.expectedBlueprintHash, firstHash);
    assert.equal(task.request.expectedJobID, null);
  }
  assert.equal(queued[0].request.storageUnitID, "300");
  assert.equal(queued[1].request.blueprintID, "901");
  assert.equal(queued[1].request.blueprintHash, secondHash);
  assert.equal(callsFor("/empty").length + callsFor("/blueprint").length, 0, "queueing does not change the game");

  const inventoryRows = title => evaluate(`Array.from([...document.querySelectorAll('table')].find(table => table.caption?.textContent === ${JSON.stringify(title)}).tBodies[0].rows, row => Array.from(row.cells, cell => cell.textContent))`);
  assert.deepEqual(await inventoryRows("Input inventory"), [["Type #36", "0", "5", "1,000"]], "queued blueprint supplies input slots and clears the previous inventory");
  assert.deepEqual(await inventoryRows("Output inventory"), [["Type #37", "0", "2", "1,000"]], "queued blueprint supplies output slots");
  assert.equal(await evaluate("[...document.querySelectorAll('dt')].find(label => label.textContent === 'Run duration').nextElementSibling.textContent"), "120 s");
  for (const label of ["Empty active blueprint", "Change blueprint", "Start production", "Move items"])
    assert.equal(await evaluate(`${button(label)}.matches(':disabled')`), true, `${label} waits for the pending Industry queue`);
  assert.equal(await evaluate("document.body.innerText.includes('Run or clear')"), true);

  // A second queued recipe change uses the first change as its expected identity.
  await setField("blueprintID", "900");
  await clickReady("Queue blueprint change");
  await until("window.testQueue.length === 3 && document.body.innerText.includes('Blueprint #900')");
  const reversed = await evaluate("window.testQueue[2].operation.request");
  assert.equal(reversed.expectedBlueprintID, "901");
  assert.equal(reversed.expectedBlueprintHash, secondHash);
  assert.equal(reversed.blueprintID, "900");
  await evaluate("window.testRemoveTask(window.testQueue[2].id)");
  await until("window.testQueue.length === 2 && document.body.innerText.includes('Blueprint #901')");
  assert.deepEqual(await inventoryRows("Input inventory"), [["Type #36", "0", "5", "1,000"]], "removing a change restores the preceding queue projection");

  await setField("storageUnitID", "300");
  await until("!!document.querySelector('[name=typeID] option[value=\"36\"]')");
  assert.equal(await evaluate("!!document.querySelector('[name=typeID] option[value=\"34\"]')"), false, "deposit choices follow the queued recipe");
  await setField("typeID", "36");
  await setField("transferQuantity", "5");
  await clickReady("Queue transfer");
  await until("window.testQueue.length === 3");
  assert.deepEqual(await inventoryRows("Input inventory"), [["Type #36", "5", "5", "1,000"]], "queued deposit updates projected inventory quantities");
  assert.match(await evaluate("document.querySelector('[name=typeID] option[value=\"36\"]').textContent"), /15 available/);
  const queueScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await writeFile(path.join(cache, "industry-blueprint-queue-browser.png"), Buffer.from(queueScreenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sessionId);
  await until("window.innerWidth === 390");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "queue preview fits mobile width");
  const queueMobileScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await writeFile(path.join(cache, "industry-blueprint-queue-browser-mobile.png"), Buffer.from(queueMobileScreenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1050, height: 1200, deviceScaleFactor: 1, mobile: false }, sessionId);
  await clickReady("Queue production");
  await until("window.testQueue.length === 4");
  const queuedStart = await evaluate("window.testQueue[3].operation");
  assert.equal(queuedStart.kind, "industry-start");
  assert.equal(queuedStart.request.blueprintID, "901");
  assert.equal(queuedStart.request.blueprintHash, secondHash);
  assert.equal(queuedStart.request.expectedJobID, null);
  assert.equal(await evaluate("document.querySelector('.industry-production').innerText.includes('No active job')"), true, "queued production does not replace live job status");
  const { requestID: queuedTransferID, ...queuedTransfer } = await evaluate("window.testQueue[2].operation.request");
  assert.match(queuedTransferID, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(queuedTransfer, {
    storageUnitID: "300", direction: "deposit", side: "inputs", typeID: "36", quantity: "5",
  });

  await evaluate("window.testClearQueue()");
  await until("window.testQueue.length === 0 && !document.body.innerText.includes('Queue preview')");
  assert.deepEqual(await inventoryRows("Input inventory"), [["Type #34", "20", "2", "1,000"]], "clearing the queue restores live inventory");
  await evaluate("window.testForeignTasks()");
  await until("window.testQueue.length === 2");
  assert.equal(await evaluate("document.body.innerText.includes('Queue preview')"), false, "other wallet sessions and assemblies do not affect this panel");
  assert.equal(await evaluate(`${button("Empty active blueprint")}.matches(':disabled')`), false, "unrelated queued tasks do not block direct actions");
  await evaluate("window.testClearQueue()");
  await until("window.testQueue.length === 0");
  await setField("blueprintID", "901");

  production = { job_id: "7", state: "RUNNING", requested_runs: "1", completed_runs: "0", run_started_at_ms: String(Date.now()), run_end_at_ms: String(Date.now() + 60000), stop_reason: null };
  await refresh();
  await until("document.body.innerText.includes('RUNNING')");
  for (const label of ["Empty active blueprint", "Queue empty blueprint", "Change blueprint", "Queue blueprint change"])
    assert.equal(await evaluate(`${button(label)}.matches(':disabled')`), true, `${label} waits for production to stop`);
  production = { ...production, state: "STOPPED", completed_runs: "1", stop_reason: "COMPLETED" };
  await refresh();

  capacityFailure = true;
  await clickReady("Empty active blueprint");
  await until("document.body.innerText.includes('Fixture storage cannot fit every material.')");
  await until(`!${button("Empty active blueprint")}.matches(':disabled')`);
  assert.equal(inputQuantity, "20");
  assert.equal(outputQuantity, "3");
  await pause(3200);
  assert.equal(callsFor("/empty").length, 1, "an uncertain or failed empty request is not retried");
  assert.equal(callsFor("/blueprints").length, 1, "polling does not reload the catalog");

  delayNextEmpty = true;
  await evaluate(`(() => { const b = ${button("Empty active blueprint")}; b.click(); b.click(); b.click(); })()`);
  await untilCall(() => !!delayedEmptyResponse);
  assert.equal(callsFor("/empty").length, 2, "rapid clicks send only one new empty request");
  assert.equal(callsFor("/empty")[1].body.expectedJobID, "7");
  assert.notEqual(callsFor("/empty")[0].body.requestID, callsFor("/empty")[1].body.requestID);
  delayedEmptyResponse();
  await until("document.body.innerText.includes('All input and output materials moved to storage #300')");
  await until(`!${button("Change blueprint")}.matches(':disabled')`);
  assert.equal(await evaluate(`${button("Empty active blueprint")}.matches(':disabled')`), true);
  await clickReady("Sync both inventories");
  await until(`!${button("Sync both inventories")}`);
  assert.equal(callsFor("/empty").length, 2, "sync recovery does not repeat the empty operation");
  await clickReady("Change blueprint");
  await until("document.body.innerText.includes('Advanced material (#901) is now the active blueprint')");
  await until(`!${button("Reload available blueprints")}.matches(':disabled')`);
  assert.equal(callsFor("/blueprint").length, 1);
  assert.equal(callsFor("/blueprint")[0].body.expectedBlueprintHash, firstHash);
  assert.equal(callsFor("/blueprint")[0].body.expectedJobID, "7");
  assert.equal(await evaluate("window.testSignatures"), 1, "mutations reuse authorized owner access");
  assert.equal(await evaluate("window.testInitialQueue[1].operation.request.expectedBlueprintID"), "900", "later status reads do not substitute queued request identity");

  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await writeFile(path.join(cache, "industry-blueprint-browser.png"), Buffer.from(screenshot.data, "base64"));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sessionId);
  await until("window.innerWidth === 390");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "blueprint controls fit mobile width");
  const mobileScreenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await writeFile(path.join(cache, "industry-blueprint-browser-mobile.png"), Buffer.from(mobileScreenshot.data, "base64"));

  // A committed response after navigation belongs only to its original panel context.
  await setField("blueprintID", "900");
  delayNextBlueprint = true;
  await clickReady("Change blueprint");
  await untilCall(() => !!delayedBlueprintResponse);
  await evaluate("window.testSwitchAssembly()");
  await until("!!document.querySelector('[data-facility=\"101\"]')");
  delayedBlueprintResponse();
  await until(`!!${button("Load industry status")} && !${button("Load industry status")}.matches(':disabled')`);
  assert.equal(await evaluate("document.body.innerText.includes('is now the active blueprint')"), false);
  assert.equal(await evaluate("document.body.innerText.includes('Blueprint #900')"), false);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(errors, []);
});
