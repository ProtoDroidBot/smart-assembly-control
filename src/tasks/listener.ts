import {
  createStorageClient,
  StorageApiError,
  validateInventoryListenerRequest,
} from "../storage/client.ts";
import type { StorageSession } from "../storage/client.ts";
import type { InventoryListenerResult } from "../storage/client.ts";
import type { TaskDraft, TaskExecutionContext, TaskResult } from "./types.ts";

function abortError() {
  return new DOMException("The inventory listener was stopped.", "AbortError");
}

export function waitWithoutRequests(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", aborted);
      reject(abortError());
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function describeMissing(matched: Array<{ typeID: number; quantity: number; available: number }>) {
  return matched.filter(item => item.available < item.quantity)
    .map(item => `type ${item.typeID}: ${item.available.toLocaleString()} / ${item.quantity.toLocaleString()}`)
    .join(", ");
}

/** Poll a read-only, access-checked inventory with no calls during the configured retry delay. */
export async function executeInventoryListenerTask(
  task: TaskDraft,
  context: TaskExecutionContext,
  dependencies: Record<string, any> = {},
): Promise<TaskResult> {
  if (task.operation.kind !== "inventory-listener")
    throw new Error("This task is not an inventory listener.");
  if (context.config.network !== "localnet")
    throw new Error("Inventory listeners require the game's localnet deployment.");
  const { request, retryAfterSeconds, timeoutSeconds } = task.operation;
  validateInventoryListenerRequest(request);
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 86400)
    throw new Error("The listener retry delay must be from 1 second to 24 hours.");
  if (timeoutSeconds !== null && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 604800))
    throw new Error("The listener maximum wait must be from 1 second to 7 days, or unlimited.");

  const now: () => number = dependencies.now || Date.now;
  const wait = dependencies.wait || waitWithoutRequests;
  const api = dependencies.api || createStorageClient((input, init) => {
    context.assertCurrent();
    if (context.signal?.aborted) throw abortError();
    return fetch(input, init);
  });
  const guardedWallet = {
    ...context.wallet,
    signTransaction: async (...args: Parameters<typeof context.wallet.signTransaction>) => {
      context.assertCurrent();
      if (context.signal?.aborted) throw abortError();
      const signed = await context.wallet.signTransaction(...args);
      context.assertCurrent();
      if (context.signal?.aborted) throw abortError();
      return signed;
    },
  };
  const startedAt = now();
  const deadline = timeoutSeconds === null ? null : startedAt + timeoutSeconds * 1000;
  let session: StorageSession | null = null;
  let attempts = 0;

  async function authenticate() {
    context.progress("Awaiting wallet approval for inventory listener access");
    const next = await api.authenticate(guardedWallet, context.config, context.signal);
    context.assertCurrent();
    if (context.signal?.aborted) throw abortError();
    return next;
  }

  for (;;) {
    context.assertCurrent();
    if (context.signal?.aborted) throw abortError();
    if (deadline !== null && now() >= deadline)
      throw new Error(`The inventory listener reached its ${timeoutSeconds}-second maximum wait.`);
    const activeSession: StorageSession = !session || new Date(session.expiresAt).getTime() <= now() + 5000
      ? await authenticate() : session;
    session = activeSession;
    attempts++;
    context.progress(`Checking ${request.inventory} inventory (attempt ${attempts})`);
    let result: InventoryListenerResult;
    try {
      result = await api.listener(activeSession.token, request, context.signal);
    } catch (cause) {
      if (cause instanceof StorageApiError && cause.status === 401) {
        session = null;
        context.progress(`Listener authorization expired; waiting ${retryAfterSeconds}s before authorizing again`);
        const delay = deadline === null
          ? retryAfterSeconds * 1000
          : Math.min(retryAfterSeconds * 1000, Math.max(0, deadline - now()));
        await wait(delay, context.signal);
        continue;
      }
      throw cause;
    }
    context.assertCurrent();
    if (context.signal?.aborted) throw abortError();
    if (result.satisfied) {
      const summary = result.matched.map(item => `${item.quantity.toLocaleString()} of type ${item.typeID}`).join(", ");
      return { message: `${result.targetName} has the requested items (${summary}). Verified after ${attempts} ${attempts === 1 ? "check" : "checks"}.` };
    }
    const missing = describeMissing(result.matched);
    context.progress(`Waiting ${retryAfterSeconds}s to retry ${result.targetName}${missing ? ` · ${missing}` : ""}`);
    const delay = deadline === null
      ? retryAfterSeconds * 1000
      : Math.min(retryAfterSeconds * 1000, Math.max(0, deadline - now()));
    await wait(delay, context.signal);
  }
}

export async function executeQueueDelayTask(
  task: TaskDraft,
  context: TaskExecutionContext,
  dependencies: Record<string, any> = {},
): Promise<TaskResult> {
  if (task.operation.kind !== "queue-delay") throw new Error("This task is not a queue delay.");
  const seconds = task.operation.seconds;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
    throw new Error("A queue retry delay must be from 1 second to 24 hours.");
  context.assertCurrent();
  context.progress(`Waiting ${seconds}s before the next queue action`);
  await (dependencies.wait || waitWithoutRequests)(seconds * 1000, context.signal);
  context.assertCurrent();
  return { message: `Waited ${seconds} ${seconds === 1 ? "second" : "seconds"} without contacting the server.` };
}
