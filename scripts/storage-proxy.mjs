import http from "node:http";

export function createStorageProxy(options = {}) {
  const upstream = new URL(options.upstream ?? process.env.DAPP_STORAGE_SERVER_URL ?? "http://127.0.0.1:26102");
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname) ||
      upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== "/") {
    throw new Error("DAPP_STORAGE_SERVER_URL must be an HTTP loopback server origin.");
  }
  return (request, response, next) => {
    const pathname = String(request.url ?? "").split(/[?#]/u, 1)[0];
    const route = /^\/evejs\/(storage|admin|energy|gates|industry)(?:\/|$)/u.exec(pathname)?.[1];
    if (!route) return next();
    const fail = (status, message) => {
      if (response.headersSent) return response.destroy();
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ success: false, errorMsg: message }));
    };
    if (!/^\/evejs\/(?:storage|admin|energy|gates|industry)(?:\/[a-zA-Z0-9_-]+)*\/?$/u.test(pathname)) return fail(400, `INVALID_${route.toUpperCase()}_PATH`);
    if (!["GET", "POST", "OPTIONS"].includes(request.method)) return fail(405, "METHOD_NOT_ALLOWED");
    if (Number(request.headers["content-length"]) > 65536) return fail(413, "REQUEST_TOO_LARGE");
    const headers = {};
    for (const name of ["authorization", "content-type", "content-length", "origin", "access-control-request-method", "access-control-request-headers"]) {
      if (request.headers[name] !== undefined) headers[name] = request.headers[name];
    }
    const forwarded = http.request(upstream, { method: request.method, path: request.url, headers }, (result) => {
      response.writeHead(result.statusCode ?? 502, {
        "Content-Type": result.headers["content-type"] ?? "application/json",
        "Cache-Control": "no-store",
      });
      result.on("error", () => response.destroy());
      result.pipe(response);
    });
    forwarded.setTimeout(30000, () => forwarded.destroy(new Error("Local dApp server timed out")));
    forwarded.on("error", () => fail(502, `${route.toUpperCase()}_SERVER_UNAVAILABLE`));
    request.on("aborted", () => forwarded.destroy());
    response.on("close", () => forwarded.destroy());
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536) { fail(413, "REQUEST_TOO_LARGE"); forwarded.destroy(); }
    });
    request.pipe(forwarded);
  };
}

export function storageProxyPlugin() {
  return {
    name: "assembly-storage-api",
    configureServer(server) { server.middlewares.use(createStorageProxy()); },
    configurePreviewServer(server) { server.middlewares.use(createStorageProxy()); },
  };
}
