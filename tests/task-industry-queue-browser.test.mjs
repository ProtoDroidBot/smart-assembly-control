import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

// Real App, wallet lifecycle, task queue, Industry client and assembly reader;
// only their remote wallet/game/chain transports use isolated local fixtures.
test("App runs consecutive Industry deposits to the same assembly across view changes", {
  skip: !process.env.DAPP_BROWSER_SMOKE, timeout: 90000,
}, async t => {
  const cleanup = [];
  t.after(async () => {
    const errors = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Industry queue browser cleanup failed");
  });
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react-swc");
  const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const cache = path.join(root, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const profile = await mkdtemp(path.join(cache, "task-industry-queue-browser-"));
  cleanup.push(async () => {
    const relative = path.relative(cache, path.resolve(profile));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const id = value => normalizeSuiAddress(`0x${value}`);
  const address = id("99");
  const digest = "11111111111111111111111111111111";
  const assembly = { id: id("10"), itemId: "100", name: "Mini Printer", ownerCapId: id("20"), characterId: id("30"), networkNodeId: id("40") };
  const config = { network: "localnet", rpcUrl: "", packageId: id("a"), objectRegistryId: id("b"), energyConfigId: id("c"), fuelConfigId: id("d") };
  const assemblyType = `${config.packageId}::assembly::Assembly`;
  const object = (objectId, type, fields, owner = { Shared: { initial_shared_version: "1" } }) => ({ data: {
    objectId, type, digest, version: "1", owner,
    content: { dataType: "moveObject", type, hasPublicTransfer: false, fields },
  } });
  const read = objectId => {
    if (objectId === assembly.id) return object(objectId, assemblyType, {
      owner_cap_id: assembly.ownerCapId, key: { item_id: "100", tenant: "dev" },
      metadata: { name: assembly.name }, status: { variant: "ONLINE" }, energy_source_id: assembly.networkNodeId,
    });
    if (objectId === assembly.ownerCapId) return object(objectId, `${config.packageId}::access::OwnerCap<${assemblyType}>`,
      { authorized_object_id: assembly.id }, { AddressOwner: assembly.characterId });
    if (objectId === assembly.characterId) return object(objectId, `${config.packageId}::character::Character`, { character_address: address });
    if (objectId === assembly.networkNodeId) return object(objectId, `${config.packageId}::network_node::NetworkNode`, { status: { variant: "ONLINE" } });
    throw new Error(`Unexpected fixture RPC object ${objectId}`);
  };
  const auth = new Transaction();
  auth.setSender(address); auth.setGasOwner(address); auth.setGasBudget(1); auth.setGasPrice(1);
  auth.setGasPayment([{ objectId: id("66"), version: "1", digest }]);
  const authData = await auth.toJSON();
  const calls = [], serverErrors = [], transfers = [];
  let stored = 160, input = 0, heldResponse, documents = 0;
  const blueprintHash = "a".repeat(64);
  const readings = () => ({
    blueprintHash, production: null,
    facility: { itemId: "100", typeId: 87119, status: 2, production: null, snapshot: {
      owner_id: "200", solar_system_id: "30000004", blueprint_id: "1200", run_time: "45",
      inputs: input ? [{ type_id: "78423", quantity: String(input) }] : [], outputs: [],
      blueprint_inputs: [{ type_id: "78423", quantity: "4", max_quantity: "200" }],
      blueprint_outputs: [{ type_id: "88887", quantity: "1", max_quantity: "100" }],
    } },
    chain: { status: "pending", assemblyObjectID: assembly.id, industryObjectID: id("55"), revision: "1" },
  });
  const hmrServer = http.createServer();
  await new Promise(resolve => hmrServer.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { hmrServer.close(resolve); hmrServer.closeAllConnections(); }));
  const vite = await createServer({
    configFile: false, root, envFile: false, logLevel: "error", cacheDir: path.join(profile, "vite-cache"),
    plugins: [react(), {
      name: "isolated-app-industry-queue",
      resolveId(source) { if (source === "/queue-wallet.ts") return "\0queue-wallet"; },
      load(source) {
        if (source !== "\0queue-wallet") return;
        return `
          import { Transaction } from '@mysten/sui/transactions';
          import { toBase64 } from '@mysten/sui/utils';
          window.testSignatures = 0;
          window.testDocumentVisibility = 'visible';
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testDocumentVisibility === 'hidden' });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.testDocumentVisibility });
          window.testSetVisibility = value => { window.testDocumentVisibility = value; document.dispatchEvent(new Event('visibilitychange')); };
          window.WALLET_API_CHAIN = 'sui:localnet';
          window.callWallet = async ({method,params}) => {
            if (method === 'connect') return {result:{accounts:[{suiAddress:${JSON.stringify(address)},chains:['sui:localnet']}]}};
            if (method === 'signTransaction') {
              window.testSignatures++;
              return {result:{bytes:toBase64(await Transaction.from(params.transaction).build()),signature:'fixture-owner-signature'}};
            }
            throw new Error('Unexpected wallet request '+method);
          };
          await import('/src/main.tsx');
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
      if (req.url.startsWith("/client/")) {
        documents++;
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><title>Industry queue fixture</title></head><body><div id="root"></div><script type="module" src="/queue-wallet.ts"></script></body></html>'));
        return;
      }
      if (req.url === "/assembly-config.json") return send({
        VITE_SUI_NETWORK: "localnet", VITE_SUI_RPC_URL: config.rpcUrl, VITE_TENANT: "dev",
        VITE_EVE_WORLD_PACKAGE_ID: config.packageId, VITE_OBJECT_REGISTRY_ID: config.objectRegistryId,
        VITE_ENERGY_CONFIG_ID: config.energyConfigId, VITE_FUEL_CONFIG_ID: config.fuelConfigId,
      });
      if (req.url === "/rpc" || req.url.startsWith("/evejs/industry/")) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        calls.push({ url: req.url, body });
        if (req.url === "/rpc") {
          assert.equal(body.method, "sui_getObject");
          return send({ jsonrpc: "2.0", id: body.id, result: read(body.params[0]) });
        }
        assert.equal(req.method, "POST");
        if (req.url.endsWith("/auth/challenge")) return ok({ challengeId: "queue-challenge", transactionData: authData, expiresAt: Date.now() + 60000 });
        if (req.url.endsWith("/auth/session")) return ok({ token: "queue-token", walletAddress: address, characterID: 200, expiresAt: Date.now() + 600000 });
        assert.equal(req.headers.authorization, "Bearer queue-token");
        if (req.url.endsWith("/status")) return ok(readings());
        if (req.url.endsWith("/storage")) return ok({ storageUnits: [{ storageUnitID: 300, name: "Nearby storage", capacity: 1000, usedVolume: stored * 0.1,
          items: stored ? [{ itemID: 301, typeID: 78423, name: "Silica Grains", quantity: stored, unitVolume: 0.1 }] : [],
        }] });
        if (req.url.endsWith("/transfer")) {
          assert.match(body.requestID, /^[0-9a-f-]{36}$/);
          assert.equal(body.storageUnitID, "300");
          assert.equal(body.direction, "deposit");
          assert.equal(body.side, "inputs");
          assert.equal(body.typeID, "78423");
          assert.ok(stored >= Number(body.quantity));
          stored -= Number(body.quantity); input += Number(body.quantity); transfers.push(body);
          const reply = () => ok({ requestID: body.requestID, gameCommitted: true, storageUnitID: 300,
            direction: "deposit", side: "inputs", items: { 78423: Number(body.quantity) },
            chain: { status: "pending", industryStatus: "pending", storageStatus: "pending" },
          });
          if (transfers.length === 1) { heldResponse = reply; return; }
          return reply();
        }
        throw new Error(`Unexpected fixture API ${req.url}`);
      }
      vite.middlewares(req, res);
    } catch (error) { serverErrors.push(String(error)); res.statusCode = 500; send({ error: String(error) }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  config.rpcUrl = `http://127.0.0.1:${server.address().port}/rpc`;
  cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = spawn(process.env.DAPP_BROWSER_PATH || process.env.CHROME_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-extensions",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const browserClosed = new Promise(resolve => { browser.once("exit", resolve); browser.once("error", resolve); });
  cleanup.push(async () => {
    if (browser.exitCode === null && browser.signalCode === null) browser.kill();
    let timer;
    try { await Promise.race([browserClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture browser did not exit")), 5000); })]); }
    finally { clearTimeout(timer); }
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const failed = detail => reject(new Error(`${detail}${output.trim() ? `\n${output.trim()}` : ""}`));
    const timer = setTimeout(() => failed("Browser startup timeout"), 15000);
    browser.once("error", error => { clearTimeout(timer); reject(error); });
    browser.once("exit", (code, signal) => { clearTimeout(timer); failed(`Browser exited before DevTools was ready (${signal || code})`); });
    browser.stderr.on("data", chunk => {
      output += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DevTools connection timeout")), 5000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = error => { clearTimeout(timer); reject(error); };
  });
  let next = 0;
  cleanup.push(async () => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++next, method: "Browser.close" }));
    await new Promise(resolve => setTimeout(resolve, 200));
    socket.close();
  });
  const pending = new Map(), errors = [];
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools ${method} timed out`)); }, 10000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1200, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(expression, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await pause(100); }
    throw new Error(`Browser condition timed out: ${expression}\n${await evaluate("document.body.innerText")}\nBrowser errors: ${JSON.stringify(errors)}\nServer errors: ${JSON.stringify(serverErrors)}`);
  }
  const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const click = async label => { await until(`${button(label)} && !${button(label)}.matches(':disabled')`); await evaluate(`${button(label)}.click()`); };
  const setField = (name, value, kind = "select") => evaluate(`(() => {
    const input = document.querySelector('[name=${name}]');
    Object.getOwnPropertyDescriptor(${kind === "select" ? "HTMLSelectElement" : "HTMLInputElement"}.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event(${JSON.stringify(kind === "select" ? "change" : "input")}, { bubbles: true }));
  })()`);
  const queueStatuses = "[...document.querySelectorAll('[data-task-status]')].map(t => t.dataset.taskStatus)";
  const url = `http://127.0.0.1:${server.address().port}/client/industry/?objectId=${assembly.id}`;
  await cdp("Page.navigate", { url }, sessionId);
  await click("Load industry status");
  await until("!!document.querySelector('[name=storageUnitID] option[value=\"300\"]')");
  await setField("storageUnitID", "300");
  await setField("typeID", "78423");
  await setField("transferQuantity", "1", "input");
  await click("Queue transfer");
  await setField("transferQuantity", "79", "input");
  await click("Queue transfer");
  await click("Queue continuous repeat");
  assert.deepEqual(await evaluate(queueStatuses), ["queued", "queued", "queued"]);
  assert.equal(transfers.length, 0);
  await click("Run queue (3)");
  await until(`${queueStatuses}.join(',') === 'running,queued,queued'`);
  const transferDeadline = Date.now() + 10000;
  while (!heldResponse && Date.now() < transferDeadline) await pause(20);
  assert.ok(heldResponse, "the first game transfer reached the fixture");
  assert.equal(input, 1);
  // Returning to ROOT within the app keeps its task queue alive. Also model a
  // hidden native browser while the first game transfer response is pending.
  // App tabs are intentionally disabled during execution; native navigation
  // can still deliver a same-document route event while the browser is hidden.
  await evaluate("history.pushState(null, '', '/client/root/' + location.search); dispatchEvent(new PopStateEvent('popstate'))");
  await evaluate("window.testSetVisibility('hidden')");
  heldResponse();
  await until(`transfers.length === 4 && ${queueStatuses}.join(',') === 'failed,queued,queued'`);
  await evaluate("window.testSetVisibility('visible')");
  assert.deepEqual(transfers.map(body => body.quantity), ["1", "79", "1", "79"]);
  assert.notEqual(transfers[0].requestID, transfers[1].requestID);
  assert.notEqual(transfers[0].requestID, transfers[2].requestID, "repeated transfers use fresh idempotency keys");
  assert.notEqual(transfers[1].requestID, transfers[3].requestID, "every repeated transfer is a fresh intent");
  assert.equal(input, 160);
  assert.equal(stored, 0);
  assert.equal(documents, 1, "in-app view changes must not reload the document");
  assert.equal(await evaluate("location.pathname"), "/client/root/");
  assert.equal(await evaluate("document.body.innerText.includes('Queue stopped')"), true, "the loop stops before a transfer the Industry facility cannot receive");
  assert.deepEqual(errors, []);
  assert.deepEqual(serverErrors, []);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await writeFile(path.join(cache, "task-industry-queue-browser.png"), Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ documents, transfers: transfers.map(body => body.quantity), states: await evaluate(queueStatuses), signatures: await evaluate("window.testSignatures") }));
});
