import { useEffect, useState } from "react";
import type { AssemblyConfig } from "../assembly/types.ts";
import { loadNetworkNodeFuel, projectFuel } from "../assembly/fuel.ts";
import type { NetworkNodeFuelSnapshot } from "../assembly/fuel.ts";
import { useLocalizedTypeNames } from "../localization/type-names.ts";

interface Props {
  assemblyId: string | null;
  config: AssemblyConfig;
  tenant?: string;
  visible: boolean;
}

function duration(milliseconds: number) {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function FuelMonitorPanel({
  assemblyId,
  config,
  tenant,
  visible,
}: Props) {
  const [sample, setSample] = useState<{
    fuel: NetworkNodeFuelSnapshot;
    receivedAt: number;
    assemblyId: string;
  } | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!visible || !assemblyId) return;
    let cancelled = false;
    let reading = false;
    async function read() {
      if (reading || document.hidden) return;
      reading = true;
      setLoading(true);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const fuel = await Promise.race([
          loadNetworkNodeFuel(config, assemblyId!),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Fuel readings timed out. Check the connection and refresh fuel.",
                  ),
                ),
              15000,
            );
          }),
        ]);
        if (cancelled) return;
        const currentTime = performance.now();
        // The clock may arrive before the efficiency lookup. Carry that elapsed
        // time forward, then use a monotonic clock for the visible countdown.
        const receivedAt =
          currentTime - Math.max(0, Date.now() - fuel.observedAtMs);
        setSample({ fuel, receivedAt, assemblyId: assemblyId! });
        setNow(currentTime);
        setError("");
      } catch (cause) {
        if (!cancelled) {
          setSample(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        clearTimeout(timeout);
        reading = false;
        if (!cancelled) setLoading(false);
      }
    }
    setSample(null);
    setError("");
    void read();
    const poll = setInterval(() => void read(), 10000);
    const tick = setInterval(() => {
      if (!document.hidden) setNow(performance.now());
    }, 1000);
    const onVisible = () => {
      if (!document.hidden) void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [assemblyId, config, visible, revision]);

  const reading =
    sample?.assemblyId === assemblyId
      ? projectFuel(sample.fuel, Math.max(0, now - sample.receivedAt))
      : null;
  const typeName = useLocalizedTypeNames(
    [reading?.typeId],
    tenant || config.defaultTenant,
  );
  const state = reading?.state;
  const remaining = reading?.remainingUnitMs;
  const stateLabel =
    state === "burning"
      ? "Burning"
      : state === "paused"
        ? "Paused"
        : state === "empty"
          ? "No fuel"
          : "Unavailable";

  return (
    <section
      className="panel fuel-monitor"
      aria-label="Network node fuel monitor"
      hidden={!visible}
    >
      <div className="fuel-monitor-heading">
        <span className="section-kicker">NETWORK NODE / FUEL</span>
        <span
          className={`fuel-monitor-state ${state === "burning" ? "positive" : "muted"}`}
        >
          {reading ? stateLabel : loading ? "Loading…" : "Unavailable"}
        </span>
      </div>
      <dl className="fuel-monitor-readings">
        <div>
          <dt>Fuel type</dt>
          <dd>
            {reading?.typeId
              ? typeName(reading.typeId, reading.typeName)
              : reading?.typeName || (loading ? "Loading…" : "—")}
          </dd>
        </div>
        <div>
          <dt>Current unit remaining</dt>
          <dd className="fuel-countdown">
            {remaining != null ? duration(remaining) : "—"}
          </dd>
        </div>
      </dl>
      {reading?.unitDurationMs != null && remaining != null && (
        <meter
          className="fuel-monitor-meter"
          min={0}
          max={reading.unitDurationMs}
          value={remaining}
          aria-label="Current fuel unit remaining"
        />
      )}
      <div className="fuel-monitor-footer">
        <span>
          {state === "paused"
            ? "Burn paused"
            : state === "empty"
              ? "No fuel to burn"
              : state === "unavailable"
                ? "Burn time unavailable"
                : error
                  ? "Readings unavailable"
                  : "Updates automatically"}
        </span>
        <button
          disabled={!assemblyId || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh fuel
        </button>
      </div>
      {!assemblyId && <p>Load a Network Node to monitor its fuel.</p>}
      {error && (
        <p className="energy-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
