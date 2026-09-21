import { useEffect, useState } from "react";
import type { AssemblySnapshot } from "../assembly/types.ts";
import type { TaskQueue } from "../tasks/queue.ts";
import type { EnqueueTask } from "../tasks/types.ts";
import type { InventoryListenerSpace, InventoryListenerTargetKind } from "../storage/client.ts";

type Requirement = { typeID: string; quantity: string };
const positive = (value: string, maximum: number, label: string) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum)
    throw new Error(`${label} must be a positive whole number no greater than ${maximum.toLocaleString()}.`);
  return Number(value);
};

export function QueueAutomationControls({ queue, assembly, disabled, onQueueTask }: {
  queue: TaskQueue;
  assembly: AssemblySnapshot | null;
  disabled: boolean;
  onQueueTask: EnqueueTask;
}) {
  const [targetKind, setTargetKind] = useState<InventoryListenerTargetKind>("smart-assembly");
  const [inventory, setInventory] = useState<Exclude<InventoryListenerSpace, "cargo">>("storage");
  const [targetID, setTargetID] = useState(assembly?.itemId || "");
  const [requested, setRequested] = useState<Requirement[]>([{ typeID: "", quantity: "1" }]);
  const [retryAfter, setRetryAfter] = useState("30");
  const [maximumWait, setMaximumWait] = useState("3600");
  const [unlimited, setUnlimited] = useState(false);
  const [delay, setDelay] = useState("60");
  const [queueTimer, setQueueTimer] = useState("3600");
  const [error, setError] = useState("");
  useEffect(() => { setTargetID(assembly?.itemId || ""); }, [assembly?.id, assembly?.itemId]);

  function queueListener() {
    if (!assembly || disabled) return;
    setError("");
    try {
      const target = positive(targetID, Number.MAX_SAFE_INTEGER, "Target game item ID");
      const requirements = requested.map((item, index) => ({
        typeID: positive(item.typeID, 0xffff_ffff, `Item ${index + 1} type ID`),
        quantity: positive(item.quantity, 0xffff_ffff, `Item ${index + 1} quantity`),
      }));
      if (new Set(requirements.map(item => item.typeID)).size !== requirements.length)
        throw new Error("Each requested item type may appear only once.");
      const retryAfterSeconds = positive(retryAfter, 86400, "Retry delay");
      const timeoutSeconds = unlimited ? null : positive(maximumWait, 604800, "Maximum listener wait");
      const selectedInventory: InventoryListenerSpace = targetKind === "cargo" ? "cargo" : inventory;
      onQueueTask({
        title: "Listen for requested items",
        details: `Wait for ${requirements.map(item => `${item.quantity.toLocaleString()} × type ${item.typeID}`).join(", ")} in ${selectedInventory} inventory #${target}. Retry every ${retryAfterSeconds}s${timeoutSeconds === null ? " without a listener timeout" : ` for up to ${timeoutSeconds}s`}.`,
        assembly,
        operation: {
          kind: "inventory-listener",
          request: { targetKind, targetID: target, inventory: selectedInventory, requested: requirements },
          retryAfterSeconds,
          timeoutSeconds,
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function addDelay() {
    setError("");
    try {
      const seconds = positive(delay, 86400, "Retry delay");
      if (!queue.enqueueDelay(seconds)) throw new Error("Add an executable queue action before adding a retry delay.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function addTimer() {
    setError("");
    try {
      const seconds = positive(queueTimer, 604800, "Overall queue timer");
      if (!queue.enqueueTimeout(seconds)) throw new Error("Add an action first, or remove the existing overall queue timer.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <div className="queue-automation">
    <div className="storage-heading"><h3>Inventory listener</h3><span className="muted">READ-ONLY</span></div>
    <p>Pause the queue until all requested item quantities exist in an accessible Smart Storage or Industry inventory, active ship, Field Storage, or nearby cargo container.</p>
    <div className="queue-automation-grid">
      <label>Target type<select value={targetKind} disabled={disabled} onChange={event => {
        const value = event.target.value as InventoryListenerTargetKind;
        setTargetKind(value);
      }}><option value="smart-assembly">Smart Assembly</option><option value="cargo">Ship / Field Storage / cargo</option></select></label>
      <label>Game item ID<input aria-label="Listener target game item ID" inputMode="numeric" value={targetID} disabled={disabled} onChange={event => setTargetID(event.target.value)} /></label>
      {targetKind === "smart-assembly" && <label>Inventory<select value={inventory} disabled={disabled} onChange={event => setInventory(event.target.value as typeof inventory)}>
        <option value="storage">Smart Storage</option><option value="inputs">Industry inputs</option><option value="outputs">Industry outputs</option>
      </select></label>}
      <label>Retry after seconds<input aria-label="Listener retry seconds" inputMode="numeric" value={retryAfter} disabled={disabled} onChange={event => setRetryAfter(event.target.value)} /></label>
      <label>Maximum wait seconds<input aria-label="Listener maximum wait seconds" inputMode="numeric" value={maximumWait} disabled={disabled || unlimited} onChange={event => setMaximumWait(event.target.value)} /></label>
      <label className="queue-automation-check"><input type="checkbox" checked={unlimited} disabled={disabled} onChange={event => setUnlimited(event.target.checked)} />No listener timeout</label>
    </div>
    <div className="queue-requirements">
      {requested.map((item, index) => <div key={index}>
        <label>Item type ID<input aria-label={`Listener item ${index + 1} type ID`} inputMode="numeric" value={item.typeID} disabled={disabled} onChange={event => setRequested(values => values.map((value, at) => at === index ? { ...value, typeID: event.target.value } : value))} /></label>
        <label>Required quantity<input aria-label={`Listener item ${index + 1} quantity`} inputMode="numeric" value={item.quantity} disabled={disabled} onChange={event => setRequested(values => values.map((value, at) => at === index ? { ...value, quantity: event.target.value } : value))} /></label>
        {requested.length > 1 && <button disabled={disabled} onClick={() => setRequested(values => values.filter((_, at) => at !== index))}>Remove item</button>}
      </div>)}
    </div>
    <div className="task-queue-actions">
      <button disabled={disabled || requested.length >= 100} onClick={() => setRequested(values => [...values, { typeID: "", quantity: "1" }])}>Add requested item</button>
      <button className="primary" disabled={disabled || !assembly} onClick={queueListener}>Queue listener</button>
    </div>
    <div className="queue-timing-controls">
      <label>Retry delay seconds<input aria-label="Queue retry delay seconds" inputMode="numeric" value={delay} disabled={disabled} onChange={event => setDelay(event.target.value)} /></label>
      <button disabled={disabled} onClick={addDelay}>Queue retry delay</button>
      <label>Overall timer seconds<input aria-label="Overall queue timer seconds" inputMode="numeric" value={queueTimer} disabled={disabled} onChange={event => setQueueTimer(event.target.value)} /></label>
      <button disabled={disabled} onClick={addTimer}>Queue overall timer</button>
    </div>
    {error && <p className="energy-error" role="alert">{error}</p>}
  </div>;
}

