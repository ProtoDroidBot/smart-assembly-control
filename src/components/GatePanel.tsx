import { useEffect, useMemo, useRef, useState } from "react";
import type { AssemblyConfig, AssemblySnapshot } from "../assembly/types.ts";
import type { WalletSession } from "../wallet.ts";
import {
  createGateClient,
  GateApiError,
  gateLinkBlockReason,
  METERS_PER_LIGHT_YEAR,
} from "../gate/client.ts";
import type { GateCandidate, GateSession, GateStatus } from "../gate/client.ts";
import type { EnqueueTask } from "../tasks/types.ts";
import { useLocalizedTypeNames } from "../localization/type-names.ts";

const api = createGateClient();
const amount = (value: number) =>
  value.toLocaleString(undefined, { maximumSignificantDigits: 5 });
const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const chainLabels = {
  disabled: "UNAVAILABLE",
  pending: "PENDING",
  synced: "SYNCED",
  error: "SYNC FAILED",
};

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

export function GatePanel({
  assembly,
  config,
  wallet,
  disabled,
  visible,
  isOwner,
  onBusyChange,
  onQueueTask,
}: Props) {
  const [session, setSession] = useState<GateSession | null>(null);
  const [status, setStatus] = useState<GateStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const locked = useRef(false);
  const identity = useMemo(
    () => ({ wallet, assemblyID: assembly.id }),
    [wallet, assembly.id],
  );
  const active = useRef({ identity, mounted: true });
  active.current.identity = identity;
  const itemID = assembly.itemId || "";
  const canAccess =
    !!wallet &&
    isOwner &&
    /^[1-9]\d*$/.test(itemID) &&
    Number.isSafeInteger(Number(itemID));
  const typeName = useLocalizedTypeNames(
    [
      status?.gate.typeID,
      status?.destination?.typeID,
      ...(status?.candidates ?? []).map((candidate) => candidate.typeID),
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
    setStatus(null);
    setError("");
    setNotice("");
    setStale(false);
    setUpdatedAt("");
  }, [identity]);

  useEffect(() => {
    if (!visible || !session || !status || disabled || stale || !canAccess)
      return;
    let cancelled = false;
    let reading = false;
    const timer = setInterval(() => {
      if (locked.current || reading) return;
      if (new Date(session.expiresAt).getTime() <= Date.now()) {
        setStale(true);
        setSession(null);
        setError("Gate access expired. Refresh the gate links to reconnect.");
        return;
      }
      reading = true;
      void api
        .status(itemID, session.token)
        .then((next) => {
          if (!cancelled) {
            setStatus(next);
            setUpdatedAt(new Date().toLocaleTimeString());
          }
        })
        .catch((cause) => {
          if (!cancelled) {
            setError(describe(cause));
            setStale(true);
            if (cause instanceof GateApiError && cause.status === 401)
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
  }, [visible, session, status, disabled, stale, canAccess, itemID, identity]);

  function current() {
    return active.current.mounted && active.current.identity === identity;
  }
  function progress(label: string) {
    if (!current()) return;
    setBusy(label);
    onBusyChange(label);
  }
  function accept(next: GateStatus) {
    if (!current()) return;
    setStatus(next);
    setStale(false);
    setUpdatedAt(new Date().toLocaleTimeString());
  }
  async function access() {
    if (!wallet) throw new Error("Connect the gate owner's wallet.");
    if (session && new Date(session.expiresAt).getTime() > Date.now() + 5000)
      return session;
    progress("Awaiting wallet approval for gate access");
    const next = await api.authenticate(wallet, config);
    if (!current())
      throw new Error("The wallet or gate changed. Reload the gate links.");
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
        if (cause instanceof GateApiError && cause.status === 401)
          setSession(null);
      }
    } finally {
      locked.current = false;
      if (active.current.mounted) setBusy("");
      onBusyChange("");
    }
  }
  async function refresh() {
    await run("Refreshing gate links", async () => {
      const authorized = await access();
      if (!current()) return;
      progress("Reading gate destinations and blockchain state");
      accept(await api.status(itemID, authorized.token));
    });
  }
  async function link(candidate: GateCandidate) {
    if (!status || stale || gateLinkBlockReason(status, candidate)) return;
    await run("Linking gates and syncing the blockchain", async () => {
      const authorized = await access();
      if (!current()) return;
      const next = await api.link(itemID, authorized.token, candidate.itemID);
      accept(next);
      if (current())
        setNotice(
          next.chain.status === "synced"
            ? `Linked to ${candidate.name || `Gate ${candidate.itemID}`}. The game and blockchain are synced.`
            : `Linked to ${candidate.name || `Gate ${candidate.itemID}`} in game. Blockchain synchronization still needs attention.`,
        );
    });
  }
  async function unlink() {
    const destinationGateID = status?.gate.destinationGateID;
    if (!destinationGateID || stale) return;
    await run("Unlinking gates and syncing the blockchain", async () => {
      const authorized = await access();
      if (!current()) return;
      const next = await api.unlink(
        itemID,
        authorized.token,
        destinationGateID,
      );
      accept(next);
      if (current())
        setNotice(
          next.chain.status === "synced"
            ? "The gates are unlinked in game and on the blockchain."
            : "The gates are unlinked in game. Blockchain synchronization still needs attention.",
        );
    });
  }
  function queue(
    action: "link" | "unlink",
    targetID: number,
    targetName: string,
  ) {
    if (!onQueueTask || disabled || busy || !canAccess || !status || stale)
      return;
    onQueueTask({
      title: `${action === "link" ? "Link" : "Unlink"} ${assembly.name}`,
      details: `${action === "link" ? "Link to" : "Unlink from"} ${targetName} · Gate #${targetID}. Eligibility is checked when this task runs.`,
      assembly,
      operation: {
        kind: action === "link" ? "gate-link" : "gate-unlink",
        targetID,
      },
    });
    setNotice(
      `${action === "link" ? "Link" : "Unlink"} added to the task queue.`,
    );
  }
  async function sync(targetID = itemID) {
    await run("Syncing gate links with the blockchain", async () => {
      const authorized = await access();
      if (!current()) return;
      const target = await api.sync(targetID, authorized.token);
      if (!current()) return;
      const next =
        targetID === itemID
          ? target
          : await api.status(itemID, authorized.token);
      accept(next);
      if (current())
        setNotice(
          target.chain.status === "synced"
            ? `Gate ${targetID} matches the blockchain.`
            : "Blockchain synchronization is not yet complete. Check the status below.",
        );
    });
  }

  return (
    <section
      className="panel detail-panel energy-panel gate-panel"
      aria-busy={!!busy}
    >
      <div className="section-kicker">SMART GATE / DESTINATION</div>
      <h2>Link your gates.</h2>
      <p>
        Link two gates of the same type within their configured range. Both
        gates must belong to your character and be synced with the blockchain.
      </p>
      <div className="energy-toolbar">
        <button
          className={!status ? "primary" : ""}
          disabled={disabled || !!busy || !canAccess}
          onClick={() => void refresh()}
        >
          {busy || (status ? "Refresh gate links" : "Load gate links")}
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
          {!wallet || !isOwner
            ? "Connect the gate owner's wallet to view compatible gates and manage its destination."
            : "This gate needs a valid game item ID to manage its destination."}
        </p>
      )}
      {error && (
        <p className="energy-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {status && (
        <>
          <dl className="energy-summary gate-summary">
            <div>
              <dt>Gate type</dt>
              <dd>
                {typeName(status.gate.typeID)}{" "}
                <small>({status.gate.typeID})</small>
              </dd>
            </div>
            <div>
              <dt>Configured game range</dt>
              <dd>
                {amount(status.rangeLightYears)} <small>ly</small>
              </dd>
            </div>
            <div>
              <dt>Blockchain maximum</dt>
              <dd>
                {status.chain.maxDistanceMeters === undefined ? (
                  <small>Unavailable</small>
                ) : (
                  <>
                    {amount(
                      Number(status.chain.maxDistanceMeters) /
                        METERS_PER_LIGHT_YEAR,
                    )}{" "}
                    <small>ly</small>
                  </>
                )}
              </dd>
            </div>
          </dl>
          <div className="gate-chain-status">
            <div>
              <span
                className={`state ${status.chain.status === "synced" && !stale ? "online" : "unknown"}`}
              >
                {stale ? "REFRESH REQUIRED" : chainLabels[status.chain.status]}
              </span>
              <p>
                {status.chain.message ||
                  (status.chain.status === "synced"
                    ? "The game and blockchain agree on this gate's destination."
                    : "Blockchain synchronization must complete before creating a new link.")}
              </p>
              {status.chain.gateObjectID && (
                <code>Gate object: {status.chain.gateObjectID}</code>
              )}
              {status.chain.linkedGateObjectID && (
                <code>Linked object: {status.chain.linkedGateObjectID}</code>
              )}
            </div>
            {status.chain.status !== "synced" && (
              <button
                disabled={
                  disabled ||
                  !!busy ||
                  !canAccess ||
                  status.chain.status === "disabled"
                }
                onClick={() => void sync()}
              >
                Sync chain
              </button>
            )}
          </div>
          <h3>Current destination</h3>
          {status.gate.destinationGateID ? (
            <div className="gate-destination">
              <div>
                <b>
                  {status.destination?.name ||
                    `Gate ${status.gate.destinationGateID}`}
                </b>
                <small>
                  #{status.gate.destinationGateID}
                  {status.destination
                    ? ` · ${typeName(status.destination.typeID)} · System ${status.destination.solarSystemID}`
                    : ""}
                </small>
              </div>
              <div className="gate-row-actions">
                <button
                  disabled={disabled || !!busy || stale || !canAccess}
                  onClick={() => void unlink()}
                >
                  Unlink gates
                </button>
                {onQueueTask && (
                  <button
                    disabled={disabled || !!busy || stale || !canAccess}
                    onClick={() =>
                      queue(
                        "unlink",
                        status.gate.destinationGateID!,
                        status.destination?.name ||
                          `Gate ${status.gate.destinationGateID}`,
                      )
                    }
                  >
                    Queue unlink
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="storage-empty">
              This gate has no linked destination.
            </p>
          )}
          <h3>Compatible gates</h3>
          <p>
            Your other {typeName(status.gate.typeID)} gates. Blockchain range
            updates to the client configuration when linking.
          </p>
          {status.candidates.length ? (
            <div className="inventory-scroll">
              <table className="inventory-table energy-table">
                <caption>Gate destinations and link eligibility</caption>
                <thead>
                  <tr>
                    <th>Gate</th>
                    <th>Distance</th>
                    <th>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {status.candidates.map((candidate) => {
                    const reason = gateLinkBlockReason(status, candidate);
                    return (
                      <tr key={candidate.itemID}>
                        <td>
                          <b>{candidate.name || `Gate ${candidate.itemID}`}</b>
                          <small>
                            #{candidate.itemID} · {typeName(candidate.typeID)}
                          </small>
                          <small>System {candidate.solarSystemID}</small>
                        </td>
                        <td>
                          {candidate.distanceLightYears === null
                            ? "Unavailable"
                            : `${amount(candidate.distanceLightYears)} ly`}
                        </td>
                        <td>
                          <div className="gate-row-actions">
                            <button
                              disabled={
                                disabled ||
                                !!busy ||
                                stale ||
                                !canAccess ||
                                !!reason
                              }
                              onClick={() => void link(candidate)}
                            >
                              Link gate
                            </button>
                            {onQueueTask && (
                              <button
                                disabled={
                                  disabled ||
                                  !!busy ||
                                  stale ||
                                  !canAccess ||
                                  candidate.itemID === status.gate.itemID ||
                                  candidate.typeID !== status.gate.typeID
                                }
                                onClick={() =>
                                  queue(
                                    "link",
                                    candidate.itemID,
                                    candidate.name ||
                                      `Gate ${candidate.itemID}`,
                                  )
                                }
                              >
                                Queue link
                              </button>
                            )}
                            <button
                              disabled={
                                disabled ||
                                !!busy ||
                                !canAccess ||
                                status.chain.status === "disabled"
                              }
                              onClick={() =>
                                void sync(String(candidate.itemID))
                              }
                            >
                              Sync gate
                            </button>
                          </div>
                          {reason && <small>{reason}</small>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="storage-empty">
              No other owned gates of this type are available.
            </p>
          )}
        </>
      )}
    </section>
  );
}
