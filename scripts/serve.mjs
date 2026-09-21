import https from "node:https";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTlsOptions } from "./tls.mjs";
import { createStorageProxy } from "./storage-proxy.mjs";
import {
  createDeploymentMiddleware,
  deploymentConfigRoute,
} from "./deployment-config.mjs";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const documentRoutes = new Set([
  "/",
  "/index.html",
  "/client/root",
  "/client/root/",
  "/client/behaviour",
  "/client/behaviour/",
  "/client/storage",
  "/client/storage/",
  "/client/industry",
  "/client/industry/",
  "/client/gate",
  "/client/gate/",
  "/client/networknode/monitor",
  "/client/networknode/monitor/",
]);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const requestHosts = new Set([...loopbackHosts, "dev.dapps.evefrontier.com"]);

export function getRelativeAsset(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(requestUrl).split(/[?#]/u, 1)[0]);
  } catch {
    return null;
  }
  if (!pathname.startsWith("/") || /[\\\0:]/u.test(pathname)) return null;
  const segments = pathname.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return null;
  if (documentRoutes.has(pathname)) return "index.html";
  return pathname.slice(1);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function validRequestHost(header) {
  try {
    const hostname = new URL(`https://${header}`).hostname.replace(
      /^\[|\]$/gu,
      "",
    );
    return requestHosts.has(hostname);
  } catch {
    return false;
  }
}

export async function createStaticServer(
  directory = path.join(appDirectory, "dist"),
  options = {},
) {
  const root = await realpath(directory);
  if (!(await stat(path.join(root, "index.html"))).isFile()) {
    throw new Error("Built index.html is missing. Run pnpm build first.");
  }
  const deploymentMiddleware = createDeploymentMiddleware(
    options.appDirectory ?? appDirectory,
  );
  const tls =
    options.tls ?? (await loadTlsOptions(options.appDirectory ?? appDirectory));
  const storageProxy = createStorageProxy({ upstream: options.storageServerUrl });
  return https.createServer(
    { ...tls, minVersion: "TLSv1.2" },
    async (request, response) => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Cache-Control", "no-store");
      const fail = (code, message) => {
        response.writeHead(code, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(request.method === "HEAD" ? undefined : message);
      };
      if (!validRequestHost(request.headers.host))
        return fail(403, "Local dApp hosts only.");
      if (/^\/evejs\/(?:storage|admin|energy|gates|industry)(?:\/|$)/u.test(request.url?.split(/[?#]/u, 1)[0] ?? "")) {
        return storageProxy(request, response, () => fail(404, "Not found."));
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        return fail(405, "Method not allowed.");
      }
      if (request.url?.split(/[?#]/u, 1)[0] === deploymentConfigRoute) {
        return deploymentMiddleware(request, response, () =>
          fail(404, "Not found."),
        );
      }
      const relative = getRelativeAsset(request.url);
      if (relative === null) return fail(400, "Invalid path.");
      const candidate = path.resolve(root, relative);
      if (!isInside(root, candidate)) return fail(400, "Invalid path.");
      try {
        const filename = await realpath(candidate);
        if (!isInside(root, filename)) return fail(404, "Not found.");
        const info = await stat(filename);
        if (!info.isFile()) return fail(404, "Not found.");
        const extension = path.extname(filename).toLowerCase();
        response.setHeader(
          "Content-Type",
          mimeTypes[extension] || "application/octet-stream",
        );
        response.setHeader("Content-Length", info.size);
        // Hashed Vite bundles can be cached; documents and the service worker must refresh.
        const immutable =
          relative.startsWith("assets/") &&
          /-[\w-]{8,}\.[a-z\d]+$/iu.test(relative);
        response.setHeader(
          "Cache-Control",
          immutable ? "public, max-age=31536000, immutable" : "no-store",
        );
        response.statusCode = 200;
        if (request.method === "HEAD") return response.end();
        const stream = createReadStream(filename);
        stream.on("error", () => response.destroy());
        response.on("close", () => stream.destroy());
        stream.pipe(response);
      } catch (error) {
        return fail(
          error.code === "ENOENT" || error.code === "ENOTDIR" ? 404 : 500,
          "File unavailable.",
        );
      }
    },
  );
}

export function parseServerOptions(args = process.argv.slice(2)) {
  let host = "127.0.0.1";
  let port = 443;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index + 1] === undefined)
      throw new Error(`Missing value for ${args[index]}.`);
    if (args[index] === "--host") host = args[index + 1];
    else if (args[index] === "--port") port = Number(args[index + 1]);
    else
      throw new Error(
        "Usage: node scripts/serve.mjs [--host 127.0.0.1|localhost|::1] [--port 443]",
      );
  }
  if (!loopbackHosts.has(host))
    throw new Error("The local host must be 127.0.0.1, localhost, or ::1.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Port must be between 1 and 65535.");
  return { host, port };
}

export function startStaticServer(server, { host, port }) {
  server.on("error", (error) => {
    console.error(`Unable to host the dApp: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(
      `Smart Assembly dApp: https://dev.dapps.evefrontier.com${port === 443 ? "" : `:${port}`} (listening on ${host}:${port})`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
}

async function main() {
  const options = parseServerOptions();
  startStaticServer(await createStaticServer(), options);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `Unable to host the dApp: ${error.code === "ENOENT" ? "Build output missing. Run pnpm build first." : error.message}`,
    );
    process.exitCode = 1;
  });
}
