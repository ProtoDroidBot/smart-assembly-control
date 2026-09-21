import test from "node:test";
import assert from "node:assert/strict";
import { createTaskQueue } from "../src/tasks/queue.ts";
import type { TaskDraft } from "../src/tasks/types.ts";

const wallet = {};
function draft(title = "Transfer"): TaskDraft {
  return {
    title, details: "Move 5 items",
    assembly: { id: "0x1", itemId: "1", name: "Storage" } as TaskDraft["assembly"],
    operation: { kind: "storage-transfer", direction: "deposit", selected: 2, quantity: "5" },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("staging captures independent immutable intents and makes no execution calls", async () => {
  const queue = createTaskQueue();
  const intent = draft();
  queue.enqueue(intent, wallet, "0x99");
  intent.assembly.id = "0x2";
  intent.operation = { kind: "storage-transfer", direction: "withdraw", selected: 99, quantity: "500" };
  queue.enqueue(intent, wallet, "0x99");
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.assembly.id), ["0x1", "0x2"]);
  const seen = [];
  await queue.run(async task => { seen.push(task.operation); return { message: "Committed" }; });
  assert.deepEqual(seen, [draft().operation, intent.operation]);
});

test("FIFO waits for confirmation, blocks double runs and locks edits", async () => {
  const queue = createTaskQueue();
  queue.enqueue(draft("First"), wallet, "0x99");
  queue.enqueue(draft("Second"), wallet, "0x99");
  const first = deferred<{ message: string }>();
  const seen: string[] = [];
  const running = queue.run(async task => {
    seen.push(task.title);
    return task.title === "First" ? first.promise : { message: "Committed" };
  });
  await queue.run(async () => { throw new Error("Double run"); });
  queue.remove(1);
  queue.move(3, -1);
  queue.clearPending();
  assert.equal(queue.enqueue(draft("Third"), wallet, "0x99"), false);
  assert.deepEqual(seen, ["First"]);
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.status), ["running", "queued"]);
  first.resolve({ message: "First confirmed" });
  await running;
  assert.deepEqual(seen, ["First", "Second"]);
  assert.ok(queue.getSnapshot().tasks.every(task => task.status === "completed"));
});

test("uncertain failure stops later work and is never automatically replayed", async () => {
  const queue = createTaskQueue();
  queue.enqueue(draft("First"), wallet, "0x99");
  queue.enqueue(draft("Second"), wallet, "0x99");
  let calls = 0;
  const execute = async () => { calls++; throw new Error("Response lost; inspect operation"); };
  await queue.run(execute);
  await queue.run(execute);
  assert.equal(calls, 1);
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.status), ["failed", "queued"]);
  queue.remove(1);
  await queue.run(async task => { assert.equal(task.title, "Second"); return { message: "Committed" }; });
  assert.equal(queue.getSnapshot().tasks[0].status, "completed");
});

test("stop finishes only the current task; resume does not rerun completed work", async () => {
  const queue = createTaskQueue();
  queue.enqueue(draft("First"), wallet, "0x99");
  queue.enqueue(draft("Second"), wallet, "0x99");
  const first = deferred<{ message: string }>();
  const running = queue.run(async () => first.promise);
  queue.stop();
  first.resolve({ message: "Committed" });
  await running;
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.status), ["completed", "queued"]);
  await queue.run(async task => { assert.equal(task.id, 2); return { message: "Committed" }; });
  queue.clearCompleted();
  assert.equal(queue.getSnapshot().tasks.length, 0);
});

test("reorder/remove only pending intents and preserve wallet identity", async () => {
  const queue = createTaskQueue();
  queue.enqueue(draft("First"), wallet, "0x99");
  queue.enqueue(draft("Second"), wallet, "0x99");
  queue.enqueue(draft("Third"), wallet, "0x99");
  queue.move(3, -1);
  queue.remove(1);
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.title), ["Third", "Second"]);
  const seen: number[] = [];
  await queue.run(async task => { assert.equal(task.walletIdentity, wallet); seen.push(task.id); return { message: "Done" }; });
  assert.deepEqual(seen, [3, 2]);
});

test("a completed queue can be repeated as fresh intents in the same order", async () => {
  const queue = createTaskQueue();
  queue.enqueue(draft("First"), wallet, "0x99");
  queue.enqueue(draft("Second"), wallet, "0x99");

  assert.equal(queue.repeatCompleted(), false, "pending queues cannot be repeated");
  await queue.run(async task => ({ message: `${task.title} committed`, digest: `digest-${task.id}` }));
  const completed = queue.getSnapshot().tasks;
  assert.equal(queue.repeatCompleted(), true);

  const repeated = queue.getSnapshot().tasks;
  assert.deepEqual(repeated.map(task => [task.id, task.title, task.status]), [
    [3, "First", "queued"],
    [4, "Second", "queued"],
  ]);
  assert.ok(repeated.every(task => task.walletIdentity === wallet && task.walletAddress === "0x99"));
  assert.ok(repeated.every(task => task.result === undefined && task.error === undefined));
  assert.notEqual(repeated[0].assembly, completed[0].assembly, "repeated intents are independent copies");

  const seen: string[] = [];
  await queue.run(async task => { seen.push(task.title); return { message: "Repeated" }; });
  assert.deepEqual(seen, ["First", "Second"]);
  assert.ok(queue.getSnapshot().tasks.every(task => task.status === "completed"));
});

