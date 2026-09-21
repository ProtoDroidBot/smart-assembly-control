import { useEffect, useRef, useState } from "react";
import type { AssemblyConfig, AssemblySnapshot } from "../assembly/types.ts";
import type { WalletSession } from "../wallet.ts";
import type { EnqueueTask } from "../tasks/types.ts";
import {
  createEnergyClient,
  EnergyApiError,
  gridConnectionBlockReason,
} from "../energy/client.ts";
import type {
  EnergyGridStatus,
  EnergySession,
  GridAssembly,
} from "../energy/client.ts";
import { useLocalizedTypeNames } from "../localization/type-names.ts";
import { NetworkRadar } from "./NetworkRadar.tsx";

const api = createEnergyClient();
const amount = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const state = (assembly: GridAssembly) =>
  assembly.assemblyStatus === 2
    ? "online"
    : assembly.assemblyStatus === 1
      ? "offline"
      : "unknown";

interface Props {
  assembly: AssemblySnapshot;
  config: AssemblyConfig;
  wallet: WalletSession | null;
  disabled: boolean;
  visible: boolean;
  isOwner: boolean;
  onBusyChange: (busy: string) => void;
  onQueueTask?: EnqueueTask;
}

export function EnergyGridPanel({
  assembly,
  config,
  wallet,
  disabled,
  visible,
  isOwner,
  onBusyChange,
  onQueueTask,
}: Props) {
  const [session, setSession] = useState<EnergySession | null>(null);
  const [grid, setGrid] = useState<EnergyGridStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const locked = useRef(false);
  const active = useRef({ wallet, assemblyID: assembly.id, mounted: true });
  active.current.wallet = wallet;
  active.current.assemblyID = assembly.id;
  const itemID = assembly.itemId || "";
  const canAccess =
    !!wallet &&
    isOwner &&
    /^[1-9]\d*$/.test(itemID) &&
    Number.isSafeInteger(Number(itemID));
  const typeName = useLocalizedTypeNames(
    [
      ...(grid?.connectedAssemblies ?? []).map((entry) => entry.typeID),
      ...(grid?.nearbyAssemblies ?? []).map((entry) => entry.typeID),
      ...(grid?.radarAssemblies ?? []).flatMap((entry) => [
        entry.typeID,
        ...(entry.industry?.products.map((product) => product.typeID) ?? []),
      ]),
    ],
    assembly.tenant || config.defaultTenant,
  );

  useEffect(() => {
    active.current.mounted = true;
    const context = active.current;
    return () => {
      context.mounted = false;
    };
  }, []);
  useEffect(() => {
    setSession(null);
    setGrid(null);
    setError("");
    setNotice("");
    setStale(false);
    setUpdatedAt("");
  }, [wallet, assembly.id]);

  useEffect(() => {
    if (!visible || !session || !grid || disabled || stale || !canAccess)
      return;
    let cancelled = false;
    let reading = false;
    const timer = setInterval(() => {
      if (locked.current || reading) return;
      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        setStale(true);
        setSession(null);
        setError("Energy grid access expired. Refresh the grid to reconnect.");
        return;
      }
      reading = true;
      void api
        .status(itemID, session.token)
        .then((next) => {
          if (!cancelled) {
            setGrid(next);
            setUpdatedAt(new Date().toLocaleTimeString());
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            setError(describe(cause));
            setStale(true);
            if (cause instanceof EnergyApiError && cause.status === 401)
              setSession(null);
          }
        })
        .finally(() => {
          reading = false;
        });
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, session, grid, disabled, stale, canAccess, itemID]);

  function current() {
    return (
      active.current.mounted &&
      active.current.wallet === wallet &&
      active.current.assemblyID === assembly.id
    );
  }
  function progress(label: string) {
    setBusy(label);
    onBusyChange(label);
  }
  function accept(next: EnergyGridStatus) {
    if (!current()) return;
    setGrid(next);
    setStale(false);
    setUpdatedAt(new Date().toLocaleTimeString());
  }
  async function access() {
    if (!wallet) throw new Error("Connect the network node owner's wallet.");
    if (session && new Date(session.expiresAt).getTime() > Date.now() + 5000)
      return session;
    progress("Awaiting wallet approval for energy grid access");
    const next = await api.authenticate(wallet, config);
    if (!current())
      throw new Error("The wallet or network node changed. Reload the grid.");
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
      if (current()) {
        setError(describe(cause));
        setStale(true);
        if (cause instanceof EnergyApiError && cause.status === 401)
          setSession(null);
      }
    } finally {
      locked.current = false;
      if (active.current.mounted) setBusy("");
      onBusyChange("");
    }
  }
  async function refresh() {
    await run("Refreshing energy grid", async () => {
      const authorized = await access();
      if (!current()) return;
      progress("Reading grid usage and nearby assemblies");
      accept(await api.status(itemID, authorized.token));
    });
  }
  async function change(
    action: "connect" | "disconnect",
    target: GridAssembly,
  ) {
    if (stale || state(target) !== "offline") return;
    await run(
      `${action === "connect" ? "Connecting" : "Disconnecting"} ${target.name || "assembly"}`,
      async () => {
        const authorized = await access();
        if (!current()) return;
        const next = await api[action](itemID, authorized.token, target.itemID);
        accept(next);
        if (current())
          setNotice(
            `${target.name || `Assembly ${target.itemID}`} ${action === "connect" ? "connected to" : "disconnected from"} the energy grid.`,
          );
      },
    );
  }
  function queue(action: "connect" | "disconnect", target: GridAssembly) {
    if (!onQueueTask || disabled || busy || !canAccess || !grid || stale)
      return;
    // An earlier queued state change can take the target offline first.
    if (
      gridConnectionBlockReason(
        { ...target, assemblyStatus: 1 },
        action,
        grid.networkNodeID,
      )
    )
      return;
    onQueueTask({
      title: `${action === "connect" ? "Connect" : "Disconnect"} ${target.name || `Assembly ${target.itemID}`}`,
      details: `${action === "connect" ? "Connect to" : "Disconnect from"} ${assembly.name} · Network node #${itemID}. Eligibility is checked when this task runs.`,
      assembly,
      operation: {
        kind: action === "connect" ? "energy-connect" : "energy-disconnect",
        targetID: target.itemID,
      },
    });
    setNotice(
      `${action === "connect" ? "Connection" : "Disconnection"} added to the task queue.`,
    );
  }

  const connectedIDs = new Set(
    grid?.connectedAssemblies.map((entry) => entry.itemID),
  );
  const nearby =
    grid?.nearbyAssemblies.filter((entry) => !connectedIDs.has(entry.itemID)) ||
    [];
  function rows(entries: GridAssembly[], action: "connect" | "disconnect") {
    return (
      <div className="inventory-scroll">
        <table className="inventory-table energy-table">
          <caption>
            {action === "connect"
              ? "Nearby owned assemblies"
              : "Connected assemblies"}
          </caption>
          <thead>
            <tr>
              <th>Assembly</th>
              <th>State</th>
              <th>Energy</th>
              <th>Connection</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const reason = gridConnectionBlockReason(
                entry,
                action,
                grid!.networkNodeID,
              );
              return (
                <tr key={entry.itemID}>
                  <td>
                    <b>{entry.name || `Assembly ${entry.itemID}`}</b>
                    <small>
                      #{entry.itemID} · {typeName(entry.typeID)}
                    </small>
                    {typeof entry.distanceMeters === "number" && (
                      <small>
                        {amount(entry.distanceMeters / 1000)} km from node
                      </small>
                    )}
                  </td>
                  <td>
                    <span className={`state ${state(entry)}`}>
                      {state(entry).toUpperCase()}
                    </span>
                  </td>
                  <td>
                    {amount(entry.energyUsed)} used
                    <small>{amount(entry.energyRequired)} when online</small>
                  </td>
                  <td>
                    <div className="gate-row-actions">
                      <button
                        disabled={disabled || !!busy || stale || !!reason}
                        onClick={() => void change(action, entry)}
                      >
                        {action === "connect" ? "Connect" : "Disconnect"}
                      </button>
                      {onQueueTask && (
                        <button
                          disabled={
                            disabled ||
                            !!busy ||
                            stale ||
                            !canAccess ||
                            !!gridConnectionBlockReason(
                              { ...entry, assemblyStatus: 1 },
                              action,
                              grid!.networkNodeID,
                            )
                          }
                          onClick={() => queue(action, entry)}
                        >
                          {action === "connect"
                            ? "Queue connection"
                            : "Queue disconnection"}
                        </button>
                      )}
                    </div>
                    {reason && <small>{reason}</small>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="panel detail-panel energy-panel" aria-busy={!!busy}>
      <div className="section-kicker">NETWORK NODE / ENERGY GRID</div>
      <h2>Connected infrastructure.</h2>
      <p>
        Connect completed assemblies within this node's radius. Online
        assemblies draw energy according to their type. Take an assembly offline
        before changing its connection.
      </p>
      <div className="energy-toolbar">
        <button
          className={!grid ? "primary" : ""}
          disabled={disabled || !!busy || !canAccess}
          onClick={() => void refresh()}
        >
          {busy || (grid ? "Refresh energy grid" : "Load energy grid")}
        </button>
        {updatedAt && (
          <span className="muted">
            Updated {updatedAt}
            {stale ? " · refresh required" : " · refreshes every 10s"}
          </span>
        )}
      </div>
      {!canAccess && (
        <p>
          {!wallet
            ? "Connect the network node owner's wallet to view nearby assemblies and manage this grid."
            : !isOwner
              ? "Connect the network node owner's wallet to manage this grid."
              : "This network node needs a valid game item ID to load its energy grid."}
        </p>
      )}
      {error && (
        <p className="energy-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="positive" role="status">
          {notice}
        </p>
      )}
      {grid && (
        <>
          <dl className="energy-summary">
            <div>
              <dt>Energy used</dt>
              <dd>
                {amount(grid.energyUsed)}{" "}
                <small>/ {amount(grid.maxEnergy)}</small>
              </dd>
            </div>
            <div>
              <dt>Available energy</dt>
              <dd>{amount(grid.energyAvailable)}</dd>
            </div>
            <div>
              <dt>Connection radius</dt>
              <dd>
                {amount(grid.radiusMeters / 1000)} <small>km</small>
              </dd>
            </div>
          </dl>
          <meter
            className="energy-meter"
            min={0}
            max={grid.maxEnergy || 1}
            value={grid.energyUsed}
            aria-label={`${amount(grid.energyUsed)} of ${amount(grid.maxEnergy)} energy used`}
          />
          {!grid.online && (
            <p>
              The network node is offline. Bring it online to supply energy to
              connected assemblies.
            </p>
          )}
          <NetworkRadar
            contacts={grid.radarAssemblies}
            radiusMeters={grid.radiusMeters}
            typeName={typeName}
          />
          <h3>
            {grid.connectedAssemblies.length} connected{" "}
            {grid.connectedAssemblies.length === 1 ? "assembly" : "assemblies"}
          </h3>
          {grid.connectedAssemblies.length ? (
            rows(grid.connectedAssemblies, "disconnect")
          ) : (
            <p className="storage-empty">
              No assemblies are connected to this node.
            </p>
          )}
          <h3>Nearby assemblies</h3>
          <p>
            Completed assemblies owned by your character within{" "}
            {amount(grid.radiusMeters / 1000)} km.
          </p>
          {nearby.length ? (
            rows(nearby, "connect")
          ) : (
            <p className="storage-empty">
              No additional assemblies are available within this node's radius.
            </p>
          )}
        </>
      )}
    </section>
  );
}
