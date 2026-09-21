import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Only the loader is replaced: the real component and fuel projection run in Edge.
// No game service, wallet, or live Sui RPC is involved.
test("browser monitors fuel in a narrow panel and discards stale assembly readings", {
  skip: !process.env.DAPP_BROWSER_SMOKE,
  timeout: 90000,
}, async t => {
  const cleanup = [];
  t.after(async () => {
    const errors = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Fuel browser cleanup failed");
  });
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react-swc");
  const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const cache = path.join(root, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const profile = await mkdtemp(path.join(cache, "fuel-browser-"));
  cleanup.push(async () => {
    const relative = path.relative(cache, path.resolve(profile));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const id = value => `0x${value.padStart(64, "0")}`;
  const config = { network: "localnet", rpcUrl: "http://127.0.0.1:1", packageId: id("a"), objectRegistryId: id("b"), energyConfigId: id("c"), fuelConfigId: id("d") };
  const snapshot = {
    typeId: "88319", quantity: "499", isBurning: true,
    burnRateMs: "3000000", efficiency: "15", previousCycleElapsedMs: "0",
    burnStartTimeMs: "1000000", chainNowMs: "1100000", observedAtMs: 0,
  };
  const hmrServer = http.createServer();
  await new Promise(resolve => hmrServer.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { hmrServer.close(resolve); hmrServer.closeAllConnections(); }));
  const vite = await createServer({
    configFile: false, root, envFile: false, logLevel: "error",
    cacheDir: path.join(profile, "vite-cache"),
    plugins: [{
      name: "isolated-fuel-fixture",
      enforce: "pre",
      resolveId(source) {
        if (source === "/fuel-fixture.ts") return "\0fuel-fixture";
        if (/\/(?:assembly\/)?fuel(?:\.ts)?$/.test(source)) return "\0fuel-loader-fixture";
      },
      load(source) {
        if (source === "\0fuel-loader-fixture") return `
          export * from '/src/assembly/fuel.ts?fixture-helpers';
          export async function loadNetworkNodeFuel(config, assemblyId) {
            const fixture = window.fuelFixture;
            fixture.calls.push({ assemblyId, at: Date.now() });
            if (fixture.failure) throw new Error(fixture.failure);
            const snapshot = { ...fixture.snapshot, observedAtMs: Date.now() };
            if (fixture.defer) return new Promise((resolve, reject) => {
              fixture.pending.push({ assemblyId, reject,
                resolve: changes => resolve({ ...snapshot, ...changes, observedAtMs: Date.now() }) });
            });
            return snapshot;
          }
        `;
        if (source !== "\0fuel-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { FuelMonitorPanel } from '/src/components/FuelMonitorPanel.tsx';
          import '/src/main.css';
          window.fuelFixture = { snapshot: ${JSON.stringify(snapshot)}, calls: [], pending: [], defer: false, failure: null };
          function Fixture() {
            const [assemblyId, setAssembly] = React.useState(${JSON.stringify(id("10"))});
            const [visible, setVisible] = React.useState(true);
            window.fuelFixture.setAssembly = setAssembly;
            window.fuelFixture.setVisible = setVisible;
            return React.createElement(React.Fragment, null,
              React.createElement('header', { className: 'topbar' },
                React.createElement('div', { className: 'brand' },
                  React.createElement('span', { className: 'brand-mark' }, 'F'),
                  React.createElement('b', null, 'EVE FRONTIER'))),
              React.createElement('main', null,
                React.createElement(FuelMonitorPanel, { assemblyId, config: ${JSON.stringify(config)}, visible })));
          }
          createRoot(document.getElementById('root')).render(React.createElement(Fixture));
        `;
      },
    }, react()],
    server: { middlewareMode: true, hmr: { server: hmrServer, host: "127.0.0.1", clientPort: hmrServer.address().port } },
  });
  cleanup.push(() => vite.close());
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/fuel-test") {
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fuel browser fixture</title></head><body><div id="root"></div><script type="module" src="/fuel-fixture.ts"></script></body></html>'));
        return;
      }
      vite.middlewares(req, res);
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
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
  await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 260, deviceScaleFactor: 1, mobile: false }, sessionId);
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
  const text = "document.body.innerText";
  const button = "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh fuel')";
  const timer = `${text}.match(/\\b\\d+:\\d{2}:\\d{2}\\b/)?.[0]`;
  const seconds = value => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  await cdp("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/fuel-test` }, sessionId);
  await until(`${text}.includes('D2 Fuel') && ${timer}`);
  assert.match(await evaluate(text), /Fuel type/);
  assert.match(await evaluate(text), /Current unit remaining/);
  assert.match(await evaluate(text), /Burning/i);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "the narrow monitor has no horizontal overflow");
  assert.equal(await evaluate(`(() => {
    const label = [...document.querySelectorAll('*')].find(el => el.children.length === 0 && el.textContent === 'Current unit remaining');
    const bounds = label?.getBoundingClientRect();
    return !!bounds && bounds.top >= 0 && bounds.bottom <= innerHeight;
  })()`), true, "the remaining-time label is immediately visible in the 320 x 260 monitor");
  assert.equal(await evaluate(`(() => {
    const bounds = document.querySelector('.fuel-countdown')?.getBoundingClientRect();
    return !!bounds && bounds.top >= 0 && bounds.bottom <= innerHeight;
  })()`), true, "the countdown is visible below the app header without scrolling");
  const runningTime = await evaluate(timer);
  await until(`${timer} !== ${JSON.stringify(runningTime)}`);
  assert.ok(seconds(await evaluate(timer)) < seconds(runningTime), "the current unit countdown decreases");
  if (process.env.DAPP_BROWSER_SCREENSHOT) {
    const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
    await writeFile(path.resolve(process.env.DAPP_BROWSER_SCREENSHOT), Buffer.from(screenshot.data, "base64"));
  }

  await evaluate(`window.fuelFixture.snapshot.isBurning = false; ${button}.click()`);
  await until(`${text}.includes('Paused') && ${timer}`);
  const pausedTime = await evaluate(timer);
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(await evaluate(timer), pausedTime, "paused fuel does not burn down");
  await evaluate(`window.fuelFixture.snapshot.quantity = '0'; ${button}.click()`);
  await until(`${text}.includes('No fuel')`);
  assert.equal(await evaluate(timer), "0:00:00", "empty fuel has no remaining burn time");

  await evaluate(`window.fuelFixture.failure = 'Fixture fuel request failed'; ${button}.click()`);
  await until(`${text}.includes('Fixture fuel request failed')`);
  await evaluate(`window.fuelFixture.failure = null; window.fuelFixture.snapshot = ${JSON.stringify(snapshot)}; ${button}.click()`);
  await until(`${text}.includes('D2 Fuel') && ${timer} && !${text}.includes('Fixture fuel request failed')`);

  await evaluate(`window.fuelFixture.defer = true; ${button}.click()`);
  await until("window.fuelFixture.pending.length === 1");
  await evaluate(`window.fuelFixture.setAssembly(${JSON.stringify(id("20"))})`);
  await until("window.fuelFixture.pending.length === 2");
  assert.equal(await evaluate(`${text}.includes('D2 Fuel')`), false, "switching assemblies clears the previous fuel reading before the new request returns");
  await evaluate("window.fuelFixture.pending[1].resolve({ typeId: '88335' })");
  await until(`${text}.includes('D1 Fuel')`);
  await evaluate("window.fuelFixture.pending[0].resolve({ typeId: '88319' }); window.fuelFixture.defer = false; window.fuelFixture.snapshot.typeId = '88335'");
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate(`${text}.includes('D1 Fuel') && !${text}.includes('D2 Fuel')`), true, "a delayed old request cannot overwrite the current assembly");

  await evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))");
  const hiddenCalls = await evaluate("window.fuelFixture.calls.length");
  await new Promise(resolve => setTimeout(resolve, 10500));
  assert.equal(await evaluate("window.fuelFixture.calls.length"), hiddenCalls, "hidden documents do not poll fuel");
  await evaluate("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'))");
  await until(`window.fuelFixture.calls.length > ${hiddenCalls}`);
  await evaluate("window.fuelFixture.setVisible(false)");
  await new Promise(resolve => setTimeout(resolve, 150));
  const inactiveCalls = await evaluate("window.fuelFixture.calls.length");
  await new Promise(resolve => setTimeout(resolve, 10500));
  assert.equal(await evaluate("window.fuelFixture.calls.length"), inactiveCalls, "inactive monitor panels do not poll fuel");
  await evaluate("window.fuelFixture.setVisible(true)");
  await until(`window.fuelFixture.calls.length > ${inactiveCalls}`);
  await evaluate("window.fuelFixture.setAssembly(null)");
  await until(`${text}.includes('Load a Network Node to monitor its fuel.')`);
  assert.equal(await evaluate(`${text}.includes('D1 Fuel')`), false);
  assert.deepEqual(errors, []);
});
