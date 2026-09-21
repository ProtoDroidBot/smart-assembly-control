import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createStaticServer,
  parseServerOptions,
  startStaticServer,
} from "./serve.mjs";

const run = promisify(execFile);
const commandOptions = { windowsHide: true, timeout: 15000 };

async function listeningProcesses(port) {
  if (process.platform === "win32") {
    // netstat works without the CIM permissions required by Get-NetTCPConnection.
    // Match listeners only: an outgoing HTTPS connection is not a conflict.
    const command = `
      $ErrorActionPreference = 'Stop'
      $connections = & netstat.exe -ano -p tcp
      if ($LASTEXITCODE -ne 0) { throw 'Unable to query TCP listeners with netstat.' }
      $result = @($connections | ForEach-Object {
        if ($_ -match '^\\s*TCP\\s+(\\S+):${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$') {
          $address = $Matches[1].Trim('[', ']')
          $owner = Get-Process -Id ([int]$Matches[2]) -ErrorAction SilentlyContinue
          if ($owner) {
            [PSCustomObject]@{ pid = $owner.Id; name = $owner.ProcessName; address = $address }
          }
        }
      })
      ConvertTo-Json -Compress -InputObject $result
    `;
    const { stdout } = await run(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      commandOptions,
    );
    return JSON.parse(stdout.trim() || "[]");
  }

  let stdout;
  try {
    ({ stdout } = await run(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"],
      commandOptions,
    ));
  } catch (error) {
    if (error.code === 1 && !error.stdout && !error.stderr) return [];
    if (error.code === "ENOENT")
      throw new Error("Install lsof to identify conflicting dApp listeners.");
    throw error;
  }
  const listeners = [];
  let pid;
  let name;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) name = line.slice(1);
    else if (line.startsWith("n")) {
      listeners.push({
        pid,
        name,
        address: line.slice(1, line.lastIndexOf(":")).replace(/^\[|\]$/gu, ""),
      });
    }
  }
  return listeners;
}

function portAvailable({ host, port }) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

async function waitForPort(options, milliseconds) {
  const deadline = Date.now() + milliseconds;
  do {
    if (await portAvailable(options)) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return false;
}

async function conflicts(options) {
  const { address } = await lookup(options.host);
  const addresses = new Set([address, "::", "*"]);
  if (net.isIPv4(address)) addresses.add("0.0.0.0");
  return [
    ...new Map(
      (await listeningProcesses(options.port))
        .filter((listener) => addresses.has(listener.address))
        .map((listener) => [listener.pid, listener]),
    ).values(),
  ];
}

function checkOwner({ pid, name }) {
  if (
    !Number.isInteger(pid) ||
    pid <= 4 ||
    [process.pid, process.ppid].includes(pid)
  )
    throw new Error(`Cannot stop protected process ${pid} on the dApp port.`);
  // Shared service/container hosts may own many unrelated applications.
  if (
    /^(?:system|registry|svchost|services|lsass|csrss|wininit|winlogon|com\.docker\..*|docker.*|vpnkit.*|wsl.*|systemd|launchd)$/iu.test(
      name ?? "",
    )
  )
    throw new Error(
      `Port is owned by shared service ${name} (PID ${pid}). Stop the specific service or container publishing this port, then retry npm restart.`,
    );
}

function stopOwner(owner, signal) {
  try {
    process.kill(owner.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH")
      throw new Error(
        `Cannot stop ${owner.name || "process"} (PID ${owner.pid}): ${error.message}. Stop it manually or rerun from a terminal with permission to stop it.`,
      );
  }
}

async function clearPort(options) {
  if (await portAvailable(options)) return;
  const owners = await conflicts(options);
  // A listener may exit while the operating system query is in progress.
  if (await portAvailable(options)) return;
  if (!owners.length)
    throw new Error(
      `Port ${options.port} is occupied, but its owner could not be identified.`,
    );
  // Validate every target before stopping any of them.
  for (const owner of owners) checkOwner(owner);
  for (const owner of owners) {
    console.log(
      `Stopping ${owner.name || "process"} (PID ${owner.pid}) on port ${options.port}...`,
    );
    stopOwner(owner, "SIGTERM");
  }
  if (await waitForPort(options, 3000)) return;

  // Escalate only original owners that are still listening, never a new process
  // started by a supervisor that has reclaimed the port during this restart.
  const remaining = await conflicts(options);
  for (const owner of remaining) {
    if (
      !owners.some(
        (original) =>
          original.pid === owner.pid && original.name === owner.name,
      )
    )
      throw new Error(
        `Port ${options.port} was reclaimed by ${owner.name} (PID ${owner.pid}). Stop its supervisor and retry.`,
      );
    checkOwner(owner);
  }
  for (const owner of remaining) {
    stopOwner(owner, "SIGKILL");
  }
  if (!(await waitForPort(options, 3000)))
    throw new Error(
      `Port ${options.port} is still occupied after stopping its listeners.`,
    );
}

async function main() {
  const options = parseServerOptions();
  // Validate the build, TLS, and proxy settings before interrupting a working app.
  const server = await createStaticServer().catch((error) => {
    if (error.code === "ENOENT")
      throw new Error("Build output missing. Run npm run build first.");
    throw error;
  });
  console.log(`Restarting the dApp on ${options.host}:${options.port}...`);
  await clearPort(options);
  startStaticServer(server, options);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`Unable to restart the dApp: ${error.message}`);
    process.exitCode = 1;
  });
}
