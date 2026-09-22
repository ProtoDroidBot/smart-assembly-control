import { readFile } from "node:fs/promises";
import path from "node:path";
import { publicEnvironmentEntries } from "./configure-local.mjs";

export const deploymentConfigRoute = "/assembly-config.json";
const networks = new Set(["localnet", "testnet", "devnet", "mainnet"]);
const localDappHosts = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "dev.dapps.evefrontier.com",
]);

async function readJson(filename) {
  const raw = await readFile(filename, "utf8");
  if (raw.length > 1_048_576) throw new Error("Configuration is too large.");
  return JSON.parse(raw);
}

async function readFeatureManifest(deploymentDirectory) {
  try {
    return await readJson(path.join(deploymentDirectory, "world-features.v1.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return readJson(path.join(deploymentDirectory, "npc-deployment.json"));
  }
}

// The source descriptor is host-only. Never send paths, environment files,
// signing material, or the full deployment artifact to the browser.
export async function readDeploymentEnvironment(appDirectory) {
  let source;
  try {
    source = await readJson(path.join(appDirectory, ".deployment-source.json"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (
    !source ||
    typeof source.worldDir !== "string" ||
    !path.isAbsolute(source.worldDir) ||
    !networks.has(source.network) ||
    typeof source.rpcUrl !== "string" ||
    !source.rpcUrl ||
    typeof source.tenant !== "string" ||
    !source.tenant
  )
    throw new Error(
      "Invalid deployment source. Run pnpm configure:local --force.",
    );
  const deploymentDirectory = path.join(
    source.worldDir,
    "deployments",
    source.network,
  );
  const [artifact, featureDeployment] = await Promise.all([
    readJson(path.join(deploymentDirectory, "extracted-object-ids.json")),
    readFeatureManifest(deploymentDirectory),
  ]);
  return publicEnvironmentEntries(artifact, {
    ...source,
    featureDeployment,
  });
}

export function createDeploymentMiddleware(appDirectory) {
  return async (request, response, next) => {
    if (request.url?.split(/[?#]/u, 1)[0] !== deploymentConfigRoute)
      return next();
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const send = (code, body) => {
      response.statusCode = code;
      response.end(
        request.method === "HEAD" ? undefined : JSON.stringify(body),
      );
    };
    let hostname;
    try {
      hostname = new URL(`http://${request.headers.host}`).hostname.replace(
        /^\[|\]$/gu,
        "",
      );
    } catch {
      /* A malformed Host is rejected below. */
    }
    if (!localDappHosts.has(hostname))
      return send(403, { error: "Local dApp hosts only." });
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return send(405, { error: "Method not allowed." });
    }
    try {
      const environment = await readDeploymentEnvironment(appDirectory);
      if (environment === null) {
        response.statusCode = 204;
        return response.end();
      }
      return send(200, environment);
    } catch {
      return send(503, {
        error:
          "World deployment configuration is unavailable. Finish efctl env up or run pnpm configure:local --force, then reload this page.",
      });
    }
  };
}

export function deploymentConfigPlugin(appDirectory) {
  return {
    name: "assembly-deployment-config",
    configureServer(server) {
      server.middlewares.use(createDeploymentMiddleware(appDirectory));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createDeploymentMiddleware(appDirectory));
    },
  };
}
