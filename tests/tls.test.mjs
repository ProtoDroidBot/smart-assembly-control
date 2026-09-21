import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { loadTlsOptions } from "../scripts/tls.mjs";

const run = promisify(execFile);
const setupScript = fileURLToPath(
  new URL("../scripts/setup-https.ps1", import.meta.url),
);
let temporaryDirectory;
let certificateDirectory;
let certificate;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "assembly-tls-"));
  certificateDirectory = path.join(temporaryDirectory, ".certs");
  await run("pwsh", [
    "-NoLogo",
    "-NoProfile",
    "-File",
    setupScript,
    "-OutputDirectory",
    certificateDirectory,
  ]);
  certificate = await readFile(
    path.join(certificateDirectory, "localhost.pem"),
  );
});

after(async () => {
  if (!temporaryDirectory) return;
  const target = path.resolve(temporaryDirectory);
  const relative = path.relative(path.resolve(os.tmpdir()), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Temporary TLS test path escaped the system temp directory.");
  await rm(target, { recursive: true, force: true });
});

test("generated TLS certificate is a one-year server leaf for the in-game hostname and loopback hosts", async () => {
  const options = await loadTlsOptions(temporaryDirectory, {});
  assert.equal(options.minVersion, "TLSv1.2");
  assert.ok(Buffer.isBuffer(options.key));
  assert.ok(Buffer.isBuffer(options.cert));
  const x509 = new X509Certificate(options.cert);
  assert.equal(x509.ca, false);
  assert.equal(x509.checkHost("localhost"), "localhost");
  assert.equal(
    x509.checkHost("dev.dapps.evefrontier.com"),
    "dev.dapps.evefrontier.com",
  );
  assert.equal(x509.checkIP("127.0.0.1"), "127.0.0.1");
  assert.ok(x509.checkIP("::1"));
  assert.ok(x509.keyUsage.includes("1.3.6.1.5.5.7.3.1"));
  assert.ok(
    Date.parse(x509.validTo) - Date.parse(x509.validFrom) <= 365 * 86_400_000,
  );
});

test("TLS loader accepts explicit host environment file overrides", async () => {
  const options = await loadTlsOptions(
    path.join(temporaryDirectory, "other-app"),
    {
      DAPP_TLS_KEY_FILE: path.join(certificateDirectory, "localhost-key.pem"),
      DAPP_TLS_CERT_FILE: path.join(certificateDirectory, "localhost.pem"),
    },
  );
  assert.equal(
    new X509Certificate(options.cert).fingerprint256,
    new X509Certificate(certificate).fingerprint256,
  );
});

test("TLS loader fails closed with actionable guidance when files are absent", async () => {
  await assert.rejects(
    loadTlsOptions(path.join(temporaryDirectory, "missing"), {
      VITE_DAPP_TLS_KEY_FILE: path.join(
        certificateDirectory,
        "localhost-key.pem",
      ),
      VITE_DAPP_TLS_CERT_FILE: path.join(certificateDirectory, "localhost.pem"),
    }),
    /HTTPS requires readable TLS files.*pnpm setup:https.*No HTTP fallback/s,
  );
});

test("TLS loader refuses malformed PEM and mismatched certificate/private key", async () => {
  const invalidDirectory = path.join(temporaryDirectory, "invalid");
  await mkdir(invalidDirectory);
  const keyPath = path.join(invalidDirectory, "key.pem");
  const certPath = path.join(invalidDirectory, "cert.pem");
  await writeFile(keyPath, "invalid key");
  await writeFile(certPath, "invalid certificate");
  const env = { DAPP_TLS_KEY_FILE: keyPath, DAPP_TLS_CERT_FILE: certPath };
  await assert.rejects(
    loadTlsOptions(temporaryDirectory, env),
    /invalid, mismatched.*No HTTP fallback/s,
  );
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(certPath, certificate);
  await assert.rejects(
    loadTlsOptions(temporaryDirectory, env),
    /invalid, mismatched.*No HTTP fallback/s,
  );
});

test("certificate setup refuses to overwrite existing material without Force", async () => {
  const beforeFingerprint = new X509Certificate(certificate).fingerprint256;
  await assert.rejects(
    run("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-File",
      setupScript,
      "-OutputDirectory",
      certificateDirectory,
    ]),
    /already exists.*Force/s,
  );
  const unchanged = await readFile(
    path.join(certificateDirectory, "localhost.pem"),
  );
  assert.equal(
    new X509Certificate(unchanged).fingerprint256,
    beforeFingerprint,
  );
});
