import { readFileSync } from "node:fs";

// Public test-only key pair. Never use this fixture for the running dApp or
// install it in a trust store. Tests trust this certificate explicitly via ca.
export const testTls = {
  key: readFileSync(new URL("./localhost-test-key.pem", import.meta.url)),
  cert: readFileSync(new URL("./localhost-test-cert.pem", import.meta.url)),
};
