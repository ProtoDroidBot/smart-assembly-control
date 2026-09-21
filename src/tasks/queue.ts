import type { TaskDraft, TaskResult } from "./types.ts";

export const MAX_QUEUE_TASKS = 100;

export interface QueuedTask extends TaskDraft {
  id: number;
  walletIdentity: object;
  walletAddress: string;
  status: "queued" | "running" | "completed" | "failed";
  result?: TaskResult;
  error?: string;
}

export interface QueueSnapshot {
  tasks: QueuedTask[];
  running: boolean;
  stopRequested: boolean;
  runStartedAtMs: number | null;
  deadlineAtMs: number | null;
}

function isOverallTimer(task: TaskDraft) {
  return task.operation.kind === "queue-timeout";
}

function isInterruptibleWait(task: TaskDraft) {
  return task.operation.kind === "inventory-listener" || task.operation.kind === "queue-delay";
}

/** Session-only intents. Never store signatures, expiring authorizations, or executable closures here. */
export function createTaskQueue(options: {
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
} = {}) {
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let snapshot: QueueSnapshot = { tasks: [], running: false, stopRequested: false, runStartedAtMs: null, deadlineAtMs: null };
  let nextID = 1;
  let activeTask: QueuedTask | null = null;
  let activeController: AbortController | null = null;
  const listeners = new Set<() => void>();
  function publish(update: Partial<QueueSnapshot>) {
    snapshot = { ...snapshot, ...update };
    for (const listener of listeners) listener();
  }
  function updateTask(id: number, update: Partial<QueuedTask>) {
    publish({ tasks: snapshot.tasks.map(task => task.id === id ? { ...task, ...update } : task) });
  }
  function queuedTask(draft: TaskDraft, walletIdentity: object, walletAddress: string): QueuedTask {
    return { ...structuredClone(draft), id: nextID++, walletIdentity, walletAddress, status: "queued" };
  }
  function freshDraft({ title, details, assembly, operation }: TaskDraft): TaskDraft {
    const draft = structuredClone({ title, details, assembly, operation });
    if (draft.operation.kind === "industry-transfer" || draft.operation.kind === "industry-blueprint" || draft.operation.kind === "industry-empty")
      draft.operation.request.requestID = crypto.randomUUID();
    return draft;
  }
  function insertBeforeRepeat(tasks: QueuedTask[], additions: readonly QueuedTask[]) {
    const repeat = tasks.findIndex(task => task.operation.kind === "queue-repeat");
    const index = repeat < 0 ? tasks.length : repeat;
    return [...tasks.slice(0, index), ...additions, ...tasks.slice(index)];
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    enqueue(draft: TaskDraft, walletIdentity: object, walletAddress: string) {
      if (snapshot.running || snapshot.tasks.length >= MAX_QUEUE_TASKS || draft.operation.kind === "queue-repeat") return false;
      const task = queuedTask(draft, walletIdentity, walletAddress);
      publish({ tasks: insertBeforeRepeat(snapshot.tasks, [task]) });
      return true;
    },
    importTasks(drafts: readonly TaskDraft[], walletIdentity: object, walletAddress: string) {
      if (snapshot.running) throw new Error("Stop the queue before importing tasks.");
      if (!drafts.length) throw new Error("The queue file has no tasks to import.");
      if (snapshot.tasks.length + drafts.length > MAX_QUEUE_TASKS)
        throw new Error(`The task queue can contain at most ${MAX_QUEUE_TASKS} tasks. Remove tasks before importing this file.`);
      const repeat = drafts.findIndex(draft => draft.operation.kind === "queue-repeat");
      if ((repeat >= 0 && repeat !== drafts.length - 1) || drafts.filter(draft => draft.operation.kind === "queue-repeat").length > 1)
        throw new Error("A queue can contain one repeat action, and it must be last.");
      if (repeat >= 0 && snapshot.tasks.some(task => task.operation.kind === "queue-repeat"))
        throw new Error("The task queue already contains a repeat action.");
      if (drafts.filter(isOverallTimer).length + snapshot.tasks.filter(isOverallTimer).length > 1)
        throw new Error("The task queue can contain only one overall timer.");
      const tasks = drafts.map(draft => queuedTask(draft, walletIdentity, walletAddress));
      publish({ tasks: insertBeforeRepeat(snapshot.tasks, tasks) });
      return tasks.length;
    },
    enqueueRepeat() {
      if (snapshot.running || snapshot.tasks.length >= MAX_QUEUE_TASKS || snapshot.tasks.some(task => task.operation.kind === "queue-repeat")) return false;
      const source = [...snapshot.tasks].reverse().find(task => task.status === "queued" && task.operation.kind !== "queue-repeat" && !isOverallTimer(task));
      if (!source) return false;
      const repeat = queuedTask({
        title: "Repeat queue continuously",
        details: "After every preceding task completes, run fresh copies of the same actions again while they remain valid. Stop after the current task at any time.",
        assembly: source.assembly,
        operation: { kind: "queue-repeat" },
      }, source.walletIdentity, source.walletAddress);
      publish({ tasks: [...snapshot.tasks, repeat] });
      return true;
    },
    enqueueDelay(seconds: number) {
      if (snapshot.running || snapshot.tasks.length >= MAX_QUEUE_TASKS || !Number.isInteger(seconds) || seconds < 1 || seconds > 86400) return false;
      const source = [...snapshot.tasks].reverse().find(task => task.status === "queued" && task.operation.kind !== "queue-repeat" && !isOverallTimer(task));
      if (!source) return false;
      const delay = queuedTask({
        title: `Retry after ${seconds}s`,
        details: `Wait ${seconds} ${seconds === 1 ? "second" : "seconds"} before the next action. This wait makes no server requests.`,
        assembly: source.assembly,
        operation: { kind: "queue-delay", seconds },
      }, source.walletIdentity, source.walletAddress);
      publish({ tasks: insertBeforeRepeat(snapshot.tasks, [delay]) });
      return true;
    },
    enqueueTimeout(seconds: number) {
      if (snapshot.running || snapshot.tasks.length >= MAX_QUEUE_TASKS || snapshot.tasks.some(isOverallTimer) ||
          !Number.isInteger(seconds) || seconds < 1 || seconds > 604800) return false;
      const source = snapshot.tasks.find(task => task.status === "queued" && task.operation.kind !== "queue-repeat" && !isOverallTimer(task));
      if (!source) return false;
      const timer = queuedTask({
        title: `Overall queue timer · ${seconds}s`,
        details: `Limit this queue run, including continuous repeats, to ${seconds} ${seconds === 1 ? "second" : "seconds"}. A read-only listener or delay is stopped at the deadline; an in-flight write is allowed to finish.`,
        assembly: source.assembly,
        operation: { kind: "queue-timeout", seconds },
      }, source.walletIdentity, source.walletAddress);
      publish({ tasks: [timer, ...snapshot.tasks] });
      return true;
    },
    remove(id: number) {
      if (!snapshot.running) publish({ tasks: snapshot.tasks.filter(task => task.id !== id) });
    },
    move(id: number, direction: -1 | 1) {
      if (snapshot.running) return;
      const tasks = [...snapshot.tasks];
      const index = tasks.findIndex(task => task.id === id);
      const target = index + direction;
      if (index < 0 || tasks[index].status !== "queued" || tasks[target]?.status !== "queued" ||
          tasks[index].operation.kind === "queue-repeat" || tasks[target].operation.kind === "queue-repeat" ||
          isOverallTimer(tasks[index]) || isOverallTimer(tasks[target])) return;
      [tasks[index], tasks[target]] = [tasks[target], tasks[index]];
      publish({ tasks });
    },
    clearCompleted() {
      if (!snapshot.running) publish({ tasks: snapshot.tasks.filter(task => task.status !== "completed") });
    },
    clearPending() {
      if (!snapshot.running) publish({ tasks: snapshot.tasks.filter(task => task.status !== "queued") });
    },
    repeatCompleted() {
      if (snapshot.running || !snapshot.tasks.length || snapshot.tasks.some(task => task.status !== "completed")) return false;
      const tasks = snapshot.tasks.filter(task => task.operation.kind !== "queue-repeat").map(task =>
        queuedTask(freshDraft(task), task.walletIdentity, task.walletAddress));
      if (!tasks.length) return false;
      publish({ tasks });
      return true;
    },
    stop() {
      if (snapshot.running) {
        publish({ stopRequested: true });
        if (activeTask && isInterruptibleWait(activeTask)) activeController?.abort();
      }
    },
    async run(execute: (task: QueuedTask, signal?: AbortSignal) => Promise<TaskResult>) {
      if (snapshot.running || snapshot.tasks.some(task => task.status === "failed")) return;
      let pending = snapshot.tasks.filter(task => task.status === "queued");
      const timerTask = pending.find(isOverallTimer) || null;
      pending = pending.filter(task => !isOverallTimer(task));
      if (!pending.length) return;
      const repeatable = snapshot.tasks.filter(task => task.operation.kind !== "queue-repeat" && !isOverallTimer(task)).map(task => ({
        draft: freshDraft(task), walletIdentity: task.walletIdentity, walletAddress: task.walletAddress,
      }));
      const runStartedAtMs = now();
      const deadlineAtMs = timerTask && timerTask.operation.kind === "queue-timeout"
        ? runStartedAtMs + timerTask.operation.seconds * 1000 : null;
      let timerExpired = false;
      let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
      // Synchronous lock prevents double-clicks and edits before the first await.
      publish({ running: true, stopRequested: false, runStartedAtMs, deadlineAtMs });
      if (timerTask && timerTask.operation.kind === "queue-timeout") {
        updateTask(timerTask.id, { status: "completed", result: {
          message: `Overall ${timerTask.operation.seconds}-second queue timer armed.`,
        } });
        deadlineHandle = setTimer(() => {
          timerExpired = true;
          publish({ stopRequested: true });
          if (activeTask && isInterruptibleWait(activeTask)) activeController?.abort();
        }, timerTask.operation.seconds * 1000);
      }
      try {
        while (pending.length) {
          if (snapshot.stopRequested) break;
          const task = pending.shift()!;
          if (task.operation.kind === "queue-repeat") {
            updateTask(task.id, { status: "running" });
            const repeated = repeatable.map(({ draft, walletIdentity, walletAddress }) => queuedTask(freshDraft(draft), walletIdentity, walletAddress));
            const control = queuedTask(freshDraft(task), task.walletIdentity, task.walletAddress);
            pending = [...repeated, control];
            const timer = timerTask ? snapshot.tasks.find(item => item.id === timerTask.id) : null;
            publish({ tasks: [...(timer ? [timer] : []), ...pending] });
            continue;
          }
          updateTask(task.id, { status: "running" });
          activeTask = task;
          activeController = new AbortController();
          try {
            const result = await execute(task, activeController.signal);
            updateTask(task.id, { status: "completed", result });
          } catch (cause) {
            if (activeController.signal.aborted && snapshot.stopRequested) {
              updateTask(task.id, { status: "queued", error: undefined });
              break;
            }
            updateTask(task.id, { status: "failed", error: cause instanceof Error ? cause.message : String(cause) });
            break;
          } finally {
            activeTask = null;
            activeController = null;
          }
          if (timerExpired) break;
        }
      } finally {
        if (deadlineHandle) clearTimer(deadlineHandle);
        activeTask = null;
        activeController = null;
        const unfinished = snapshot.tasks.some(task => task.status === "queued" && !isOverallTimer(task));
        if (timerTask && snapshot.stopRequested && unfinished)
          updateTask(timerTask.id, { status: "queued", result: undefined, error: undefined });
        publish({ running: false, stopRequested: false, runStartedAtMs: null, deadlineAtMs: null });
      }
    },
  };
}

export type TaskQueue = ReturnType<typeof createTaskQueue>;