test("running, stopped, and failed queues cannot be repeated", async () => {
  const queue = createTaskQueue();
  queue.enqueue(draft("First"), wallet, "0x99");
  queue.enqueue(draft("Second"), wallet, "0x99");
  const first = deferred<{ message: string }>();
  const running = queue.run(async task => task.title === "First" ? first.promise : { message: "Committed" });

  assert.equal(queue.repeatCompleted(), false, "running queues cannot be repeated");
  queue.stop();
  first.resolve({ message: "Committed" });
  await running;
  assert.equal(queue.repeatCompleted(), false, "partially completed queues cannot be repeated");

  await queue.run(async () => { throw new Error("Uncertain result"); });
  assert.equal(queue.repeatCompleted(), false, "failed queues cannot be repeated");
});

test("a queued repeat control keeps running fresh sequences until stopped", async () => {
  const queue = createTaskQueue();
  queue.enqueue(draft("First"), wallet, "0x99");
  assert.equal(queue.enqueueRepeat(), true);
  queue.enqueue(draft("Second"), wallet, "0x99");
  assert.equal(queue.enqueueRepeat(), false, "only one repeat control can be queued");
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.title), ["First", "Second", "Repeat queue continuously"]);

  queue.move(2, 1);
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.title), ["First", "Second", "Repeat queue continuously"], "the repeat control stays last");
  const seen: Array<[number, string]> = [];
  await queue.run(async task => {
    seen.push([task.id, task.title]);
    if (seen.length === 5) queue.stop();
    return { message: "Committed" };
  });

  assert.deepEqual(seen.map(item => item[1]), ["First", "Second", "First", "Second", "First"]);
  assert.equal(new Set(seen.map(item => item[0])).size, seen.length, "every pass receives new task IDs");
  assert.deepEqual(queue.getSnapshot().tasks.map(task => [task.id, task.title, task.status]), [
    [7, "First", "completed"],
    [8, "Second", "queued"],
    [9, "Repeat queue continuously", "queued"],
  ]);
});

test("a stopped or failed run leaves its queued repeat control unexecuted", async () => {
  const stopped = createTaskQueue();
  stopped.enqueue(draft("First"), wallet, "0x99");
  stopped.enqueueRepeat();
  const first = deferred<{ message: string }>();
  const running = stopped.run(async () => first.promise);
  stopped.stop();
  first.resolve({ message: "Committed" });
  await running;
  assert.deepEqual(stopped.getSnapshot().tasks.map(task => task.status), ["completed", "queued"]);

  const failed = createTaskQueue();
  failed.enqueue(draft("First"), wallet, "0x99");
  failed.enqueueRepeat();
  let calls = 0;
  await failed.run(async () => { calls++; throw new Error("Uncertain result"); });
  assert.equal(calls, 1);
  assert.deepEqual(failed.getSnapshot().tasks.map(task => task.status), ["failed", "queued"]);
});

test("retry delays stay before continuous repeat and can be reordered with executable actions", () => {
  const queue = createTaskQueue();
  queue.enqueue(draft("First"), wallet, "0x99");
  assert.equal(queue.enqueueRepeat(), true);
  assert.equal(queue.enqueueDelay(45), true);
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.operation.kind), ["storage-transfer", "queue-delay", "queue-repeat"]);
  queue.move(3, -1);
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.operation.kind), ["queue-delay", "storage-transfer", "queue-repeat"]);
});

test("stopping an active listener aborts its read-only wait and leaves it pending", async () => {
  const queue = createTaskQueue();
  const listener = { ...draft("Listen"), operation: { kind: "inventory-listener" as const,
    request: { targetKind: "cargo" as const, targetID: 2, inventory: "cargo" as const,
      requested: [{ typeID: 3, quantity: 4 }] }, retryAfterSeconds: 30, timeoutSeconds: null } };
  queue.enqueue(listener, wallet, "0x99");
  const started = deferred<void>();
  const running = queue.run((_task, signal) => new Promise((resolve, reject) => {
    started.resolve();
    signal!.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  }));
  await started.promise;
  queue.stop();
  await running;
  assert.equal(queue.getSnapshot().running, false);
  assert.deepEqual(queue.getSnapshot().tasks.map(task => task.status), ["queued"]);
});

test("the overall timer stops interruptible waits and is re-armed when the queue resumes", async () => {
  let expire!: () => void;
  const queue = createTaskQueue({ now: () => 1000,
    setTimer: (callback) => { expire = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {} });
  const listener = { ...draft("Listen"), operation: { kind: "inventory-listener" as const,
    request: { targetKind: "cargo" as const, targetID: 2, inventory: "cargo" as const,
      requested: [{ typeID: 3, quantity: 4 }] }, retryAfterSeconds: 30, timeoutSeconds: null } };
  queue.enqueue(listener, wallet, "0x99");
  queue.enqueue(draft("After"), wallet, "0x99");
  assert.equal(queue.enqueueTimeout(300), true);
  const running = queue.run((_task, signal) => new Promise((resolve, reject) =>
    signal!.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true })));
  await Promise.resolve();
  assert.equal(queue.getSnapshot().deadlineAtMs, 301000);
  expire();
  await running;
  assert.deepEqual(queue.getSnapshot().tasks.map(task => [task.operation.kind, task.status]), [
    ["queue-timeout", "queued"], ["inventory-listener", "queued"], ["storage-transfer", "queued"],
  ]);
});
