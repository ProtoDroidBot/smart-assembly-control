import type { AssemblyAction, AssemblyConfig, AssemblySnapshot } from "../assembly/types.ts";
import type { IndustryStartRequest, IndustryTransferRequest, IndustryTransferResult, IndustryBlueprint, IndustryBlueprintChangeRequest, IndustryEmptyRequest, IndustryEmptyResult } from "../industry/client.ts";
import type { StorageDirection } from "../storage/client.ts";
import type { InventoryListenerRequest } from "../storage/client.ts";
import type { WalletSession } from "../wallet.ts";
import type { RemoteScanRequest } from "../energy/client.ts";

export type TaskOperation =
  | { kind: "assembly-state"; action: AssemblyAction; snapshot: AssemblySnapshot }
  | { kind: "storage-transfer"; direction: StorageDirection; selected: number; quantity: string }
  | { kind: "industry-start"; request: IndustryStartRequest }
  | { kind: "industry-transfer"; request: IndustryTransferRequest }
  | { kind: "industry-blueprint"; request: IndustryBlueprintChangeRequest; blueprint?: IndustryBlueprint }
  | { kind: "industry-empty"; request: IndustryEmptyRequest }
  | { kind: "gate-link"; targetID: number }
  | { kind: "gate-unlink"; targetID: number }
  | { kind: "energy-connect"; targetID: number }
  | { kind: "energy-disconnect"; targetID: number }
  | { kind: "remote-scan"; actionID: string; actionObjectID: string; request: RemoteScanRequest }
  | { kind: "inventory-listener"; request: InventoryListenerRequest; retryAfterSeconds: number; timeoutSeconds: number | null }
  | { kind: "queue-delay"; seconds: number }
  | { kind: "queue-timeout"; seconds: number }
  | { kind: "queue-repeat" };

export interface TaskDraft {
  title: string;
  details: string;
  assembly: AssemblySnapshot;
  operation: TaskOperation;
}

export interface TaskExecutionContext {
  config: AssemblyConfig;
  wallet: WalletSession;
  /** Throws if the wallet session changed or the app was closed. Call after awaits, before writes/signing. */
  assertCurrent: () => void;
  progress: (message: string) => void;
  /** Aborted only for read-only waits when the user stops the queue or its overall timer expires. */
  signal?: AbortSignal;
}

export interface TaskResult {
  message: string;
  digest?: string;
  industryTransfer?: IndustryTransferResult | IndustryEmptyResult;
  remoteScanID?: string;
}

export type EnqueueTask = (draft: TaskDraft) => boolean;
