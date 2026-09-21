import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createStorageProxy } from "../scripts/storage-proxy.mjs";

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("storage proxy preserves signed requests and server errors without forwarding cookies", async t => {
  const received = [];
  const upstream = await listen(http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      received.push({ path: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, errorMsg: "INSUFFICIENT_SOURCE_ITEMS" }));
    });
  }), t);
  const proxy = createStorageProxy({ upstream });
  const base = await listen(http.createServer((req, res) => proxy(req, res, () => { res.statusCode = 404; res.end(); })), t);
  const response = await fetch(`${base}/evejs/storage/123/execute`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer token", Cookie: "secret=private" },
    body: JSON.stringify({ transactionUUID: "operation", signature: "signed" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).errorMsg, "INSUFFICIENT_SOURCE_ITEMS");
  assert.equal(received[0].headers.authorization, "Bearer token");
  assert.equal(received[0].headers.cookie, undefined);
  assert.deepEqual(JSON.parse(received[0].body), { transactionUUID: "operation", signature: "signed" });
  assert.equal((await fetch(`${base}/unrelated`)).status, 404);
  assert.equal((await fetch(`${base}/evejs/storage/%2e%2e%2fsecret`)).status, 400);
  assert.equal((await fetch(`${base}/evejs/storage/123`, { method: "DELETE" })).status, 405);
  assert.equal(received.length, 1);
});

test("storage proxy rejects nonlocal or credential-bearing destinations", () => {
  for (const upstream of ["https://127.0.0.1", "http://example.com", "http://user:password@localhost", "http://localhost/other", "http://localhost?token=secret"]) {
    assert.throws(() => createStorageProxy({ upstream }), /loopback/u);
  }
});

test("industry status, production, and inventory routes preserve wallet authorization and server receipts", async t => {
  const received = [];
  const upstream = await listen(http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      received.push({ path: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { assemblyID: 123, ...(req.url.endsWith("/start") ? { gameCommitted: true, startedJobID: "6" } : {}) } }));
    });
  }), t);
  const proxy = createStorageProxy({ upstream });
  const base = await listen(http.createServer((req, res) => proxy(req, res, () => { res.statusCode = 404; res.end(); })), t);
  const routes = ["auth/challenge", "auth/session", "123/status", "123/sync", "123/start", "123/storage", "123/transfer", "123/storage-sync"];
  const startBody = { blueprintID: "22", blueprintHash: "a".repeat(64), runs: "10", expectedJobID: "5" };
  const transferBody = { requestID: "d5b345fb-6611-4000-a000-4dc47c6d45fc", storageUnitID: "300", direction: "deposit", side: "inputs", typeID: "34", quantity: "10" };
  const bodyFor = route => route.endsWith("/start") ? startBody : route.endsWith("/transfer") ? transferBody
    : route.endsWith("/storage-sync") ? { storageUnitID: "300" } : { assemblyID: "123" };
  for (const route of routes) {
    const response = await fetch(`${base}/evejs/industry/${route}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer industry-token", Cookie: "secret=private" },
      body: JSON.stringify(bodyFor(route)),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (route.endsWith("/start")) assert.deepEqual(await response.json(), { success: true, data: { assemblyID: 123, gameCommitted: true, startedJobID: "6" } });
  }
  assert.deepEqual(received.map(request => request.path), routes.map(route => `/evejs/industry/${route}`));
  for (const request of received) {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer industry-token");
    assert.equal(request.headers.cookie, undefined);
    assert.deepEqual(JSON.parse(request.body), bodyFor(request.path));
  }
  assert.equal((await fetch(`${base}/evejs/industry-other/123`)).status, 404);
  assert.equal((await fetch(`${base}/evejs/industry/%2e%2e%2fsecret`)).status, 400);
  assert.equal((await fetch(`${base}/evejs/industry/123/status`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${base}/evejs/industry/123/status`, { method: "POST", body: "x".repeat(65537) })).status, 413);
  assert.equal(received.length, routes.length);
});

