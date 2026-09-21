import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AssemblySnapshot } from "../assembly/types.ts";
import type { TaskQueue } from "../tasks/queue.ts";
import type { EnqueueTask } from "../tasks/types.ts";
import { QueueAutomationControls } from "./QueueAutomationControls.tsx";

export function TaskQueuePanel({ queue, disabled, progress, onRun, onRepeat, onExport, onImport, assembly, onQueueTask }: {
  queue: TaskQueue;
  disabled: boolean;
  progress: string;
  onRun: () => void;
  onRepeat: () => void;
  onExport: () => void;
  onImport: (file: File) => Promise<void>;
  assembly: AssemblySnapshot | null;
  onQueueTask: EnqueueTask;
}) {
  const { tasks, running, stopRequested, runStartedAtMs, deadlineAtMs } = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const pending = tasks.filter(task => task.status === "queued").length;
  const completed = tasks.filter(task => task.status === "completed").length;
  const failed = tasks.some(task => task.status === "failed");
  const canRepeat = completed > 0 && completed === tasks.length;
  const queuedRepeat = tasks.some(task => task.status === "queued" && task.operation.kind === "queue-repeat");
  const canQueueRepeat = tasks.some(task => task.status === "queued" && task.operation.kind !== "queue-repeat" && task.operation.kind !== "queue-timeout");
  const activeWait = tasks.find(task => task.status === "running" &&
    (task.operation.kind === "inventory-listener" || task.operation.kind === "queue-delay"));
  async function importFile(file: File | undefined) {
    if (!file || importing) return;
    setImporting(true);
    try { await onImport(file); }
    finally {
      setImporting(false);
      if (input.current) input.current.value = "";
    }
  }
  return <section className="panel task-queue" aria-labelledby="task-queue-title">
    <div className="task-queue-heading">
      <div><div className="section-kicker">STAGE / REVIEW / EXECUTE</div><h2 id="task-queue-title">Task queue <span className="muted">({pending})</span></h2></div>
      <div className="task-queue-actions">
        {running
          ? <button disabled={stopRequested} onClick={() => queue.stop()}>{stopRequested ? "Stopping…" : activeWait ? "Stop current wait" : "Stop after current task"}</button>
          : canRepeat
            ? <button className="primary" disabled={disabled} onClick={onRepeat}>Repeat queue ({completed})</button>
            : <button className="primary" disabled={disabled || !pending || failed} onClick={onRun}>Run queue ({pending})</button>}
        <button disabled={running || importing || disabled} onClick={() => input.current?.click()}>{importing ? "Importing…" : "Import queue"}</button>
        <input ref={input} className="task-queue-file" type="file" accept="application/json,.json" aria-label="Queue JSON file" onChange={event => void importFile(event.target.files?.[0])} />
        <button disabled={running || !pending || disabled} onClick={onExport}>Export queue</button>
        <button disabled={running || !pending} onClick={() => queue.clearPending()}>Clear pending</button>
        <button disabled={running || disabled || !canQueueRepeat || queuedRepeat} onClick={() => queue.enqueueRepeat()}>{queuedRepeat ? "Continuous repeat queued" : "Queue continuous repeat"}</button>
        {tasks.some(task => task.status === "completed") && <button disabled={running} onClick={() => queue.clearCompleted()}>Clear completed</button>}
      </div>
    </div>
    <p>Add tasks from assembly controls, review their order here, then run them one at a time. Wallet approvals happen as needed. After the whole queue completes, you can repeat the same sequence with fresh state checks, or queue a continuous repeat that runs until stopped or a task is no longer valid. Export pending tasks to a JSON file to restore them later with the same wallet and deployment.</p>
    {running && <p className="positive" role="status">{progress || "Running queued tasks…"}</p>}
    {running && runStartedAtMs !== null && <p className="queue-clock" role="timer">Elapsed {Math.max(0, Math.floor((clock - runStartedAtMs) / 1000))}s{deadlineAtMs !== null ? ` · overall timer ${Math.max(0, Math.ceil((deadlineAtMs - clock) / 1000))}s remaining` : ""}</p>}
    {failed && <p className="energy-error" role="alert">Queue stopped. Inspect the failed task's result and any pending transaction in its assembly controls, then dismiss it to continue. Failed tasks are never retried automatically.</p>}
    {tasks.length ? <ol className="task-queue-list">{tasks.map((task, index) => <li key={task.id} data-task-status={task.status}>
      <div className="task-queue-description">
        <b>{task.title}</b><span>{task.operation.kind === "queue-repeat" || task.operation.kind === "queue-timeout" ? "Queue control" : `${task.assembly.name} · #${task.assembly.itemId || task.assembly.id}`}</span>
        <p>{task.details}</p>{task.operation.kind !== "queue-repeat" && task.operation.kind !== "queue-timeout" && <small>Wallet {task.walletAddress}</small>}
        {task.result && <p>{task.result.message}</p>}
        {task.result?.digest && <code>{task.result.digest}</code>}
        {task.error && <p className="energy-error">{task.error}</p>}
      </div>
      <div className="task-queue-controls">
        <span className={`state ${task.status === "completed" ? "online" : task.status === "failed" ? "offline" : "unknown"}`}>{task.status.toUpperCase()}</span>
        {task.status === "queued" && task.operation.kind !== "queue-repeat" && task.operation.kind !== "queue-timeout" && <div className="task-queue-actions">
          <button aria-label={`Move task ${index + 1} up`} disabled={running || tasks[index - 1]?.status !== "queued" || tasks[index - 1]?.operation.kind === "queue-repeat" || tasks[index - 1]?.operation.kind === "queue-timeout"} onClick={() => queue.move(task.id, -1)}>↑</button>
          <button aria-label={`Move task ${index + 1} down`} disabled={running || tasks[index + 1]?.status !== "queued" || tasks[index + 1]?.operation.kind === "queue-repeat" || tasks[index + 1]?.operation.kind === "queue-timeout"} onClick={() => queue.move(task.id, 1)}>↓</button>
        </div>}
        <button disabled={running} onClick={() => queue.remove(task.id)}>{task.status === "failed" ? "Dismiss after checking" : "Remove"}</button>
      </div>
    </li>)}</ol> : <p className="storage-empty">No queued tasks. Use the Queue buttons beside an operation to stage it.</p>}
    <QueueAutomationControls queue={queue} assembly={assembly} disabled={disabled || running} onQueueTask={onQueueTask} />
  </section>;
}
