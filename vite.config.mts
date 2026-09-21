import { defineConfig, normalizePath } from "vite";
import react from "@vitejs/plugin-react-swc";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deploymentConfigPlugin } from "./scripts/deployment-config.mjs";
import { loadTlsOptions } from "./scripts/tls.mjs";
import { storageProxyPlugin } from "./scripts/storage-proxy.mjs";

export default defineConfig(async ({ command }) => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  // Builds need no private key; all development and preview listeners require TLS.
  const https =
    command === "serve" ? await loadTlsOptions(directory) : undefined;
  return {
    plugins: [react(), deploymentConfigPlugin(directory), storageProxyPlugin()],
    server: {
      host: "127.0.0.1",
      port: 443,
      strictPort: true,
      allowedHosts: ["localhost", "dev.dapps.evefrontier.com"],
      https,
      fs: {
        deny: [
          ".env",
          ".env.*",
          "**/.git/**",
          "**/.certs/**",
          "*.{crt,pem,key,pfx,p12}",
          normalizePath(
            path.resolve(
              directory,
              process.env.DAPP_TLS_KEY_FILE || ".certs/localhost-key.pem",
            ),
          ),
        ],
      },
      // Docker Desktop bind mounts do not reliably forward Windows file events.
      watch: { usePolling: true, interval: 300 },
    },
    preview: {
      host: "127.0.0.1",
      port: 443,
      strictPort: true,
      https,
      allowedHosts: ["localhost", "dev.dapps.evefrontier.com"],
    },
  };
});
