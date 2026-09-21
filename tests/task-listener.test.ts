import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv } from "../src/assembly/config.ts";
import { executeInventoryListenerTask, executeQueueDelayTask } from "../src/tasks/listener.ts";
import { StorageApiError } from "../src/storage/client.ts";
import type { TaskDraft, TaskExecutionContext } from "../src/tasks/types.ts";
import type { WalletSession } from "../src/wallet.ts";

const config = configFromEnv({ VITE_EVE_WORLD_PACKAGE_ID: "0xa", VITE_OBJECT_REGISTRY_ID: "0xb" });
const assembly = { id: "0xc", itemId: "100", kind: "storage_unit", name: "Storage" } as TaskDraft["assembly"];
const listener: TaskDraft = {
  title: "Listen", details: "Wait for materials", assembly,
  operation: { kind: "inventory-listener", request: { targetKind: "cargo", targetID: 300,
    inventory: "cargo", requested: [{ typeID: 34, quantity: 5 }] }, retryAfterSeconds: 30, timeoutSeconds: 120 },
};

function context(signal?: AbortSignal) {
  const progress: string[] = [];
  const value: TaskExecutionContext = { config, signal, progress: message => progress.push(message), assertCurrent() {},
    wallet: { address: "0xf", signTransaction: async () => ({ bytes: "bytes", signature: "signature" }) } as unknown as WalletSession };
  return { value, progress };
}

function result(available: number) {
  return { targetKind: "cargo" as const, targetID: 300, inventory: "cargo" as const, targetName: "Field Storage",
    capacity: 100, usedVolume: available, requested: [{ typeID: 34, quantity: 5 }],
    matched: [{ typeID: 34, quantity: 5, available }], items: [], satisfied: available >= 5, observedAtMs: 1000 };
}

test("listener retries only after its configured request-free delay", async () => {
  const c = context();
  let checks = 0;
  const waits: number[] = [];
  const outcome = await executeInventoryListenerTask(listener, c.value, {
    now: () => 1000,
    wait: async (milliseconds: number) => { waits.push(milliseconds); },
    api: { authenticate: async () => ({ token: "token", expiresAt: 999999 }),
      listener: async () => result(++checks === 1 ? 2 : 5) },
  });
  assert.equal(checks, 2);
  assert.deepEqual(waits, [30000]);
  assert.match(outcome.message, /Field Storage has the requested items.*2 checks/);
  assert.match(c.progress.at(-1) || "", /attempt 2/);
});

test("listener stops at its maximum wait instead of making another server call", async () => {
  const c = context();
  let current = 1000;
  let checks = 0;
  await assert.rejects(executeInventoryListenerTask({ ...listener, operation: {
    ...listener.operation as Extract<TaskDraft["operation"], { kind: "inventory-listener" }>, retryAfterSeconds: 30, timeoutSeconds: 20,
  } }, c.value, {
    now: () => current,
    wait: async (milliseconds: number) => { current += milliseconds; },
    api: { authenticate: async () => ({ token: "token", expiresAt: 999999 }),
      listener: async () => { checks++; return result(0); } },
  }), /20-second maximum wait/);
  assert.equal(checks, 1);
});

test("listener spaces reauthorization attempts after a 401 response", async () => {
  const c = context();
  let authorizations = 0;
  let checks = 0;
  const waits: number[] = [];
  await executeInventoryListenerTask(listener, c.value, {
    now: () => 1000,
    wait: async (milliseconds: number) => { waits.push(milliseconds); },
    api: {
      authenticate: async () => ({ token: `token-${++authorizations}`, expiresAt: 999999 }),
      listener: async () => {
        if (++checks === 1) throw new StorageApiError("Expired", "AUTH_EXPIRED", 401);
        return result(5);
      },
    },
  });
  assert.equal(authorizations, 2);
  assert.equal(checks, 2);
  assert.deepEqual(waits, [30000]);
});

test("standalone retry delays make no server calls and honor cancellation", async () => {
  const controller = new AbortController();
  const c = context(controller.signal);
  const delay: TaskDraft = { title: "Delay", details: "", assembly, operation: { kind: "queue-delay", seconds: 10 } };
  let milliseconds = 0;
  const outcome = await executeQueueDelayTask(delay, c.value, { wait: async (value: number) => { milliseconds = value; } });
  assert.equal(milliseconds, 10000);
  assert.match(outcome.message, /without contacting the server/);

  controller.abort();
  await assert.rejects(executeQueueDelayTask(delay, c.value), (error: any) => error?.name === "AbortError");
});