test("gate routes preserve authorization and guarded pair operations", async t => {
  const received = [];
  const upstream = await listen(http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { gateID: 123 } }));
    });
  }), t);
  const proxy = createStorageProxy({ upstream });
  const base = await listen(http.createServer((req, res) => proxy(req, res, () => { res.statusCode = 404; res.end(); })), t);
  const routes = ["auth/challenge", "auth/session", "123/status", "123/link", "123/unlink", "123/sync"];
  for (const route of routes) {
    const response = await fetch(`${base}/evejs/gates/${route}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer gate-token", Cookie: "secret=private" },
      body: JSON.stringify({ destinationGateID: 456 }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(received.map(request => request.path), routes.map(route => `/evejs/gates/${route}`));
  for (const request of received) {
    assert.equal(request.headers.authorization, "Bearer gate-token");
    assert.equal(request.headers.cookie, undefined);
    assert.deepEqual(JSON.parse(request.body), { destinationGateID: 456 });
  }
  assert.equal((await fetch(`${base}/evejs/gates-other/123`)).status, 404);
  assert.equal((await fetch(`${base}/evejs/gates/%2e%2e%2fsecret`)).status, 400);
  assert.equal((await fetch(`${base}/evejs/gates/123/link`, { method: "DELETE" })).status, 405);
  assert.equal(received.length, routes.length);
});

test("energy grid routes forward wallet authorization and reject path escapes", async t => {
  const received = [];
  const upstream = await listen(http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      received.push({ path: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { networkNodeID: 123 } }));
    });
  }), t);
  const proxy = createStorageProxy({ upstream });
  const base = await listen(http.createServer((req, res) => proxy(req, res, () => { res.statusCode = 404; res.end(); })), t);
  const routes = [
    "auth/challenge",
    "auth/session",
    "123/status",
    "123/connect",
    "123/disconnect",
    "123/scanning/config",
    "123/scanning/start",
    "123/scanning/123e4567-e89b-42d3-a456-426614174000/status",
    "123/scanning/123e4567-e89b-42d3-a456-426614174000/result",
    "123/scanning/123e4567-e89b-42d3-a456-426614174000/cancel",
  ];
  for (const path of routes) {
    const response = await fetch(`${base}/evejs/energy/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer energy-token", Cookie: "secret=private" },
      body: JSON.stringify({ assemblyID: 456 }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(received.length, routes.length);
  for (const request of received) {
    assert.equal(request.headers.authorization, "Bearer energy-token");
    assert.equal(request.headers.cookie, undefined);
    assert.deepEqual(JSON.parse(request.body), { assemblyID: 456 });
  }
  assert.equal((await fetch(`${base}/evejs/energy-other/123`)).status, 404);
  assert.equal((await fetch(`${base}/evejs/energy/%2e%2e%2fsecret`)).status, 400);
  assert.equal(received.length, routes.length);
});

test("admin prepare and execute use the same restricted proxy and preserve server responses", async t => {
  const received = [];
  const upstream = await listen(http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      received.push({ path: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(403, { "Content-Type": "application/json", "Set-Cookie": "upstream=private" });
      res.end(JSON.stringify({ success: false, errorMsg: "NOT_ASSEMBLY_OWNER" }));
    });
  }), t);
  const proxy = createStorageProxy({ upstream });
  const base = await listen(http.createServer((req, res) => proxy(req, res, () => { res.statusCode = 404; res.end(); })), t);
  for (const action of ["prepare", "execute"]) {
    const response = await fetch(`${base}/evejs/admin/123/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-token", Cookie: "secret=private", "X-Private-Header": "private" },
      body: JSON.stringify({ transactionUUID: "admin-operation", signature: "admin-signed" }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { success: false, errorMsg: "NOT_ASSEMBLY_OWNER" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.deepEqual(received.map(request => request.path), ["/evejs/admin/123/prepare", "/evejs/admin/123/execute"]);
  for (const request of received) {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer admin-token");
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["x-private-header"], undefined);
    assert.deepEqual(JSON.parse(request.body), { transactionUUID: "admin-operation", signature: "admin-signed" });
  }
  assert.equal((await fetch(`${base}/evejs/admin-other/123`)).status, 404);
  assert.equal((await fetch(`${base}/evejs/admin/%2e%2e%2fsecret`)).status, 400);
  assert.equal((await fetch(`${base}/evejs/admin/123`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`${base}/evejs/admin/123/prepare`, { method: "POST", body: "x".repeat(65537) })).status, 413);
  assert.equal(received.length, 2);
});
