import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import path from "node:path";
import { createSecureContext } from "node:tls";

const setupHint =
  "Run pnpm setup:https, or set DAPP_TLS_KEY_FILE and DAPP_TLS_CERT_FILE in the host environment to a valid PEM key/certificate pair.";

/** Server-only TLS configuration. Certificates are never read from browser/Vite env. */
export async function loadTlsOptions(appDirectory, env = process.env) {
  const keyPath = path.resolve(
    appDirectory,
    env.DAPP_TLS_KEY_FILE || ".certs/localhost-key.pem",
  );
  const certPath = path.resolve(
    appDirectory,
    env.DAPP_TLS_CERT_FILE || ".certs/localhost.pem",
  );
  let key;
  let cert;
  try {
    [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  } catch {
    throw new Error(
      `HTTPS requires readable TLS files at ${keyPath} and ${certPath}. ${setupHint} No HTTP fallback is available.`,
    );
  }

  const options = { key, cert, minVersion: "TLSv1.2" };
  try {
    createSecureContext(options);
    const certificate = new X509Certificate(cert);
    const now = Date.now();
    if (
      Date.parse(certificate.validFrom) > now ||
      Date.parse(certificate.validTo) <= now
    ) {
      throw new Error("Certificate is outside its validity period.");
    }
  } catch {
    throw new Error(
      `The HTTPS certificate/key pair is invalid, mismatched, or outside its validity period. ${setupHint} No HTTP fallback is available.`,
    );
  }
  return options;
}
