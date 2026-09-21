import { useEffect, useRef, useState } from "react";
import type { AssemblyConfig, AssemblySnapshot } from "../assembly/types.ts";
import { loadAssembly } from "../assembly/client.ts";
import {
  buildRemoteScanActionTransaction,
  loadRemoteScanAlerts,
  loadRemoteScanQueueActions,
  type RemoteScanAlertAction,
  type RemoteScanQueueAction,
} from "../actions/chain.ts";
import {
  createEnergyClient,
  EnergyApiError,
} from "../energy/client.ts";
import type {
  EnergySession,
  RemoteScanConfiguration,
  RemoteScanHeatCell,
  RemoteScanJob,
  RemoteScanLayer,
  RemoteScanMode,
  RemoteScanResult,
} from "../energy/client.ts";
import type { WalletSession } from "../wallet.ts";
import type { EnqueueTask } from "../tasks/types.ts";

const api = createEnergyClient();
const runnableStates = new Set(["queued", "warming", "scanning"]);
const layerLabels: Record<RemoteScanLayer, string> = {
  sites: "Dungeon sites",
  resources: "Resources",
  celestials: "Celestials & stations",
  entities: "Entity heat map",
};

interface Props {
  assembly: AssemblySnapshot;
  config: AssemblyConfig;
  wallet: WalletSession | null;
  disabled: boolean;
  visible: boolean;
  view: "scanner" | "results";
  isOwner: boolean;
  onBusyChange: (busy: string) => void;
  onOpenResults: () => void;
  onOpenScanner: () => void;
  onQueueTask: EnqueueTask;
  queuedActionObjectIDs: string[];
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const percentage = (value: number) =>
  `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
const time = (value: number | null) =>
  value ? new Date(value).toLocaleTimeString() : "—";
const distance = (meters: number | null) => {
  if (meters === null || !Number.isFinite(meters)) return "—";
  if (meters >= 1.496e11) return `${(meters / 1.496e11).toFixed(2)} AU`;
  if (meters >= 1000) return `${Math.round(meters / 1000).toLocaleString()} km`;
  return `${Math.round(meters).toLocaleString()} m`;
};
const shortSignature = (value: string) =>
  value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;

function heatColor(cell: RemoteScanHeatCell) {
  const entries = Object.entries(cell.channels).sort((a, b) => b[1] - a[1]);
  if (entries[0]?.[0] === "thermal") return "#f28a52";
  if (entries[0]?.[0] === "electromagnetic") return "#70c6d4";
  return "#a8c98f";
}

function ScanHeatMap3D({ cells }: { cells: RemoteScanHeatCell[] }) {
  const [yaw, setYaw] = useState(35);
  const [pitch, setPitch] = useState(24);
  const visible = cells.slice(0, 128);
  const extent = Math.max(
    1,
    ...visible.flatMap((cell) => [
      Math.abs(cell.approximateCenter.x) + cell.uncertaintyRadiusMeters,
      Math.abs(cell.approximateCenter.y) + cell.uncertaintyRadiusMeters,
      Math.abs(cell.approximateCenter.z) + cell.uncertaintyRadiusMeters,
    ]),
  );
  const yawRadians = yaw * Math.PI / 180;
  const pitchRadians = pitch * Math.PI / 180;
  const project = (position: { x: number; y: number; z: number }) => {
    const x = position.x / extent;
    const y = position.y / extent;
    const z = position.z / extent;
    const horizontal = x * Math.cos(yawRadians) - z * Math.sin(yawRadians);
    const depthBeforePitch = x * Math.sin(yawRadians) + z * Math.cos(yawRadians);
    const vertical = y * Math.cos(pitchRadians) - depthBeforePitch * Math.sin(pitchRadians);
    const depth = y * Math.sin(pitchRadians) + depthBeforePitch * Math.cos(pitchRadians);
    return { x: 50 + horizontal * 35, y: 50 - vertical * 35, depth };
  };
  const plotted = visible
    .map((cell) => ({ cell, point: project(cell.approximateCenter) }))
    .sort((left, right) => left.point.depth - right.point.depth);
  const axes = [
    { label: "X", color: "#a8c98f", point: project({ x: extent, y: 0, z: 0 }) },
    { label: "Y", color: "#70c6d4", point: project({ x: 0, y: extent, z: 0 }) },
    { label: "Z", color: "#f28a52", point: project({ x: 0, y: 0, z: extent }) },
  ];
  return (
    <div className="scan-map">
      <div className="scan-map-controls">
        <label>
          <span>Rotation <b>{yaw}°</b></span>
          <input type="range" min="-180" max="180" value={yaw} onChange={(event) => setYaw(Number(event.target.value))} />
        </label>
        <label>
          <span>Elevation <b>{pitch}°</b></span>
          <input type="range" min="-75" max="75" value={pitch} onChange={(event) => setPitch(Number(event.target.value))} />
        </label>
        <button onClick={() => { setYaw(35); setPitch(24); }}>Reset view</button>
      </div>
      <svg viewBox="0 0 100 100" role="img" aria-label="Interactive three-dimensional aggregate entity signature heat map">
        <circle className="scan-map-ring" cx="50" cy="50" r="43" />
        <circle className="scan-map-ring" cx="50" cy="50" r="28" />
        <circle className="scan-map-ring" cx="50" cy="50" r="14" />
        {axes.map((axis) => (
          <g key={axis.label}>
            <line className="scan-map-axis" x1="50" y1="50" x2={axis.point.x} y2={axis.point.y} style={{ stroke: axis.color }} />
            <text x={axis.point.x} y={axis.point.y} style={{ fill: axis.color }}>{axis.label}</text>
          </g>
        ))}
        {plotted.map(({ cell, point }) => {
          const radius = (1.3 + cell.confidence * 4.2) * (0.9 + (point.depth + 1) * .1);
          return (
            <g key={cell.cellID}>
              <line className="scan-map-depth" x1={point.x} y1={point.y} x2={point.x} y2="50" />
              <circle
                className="scan-map-glow"
                cx={point.x}
                cy={point.y}
                r={radius * 2.2}
                fill={heatColor(cell)}
                opacity={0.08 + cell.confidence * 0.12}
              />
              <circle
                className="scan-map-cell"
                cx={point.x}
                cy={point.y}
                r={radius}
                fill={heatColor(cell)}
                opacity={0.35 + cell.confidence * 0.65}
              >
                <title>{`${cell.resolutionTier} · ${percentage(cell.confidence)} confidence · ships ${cell.entities.ships} · bases ${cell.entities.bases} · celestials ${cell.entities.celestials ?? "0"} · stations ${cell.entities.stations ?? "0"} · travel ${cell.entities.transientTravel}`}</title>
              </circle>
            </g>
          );
        })}
        <text x="8" y="96">AGGREGATED XYZ PROJECTION · ROTATE WITH CONTROLS</text>
      </svg>
      <div className="scan-map-legend">
        <span><i className="gravimetric" /> Gravimetric</span>
        <span><i className="electromagnetic" /> Electromagnetic</span>
        <span><i className="thermal" /> Thermal</span>
      </div>
    </div>
  );
}

export function RemoteScanningPanel({
  assembly,
  config,
  wallet,
  disabled,
  visible,
  view,
  isOwner,
  onBusyChange,
  onOpenResults,
  onOpenScanner,
  onQueueTask,
  queuedActionObjectIDs,
}: Props) {
  const [session, setSession] = useState<EnergySession | null>(null);
  const [configuration, setConfiguration] =
    useState<RemoteScanConfiguration | null>(null);
  const [rangeJumps, setRangeJumps] = useState(0);
  const [targetSystemID, setTargetSystemID] = useState("");
  const [mode, setMode] = useState<RemoteScanMode>("survey");
  const [layers, setLayers] = useState<RemoteScanLayer[]>([
    "sites",
    "resources",
    "celestials",
    "entities",
  ]);
  const [job, setJob] = useState<RemoteScanJob | null>(null);
  const [result, setResult] = useState<RemoteScanResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rememberedScanID, setRememberedScanID] = useState("");
  const [alerts, setAlerts] = useState<RemoteScanAlertAction[]>([]);
  const [chainQueue, setChainQueue] = useState<RemoteScanQueueAction[]>([]);
  const locked = useRef(false);
  const mounted = useRef(true);
  const openResults = useRef(onOpenResults);
  openResults.current = onOpenResults;
  const itemID = assembly.itemId || "";
  const canAccess =
    !!wallet &&
    isOwner &&
    /^[1-9]\d*$/.test(itemID) &&
    Number.isSafeInteger(Number(itemID));
  const activeScanID = job?.scanID || "";
  const activeScanState = job?.state || "";
  const scanMemoryKey = wallet && itemID
    ? `evejs.remote-scan.latest:${itemID}:${wallet.address.toLowerCase()}`
    : "";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setSession(null);
    setConfiguration(null);
    setRangeJumps(0);
    setTargetSystemID("");
    setMode("survey");
    setLayers(["sites", "resources", "celestials", "entities"]);
    setJob(null);
    setResult(null);
    setError("");
    setNotice("");
    setAlerts([]);
    setChainQueue([]);
    let remembered = "";
    try {
      remembered = scanMemoryKey ? sessionStorage.getItem(scanMemoryKey) || "" : "";
    } catch {
      /* Session storage is optional in constrained game browsers. */
    }
    setRememberedScanID(remembered);
  }, [wallet, assembly.id, scanMemoryKey]);

  useEffect(() => {
    if (!visible || !session || !activeScanID || !runnableStates.has(activeScanState))
      return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (cancelled || !session || !activeScanID) return;
      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        setSession(null);
        setError("Remote scanning access expired. Reconnect to continue.");
        return;
      }
      try {
        const next = await api.scanStatus(itemID, session.token, activeScanID);
        if (cancelled) return;
        if (next.state === "complete") {
          const scanResult = await api.scanResult(itemID, session.token, next.scanID);
          if (!cancelled) {
            setJob(next);
            setResult(scanResult);
            setNotice(`Scan of ${scanResult.targetSystemName} completed.`);
            openResults.current();
          }
        } else if (next.state === "failed") {
          setJob(next);
          setError(next.errorMsg || "The remote scan failed.");
        } else if (next.state === "cancelled") {
          setJob(next);
          setNotice("Remote scan cancelled. Reserved energy was released.");
        } else {
          setJob(next);
          timer = setTimeout(() => void poll(), 1000);
        }
      } catch (cause) {
        if (cancelled) return;
        setError(describe(cause));
        if (cause instanceof EnergyApiError && cause.status === 401)
          setSession(null);
      }
    }
    timer = setTimeout(() => void poll(), 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [visible, session, activeScanID, activeScanState, itemID]);

  function progress(label: string) {
    setBusy(label);
    onBusyChange(label);
  }

  async function access() {
    if (!wallet) throw new Error("Connect the network node owner's wallet.");
    if (session && new Date(session.expiresAt).getTime() > Date.now() + 5000)
      return session;
    progress("Awaiting wallet approval for remote scanning access");
    const next = await api.authenticate(wallet, config);
    if (!mounted.current) throw new Error("The scanning panel was closed.");
    setSession(next);
    return next;
  }

  async function run(label: string, operation: () => Promise<void>) {
    if (locked.current || disabled || !canAccess) return;
    locked.current = true;
    progress(label);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) {
        setError(describe(cause));
        if (cause instanceof EnergyApiError && cause.status === 401)
          setSession(null);
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy("");
      onBusyChange("");
    }
  }

  function acceptConfiguration(next: RemoteScanConfiguration) {
    setConfiguration(next);
    setRangeJumps(next.selectedRangeJumps);
    if (!next.modes.includes(mode)) setMode(next.modes[0] || "survey");
    setLayers((current) => {
      const available = current.filter((layer) => next.layers.includes(layer));
      return available.length ? available : [...next.layers];
    });
    setTargetSystemID((current) => {
      if (next.reachableSystems.some((system) => String(system.systemID) === current))
        return current;
      const remote = next.reachableSystems.find((system) => system.hops > 0);
      return String((remote || next.reachableSystems[0])?.systemID || "");
    });
  }

  async function loadConfiguration(selectedRange?: number) {
    await run("Loading remote scanning configuration", async () => {
      const authorized = await access();
      progress("Resolving reachable solar systems");
      const nextConfiguration = await api.scanConfiguration(itemID, authorized.token, selectedRange);
      acceptConfiguration(nextConfiguration);
      progress("Reading the shared Sui action queue");
      const [alertResult, queueResult] = await Promise.allSettled([
        loadRemoteScanAlerts(config, assembly),
        loadRemoteScanQueueActions(config, assembly),
      ]);
      if (alertResult.status === "fulfilled") setAlerts(alertResult.value);
      if (queueResult.status === "fulfilled") setChainQueue(queueResult.value);
      if (alertResult.status === "rejected" || queueResult.status === "rejected")
        setNotice("Scanner configuration loaded. The Sui action index is temporarily unavailable; refresh it to recover queue actions and alerts.");
    });
  }

  async function refreshChainQueue() {
    await run("Reading scan actions from Sui", async () => {
      const [nextAlerts, nextQueue] = await Promise.all([
        loadRemoteScanAlerts(config, assembly),
        loadRemoteScanQueueActions(config, assembly),
      ]);
      setAlerts(nextAlerts);
      setChainQueue(nextQueue);
      setNotice("Scan actions refreshed from the shared Sui queue.");
    });
  }

  function recoverAction(action: RemoteScanQueueAction) {
    if (action.status > 1 || action.expiresAtMs <= Date.now()) return;
    const queued = onQueueTask({
      title: `Remote ${action.payload.mode} scan`,
      details: `Recovered Sui action ${action.actionID} for system ${action.payload.targetSystemID}. The blockchain object remains authoritative.`,
      assembly,
      operation: {
        kind: "remote-scan",
        actionID: action.actionID,
        actionObjectID: action.actionObjectID,
        request: action.payload,
      },
    });
    setNotice(queued
      ? "Recovered the blockchain scan action into this session's task queue."
      : "The Sui action is safe on-chain, but the local task queue could not accept it. Remove a task and recover it again.");
  }

  function rememberScan(scanID: string) {
    setRememberedScanID(scanID);
    try {
      if (scanMemoryKey) sessionStorage.setItem(scanMemoryKey, scanID);
    } catch {
      /* The current panel still retains the job when storage is unavailable. */
    }
  }

  async function loadResults() {
    const scanID = job?.scanID || rememberedScanID;
    if (!scanID) {
      setError("No scan has been recorded for this Network Node. Start a scan first.");
      return;
    }
    await run("Loading remote scan results", async () => {
      const authorized = await access();
      const latest = await api.scanStatus(itemID, authorized.token, scanID);
      setJob(latest);
      rememberScan(latest.scanID);
      if (latest.state !== "complete") {
        if (runnableStates.has(latest.state))
          setNotice(`Scan is ${latest.state}. This view will update when it completes.`);
        else
          throw new Error(latest.errorMsg || `The scan is ${latest.state}.`);
        return;
      }
      const scanResult = await api.scanResult(itemID, authorized.token, latest.scanID);
      setResult(scanResult);
      setNotice(`Loaded results for ${scanResult.targetSystemName}.`);
    });
  }

  async function queueScan() {
    if (!configuration || !targetSystemID || layers.length === 0) return;
    await run("Queueing remote scan on Sui", async () => {
      if (!wallet) throw new Error("Connect the Network Node owner's wallet.");
      progress("Refreshing Network Node chain state");
      const fresh = await loadAssembly(config, assembly.id);
      if (fresh.kind !== "network_node" || fresh.itemId !== assembly.itemId ||
          fresh.ownerAddress !== assembly.ownerAddress)
        throw new Error("The Network Node identity or owner changed. Refresh and queue the scan again.");
      const action = await buildRemoteScanActionTransaction(config, fresh, wallet.address, {
        targetSystemID: Number(targetSystemID),
        mode,
        rangeJumps: configuration.selectedRangeJumps,
        layers,
      });
      progress("Awaiting wallet approval for the Sui queue action");
      await wallet.signAndExecute(action.transaction, config);
      const queued = onQueueTask({
        title: `Remote ${mode} scan`,
        details: `Scan system ${targetSystemID} at ${configuration.selectedRangeJumps} jumps. The Sui action is authoritative and neighboring Network Nodes receive blockchain alert actions when execution begins.`,
        assembly: fresh,
        operation: {
          kind: "remote-scan",
          actionID: action.actionID,
          actionObjectID: action.actionObjectID,
          request: action.payload,
        },
      });
      setChainQueue((current) => [{
        actionID: action.actionID,
        actionObjectID: action.actionObjectID,
        sourceAssemblyObjectID: fresh.id,
        targetAssemblyObjectID: fresh.id,
        createdAtMs: Date.now(),
        expiresAtMs: action.expiresAtMs,
        status: 0,
        priority: 100,
        priorityFlags: 258,
        payload: action.payload,
      }, ...current.filter((entry) => entry.actionObjectID !== action.actionObjectID)]);
      setNotice(queued
        ? "Scan action confirmed on Sui and added to the task queue. Run the queue to execute it."
        : "Scan action confirmed on Sui. The local queue could not accept it; remove a task, refresh Sui actions, and recover it.");
    });
  }

  async function cancelScan() {
    if (!job || !runnableStates.has(job.state)) return;
    await run("Cancelling remote system scan", async () => {
      const authorized = await access();
      const next = await api.cancelScan(itemID, authorized.token, job.scanID);
      setJob(next);
      setNotice("Cancellation requested.");
    });
  }

  function toggleLayer(layer: RemoteScanLayer) {
    setLayers((current) =>
      current.includes(layer)
        ? current.filter((entry) => entry !== layer)
        : [...current, layer],
    );
  }

  const selectedSystem = configuration?.reachableSystems.find(
    (system) => String(system.systemID) === targetSystemID,
  );
  const activeJob = !!job && runnableStates.has(job.state);
  const disabledControls = disabled || !!busy || activeJob;

  return (
    <section className="panel detail-panel scanning-panel">
      <div className="scan-heading">
        <div>
          <div className="section-kicker">
            {view === "results" ? "REMOTE SCAN ARCHIVE" : "REMOTE SIGNATURE ARRAY"}
          </div>
          <h2>{view === "results" ? "Resolved signatures." : "Solar-system scanning."}</h2>
          <p>
            {view === "results"
              ? "Load the latest completed scan and explore its aggregate signatures in three dimensions."
              : "Resolve sites, resources, and privacy-preserving entity heat from a reachable system without rendering its individual occupants."}
          </p>
        </div>
        {view === "results" ? (
          <button disabled={disabled || !!busy} onClick={onOpenScanner}>New scan</button>
        ) : configuration && (
          <span className="state online">{configuration.scannerProfileID}</span>
        )}
      </div>

      {error && <div className="banner error" role="alert">{error}</div>}
      {notice && <div className="banner success" role="status">{notice}</div>}

      {!canAccess && (
        <div className="scan-access-note">
          <span>◇</span>
          <p>
            {!wallet
              ? "Connect the Network Node owner's wallet to authorize remote scans."
              : !isOwner
                ? "Remote scanning is read-only until the Network Node owner's wallet is connected."
                : "This Network Node does not have a valid game item ID."}
          </p>
        </div>
      )}

      {view === "scanner" && <>
      {!configuration ? (
        <div className="scan-empty">
          <div className="scan-reticle" aria-hidden="true"><i /><i /><i /></div>
          <h3>Scanner awaiting authorization</h3>
          <p>
            Connect to load this node's fitted scanner profile, range, energy
            costs, and reachable systems.
          </p>
          <button
            className="primary"
            disabled={disabled || !!busy || !canAccess}
            onClick={() => void loadConfiguration()}
          >
            {busy || "Connect scanning array"} <span>↗</span>
          </button>
        </div>
      ) : (
        <>
          <dl className="scan-summary">
            <div><dt>Source system</dt><dd>{configuration.sourceSystemID}</dd></div>
            <div><dt>Maximum range</dt><dd>{configuration.maxRangeJumps} <small>jumps</small></dd></div>
            <div><dt>Reachable</dt><dd>{configuration.reachableSystems.length} <small>systems</small></dd></div>
            <div><dt>Signal privacy</dt><dd>REDACTED</dd></div>
          </dl>

          <section className="scan-active-card">
            <div className="section-kicker">NEIGHBORING SYSTEM ALERT ACTIONS / SUI</div>
            <div className="scan-heading">
              <div>
                <h3>{alerts.length ? `${alerts.length} detected scan ${alerts.length === 1 ? "action" : "actions"}` : "No scan alerts indexed"}</h3>
                <p>These are shared blockchain actions addressed to this Network Node by scans of adjacent systems. They use the same IDs and lifecycle as executable dApp queue tasks.</p>
              </div>
              <button disabled={disabled || !!busy} onClick={() => void refreshChainQueue()}>Refresh Sui actions</button>
            </div>
            {alerts.slice(0, 8).map(alert => (
              <div className="scan-result-row" key={alert.actionObjectID}>
                <span>{new Date(alert.createdAtMs).toLocaleString()}</span>
                <strong>System {alert.payload.targetSystemID}</strong>
                <span>{alert.payload.mode} · observed from neighboring system {alert.payload.neighboringSystemID}</span>
                <small>{alert.actionID}</small>
              </div>
            ))}
          </section>

          <section className="scan-active-card">
            <div className="section-kicker">EXECUTABLE SCAN ACTIONS / SUI</div>
            <h3>{chainQueue.length ? `${chainQueue.length} blockchain scan ${chainQueue.length === 1 ? "action" : "actions"}` : "No blockchain scan actions indexed"}</h3>
            <p>Queued and claimed actions can be restored into this session after a reload. Completed, failed, cancelled, and expired actions remain visible but cannot execute again.</p>
            {chainQueue.slice(0, 8).map(action => {
              const alreadyQueued = queuedActionObjectIDs.includes(action.actionObjectID);
              const recoverable = action.status <= 1 && action.expiresAtMs > Date.now();
              return (
                <div className="scan-result-row" key={action.actionObjectID}>
                  <span>{new Date(action.createdAtMs).toLocaleString()}</span>
                  <strong>System {action.payload.targetSystemID} · {action.payload.mode}</strong>
                  <span>Chain status {action.status} · {shortSignature(action.actionObjectID)}</span>
                  <button
                    disabled={disabled || !!busy || alreadyQueued || !recoverable}
                    onClick={() => recoverAction(action)}
                  >
                    {alreadyQueued ? "In local queue" : recoverable ? "Recover action" : "Closed"}
                  </button>
                </div>
              );
            })}
          </section>

          <div className="scan-config-grid">
            <section>
              <div className="section-kicker">01 / RANGE & DESTINATION</div>
              <label className="scan-range">
                <span>Scan range <b>{rangeJumps} jumps</b></span>
                <input
                  type="range"
                  min={configuration.minRangeJumps}
                  max={configuration.maxRangeJumps}
                  value={rangeJumps}
                  disabled={disabledControls}
                  onChange={(event) => setRangeJumps(Number(event.target.value))}
                />
              </label>
              <button
                disabled={disabledControls || rangeJumps === configuration.selectedRangeJumps}
                onClick={() => void loadConfiguration(rangeJumps)}
              >
                Apply range
              </button>
              <label className="scan-destination">
                <span>Destination system</span>
                <select
                  value={targetSystemID}
                  disabled={disabledControls || configuration.reachableSystems.length === 0}
                  onChange={(event) => setTargetSystemID(event.target.value)}
                >
                  {configuration.reachableSystems.map((system) => (
                    <option key={system.systemID} value={system.systemID}>
                      {system.name} · {system.hops} {system.hops === 1 ? "jump" : "jumps"}
                    </option>
                  ))}
                </select>
              </label>
              {selectedSystem && (
                <p className="muted">
                  System {selectedSystem.systemID} · Security {selectedSystem.securityStatus === null ? "unknown" : selectedSystem.securityStatus.toFixed(1)}
                </p>
              )}
            </section>

            <section>
              <div className="section-kicker">02 / RESOLUTION MODE</div>
              <div className="scan-mode-options">
                {configuration.modes.map((availableMode) => (
                  <label key={availableMode} className={mode === availableMode ? "active" : ""}>
                    <input
                      type="radio"
                      name="scan-mode"
                      value={availableMode}
                      checked={mode === availableMode}
                      disabled={disabledControls}
                      onChange={() => setMode(availableMode)}
                    />
                    <span>
                      <b>{availableMode.toUpperCase()}</b>
                      <small>
                        {configuration.costs[availableMode]?.energy ?? 0} energy · held {Math.round(configuration.energyHoldMs / 60_000)} min
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <p className="muted">
                {mode === "deep"
                  ? "Deep scans load the destination system and require live resolution before completing."
                  : "Survey scans request a system load, but can fall back to the persistent signature index if loading is unavailable."}
              </p>
            </section>
          </div>

          <fieldset className="scan-layers" disabled={disabledControls}>
            <legend>03 / SIGNATURE LAYERS</legend>
            {configuration.layers.map((layer) => (
              <label key={layer}>
                <input
                  type="checkbox"
                  checked={layers.includes(layer)}
                  onChange={() => toggleLayer(layer)}
                />
                <span>{layerLabels[layer]}</span>
              </label>
            ))}
          </fieldset>

          <div className="scan-submit">
            <p>
              Entity results combine ships and bases into anonymous signature
              bands. Player and NPC ownership is intentionally indistinguishable.
            </p>
            <button
              className="primary"
              disabled={disabledControls || !targetSystemID || layers.length === 0}
              onClick={() => void queueScan()}
            >
              Queue {mode} scan on Sui <span>↗</span>
            </button>
          </div>
        </>
      )}

      {job && (
        <section className="scan-job" aria-live="polite">
          <div>
            <div className="section-kicker">ACTIVE SCAN / {shortSignature(job.scanID)}</div>
            <h3>{job.state === "complete" ? "Scan complete" : `${job.state[0].toUpperCase()}${job.state.slice(1)}`}</h3>
            <p>
              System {job.targetSystemID} · {job.routeDistanceJumps} jumps · {job.cost.energy} energy
            </p>
          </div>
          <dl>
            <div><dt>Started</dt><dd>{time(job.startedAtMs)}</dd></div>
            <div><dt>Updated</dt><dd>{time(job.updatedAtMs)}</dd></div>
            <div><dt>Completes</dt><dd>{time(job.completesAtMs)}</dd></div>
            <div><dt>Power hold ends</dt><dd>{time(job.cost.hold?.expiresAtMs ?? null)}</dd></div>
          </dl>
          {activeJob && (
            <>
              <progress className="scan-progress" />
              <button disabled={disabled || !!busy} onClick={() => void cancelScan()}>
                Cancel scan
              </button>
            </>
          )}
          {job.state === "complete" && (
            <button className="primary" disabled={disabled || !!busy} onClick={onOpenResults}>
              Open results <span>↗</span>
            </button>
          )}
        </section>
      )}
      </>}

      {view === "results" && !result && (
        <div className="scan-empty scan-results-empty">
          <div className="scan-reticle" aria-hidden="true"><i /><i /><i /></div>
          <h3>
            {activeJob
              ? `Scan ${job?.state || "in progress"}`
              : job?.state === "complete" || rememberedScanID
                ? "Completed scan available"
                : "No scan results loaded"}
          </h3>
          <p>
            {activeJob
              ? "The Results tab will update automatically when signal processing completes."
              : job?.state === "complete" || rememberedScanID
                ? "Load the completed job to inspect its 3D heat map, dungeon sites, and resources."
                : "Run a remote scan first. Its latest job ID will be retained for this game-browser session."}
          </p>
          {activeJob ? (
            <button disabled={disabled || !!busy} onClick={onOpenScanner}>View active scan</button>
          ) : (
            <button
              className="primary"
              disabled={disabled || !!busy || !canAccess || (!job && !rememberedScanID)}
              onClick={() => void loadResults()}
            >
              {busy || "Load latest results"} <span>↗</span>
            </button>
          )}
        </div>
      )}

      {view === "results" && result && (
        <section className="scan-results">
          <div className="scan-result-heading">
            <div>
              <div className="section-kicker">RESOLVED SYSTEM / {result.targetSystemID}</div>
              <h2>{result.targetSystemName}</h2>
            </div>
            <span className="state online">{percentage(result.confidence)} CONFIDENCE</span>
          </div>
          <dl className="scan-summary result-summary">
            <div><dt>Route distance</dt><dd>{result.routeDistanceJumps} <small>jumps</small></dd></div>
            <div><dt>Observation</dt><dd>{time(result.asOfMs)}</dd></div>
            <div><dt>System loaded</dt><dd>{result.systemLoadSucceeded ? "YES" : "COLD FALLBACK"}</dd></div>
            <div><dt>World revision</dt><dd>{result.worldRevisionAfter}</dd></div>
          </dl>
          {(result.truncated || result.incompleteLayers.length > 0) && (
            <div className="banner">
              Partial result. {result.truncatedLayers.length > 0 && `Truncated: ${result.truncatedLayers.join(", ")}. `}
              {result.incompleteLayers.length > 0 && `Incomplete: ${result.incompleteLayers.join(", ")}.`}
            </div>
          )}

          {result.heatMapCells.length > 0 && (
            <>
              <div className="section-kicker scan-result-kicker">ENTITY SIGNATURE HEAT MAP / {result.heatMapCells.length} CELLS</div>
              <ScanHeatMap3D cells={result.heatMapCells} />
              <div className="scan-cell-bands">
                {result.heatMapCells.slice(0, 8).map((cell) => (
                  <div key={cell.cellID}>
                    <b>{shortSignature(cell.cellID)}</b>
                    <span>{cell.resolutionTier} · {percentage(cell.confidence)}</span>
                    <small>ships {cell.entities.ships} / bases {cell.entities.bases} / celestials {cell.entities.celestials ?? "0"} / stations {cell.entities.stations ?? "0"} / travel {cell.entities.transientTravel}</small>
                  </div>
                ))}
              </div>
            </>
          )}

          {result.sites.length > 0 && (
            <>
              <h3>Dungeon signatures</h3>
              <div className="scan-table-wrap">
                <table className="inventory-table scan-table">
                  <thead><tr><th>Signature</th><th>Classification</th><th>Resolution</th><th>Uncertainty</th></tr></thead>
                  <tbody>
                    {result.sites.map((site) => (
                      <tr key={site.signatureCode}>
                        <td><code title={site.signatureCode}>{shortSignature(site.signatureCode)}</code></td>
                        <td>
                          <b>{site.displayType || `${site.family} ${site.siteKind || "site"}`}</b>
                          {site.displayType
                            ? site.difficulty !== null && <small>Difficulty {site.difficulty}</small>
                            : <small>Specific site unresolved — deep scan required</small>}
                        </td>
                        <td>{site.resolutionTier}<small>{percentage(site.confidence)} confidence</small></td>
                        <td>{distance(site.uncertaintyRadiusMeters)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {result.resources.length > 0 && (
            <>
              <h3>Resource signatures</h3>
              <div className="scan-table-wrap">
                <table className="inventory-table scan-table">
                  <thead><tr><th>Signature</th><th>Family</th><th>Potential</th><th>Remaining</th></tr></thead>
                  <tbody>
                    {result.resources.map((resource) => (
                      <tr key={resource.signatureCode}>
                        <td><code title={resource.signatureCode}>{shortSignature(resource.signatureCode)}</code><small>{percentage(resource.confidence)} confidence</small></td>
                        <td>{resource.family}<small>{resource.resolutionTier}</small></td>
                        <td>{resource.potential.originalQuantityBand}<small>{resource.potential.typeIDs.length ? `Types ${resource.potential.typeIDs.join(", ")}` : "Types unresolved"}</small></td>
                        <td>{resource.remaining.quantityBand}<small>{resource.remaining.depleted === null ? "Depletion unresolved" : resource.remaining.depleted ? "Depleted" : "Active"}</small></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {(result.celestialObjects ?? []).length > 0 && (
            <>
              <h3>Celestial objects and stations</h3>
              <div className="scan-table-wrap">
                <table className="inventory-table scan-table">
                  <thead><tr><th>Object</th><th>Class</th><th>Resolution</th><th>Physical radius</th></tr></thead>
                  <tbody>
                    {result.celestialObjects.map((object) => (
                      <tr key={object.signatureCode}>
                        <td><b>{object.name}</b><small><code title={object.signatureCode}>{shortSignature(object.signatureCode)}</code></small></td>
                        <td>{object.station ? "Station" : object.objectClass}<small>{object.groupName}{object.typeID ? ` · Type ${object.typeID}` : ""}</small></td>
                        <td>{object.resolutionTier}<small>{percentage(object.confidence)} confidence · uncertainty {distance(object.uncertaintyRadiusMeters)}</small></td>
                        <td>{distance(object.radiusMeters)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {result.sites.length === 0 && result.resources.length === 0 && (result.celestialObjects ?? []).length === 0 && result.heatMapCells.length === 0 && (
            <div className="scan-empty compact"><h3>No signatures resolved</h3><p>The selected layers returned no observable signatures.</p></div>
          )}
        </section>
      )}
    </section>
  );
}
