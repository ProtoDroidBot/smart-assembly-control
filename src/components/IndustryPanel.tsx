import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { AssemblyConfig, AssemblySnapshot } from "../assembly/types.ts";
import type { WalletSession } from "../wallet.ts";
import {
  createIndustryClient,
  IndustryApiError,
  industryStartRequest,
  industryBlueprintExpectation,
  INDUSTRY_TRANSFER_MAX,
} from "../industry/client.ts";
import type {
  IndustrySession,
  IndustryStatus,
  IndustryItemStack,
  IndustryRecipeSlot,
  IndustryStorageUnit,
  IndustryTransferRequest,
  IndustryTransferResult,
  IndustryBlueprint,
  IndustryBlueprintChangeRequest,
  IndustryEmptyRequest,
  IndustryEmptyResult,
} from "../industry/client.ts";
import { queuedIndustryStartRequest } from "../tasks/industry.ts";
import { projectIndustryQueue } from "../tasks/industry-projection.ts";
import type { QueuedTask } from "../tasks/queue.ts";
import type { EnqueueTask } from "../tasks/types.ts";
import {
  useLocalizedTypeNames,
  type LocalizedTypeName,
} from "../localization/type-names.ts";

const api = createIndustryClient();
const POLL_MS = 3000;
const amount = (value: string) => BigInt(value).toLocaleString();
const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
const words = (value: string) => value.toLowerCase().replace(/_/g, " ");
function timestamp(value?: string) {
  if (!value) return "Not yet recorded";
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "Unavailable";
}

interface Props {
  assembly: AssemblySnapshot;
  config: AssemblyConfig;
  wallet: WalletSession | null;
  disabled: boolean;
  visible: boolean;
  isOwner: boolean;
  onQueueTask?: EnqueueTask;
  queuedTasks?: readonly QueuedTask[];
  onBusyChange?: (busy: string) => void;
  queuedTransfer?: IndustryTransferResult | IndustryEmptyResult;
}

function Inventory({
  title,
  stacks,
  recipe,
  typeName,
}: {
  title: string;
  stacks: IndustryItemStack[];
  recipe: IndustryRecipeSlot[];
  typeName: LocalizedTypeName;
}) {
  const stock = new Map(stacks.map((entry) => [entry.type_id, entry.quantity]));
  const slots = new Map(recipe.map((entry) => [entry.type_id, entry]));
  const types = [...new Set([...slots.keys(), ...stock.keys()])];
  return (
    <div className="inventory-scroll">
      <table className="inventory-table">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Available</th>
            <th scope="col">Per run</th>
            <th scope="col">Capacity</th>
          </tr>
        </thead>
        <tbody>
          {types.length ? (
            types.map((type) => (
              <tr key={type}>
                <th scope="row">
                  {typeName(type)}
                  <small>Type {type}</small>
                </th>
                <td>{amount(stock.get(type) || "0")}</td>
                <td>
                  {slots.has(type) ? amount(slots.get(type)!.quantity) : "—"}
                </td>
                <td>
                  {slots.has(type)
                    ? amount(slots.get(type)!.max_quantity)
                    : "—"}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={4}>No items or blueprint slots.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function IndustryPanel({
  assembly,
  config,
  wallet,
  disabled,
  visible,
  isOwner,
  onQueueTask,
  queuedTasks = [],
  onBusyChange,
  queuedTransfer,
}: Props) {
  const itemID = assembly.itemId || "";
  // Each context has its own identity, including disconnect/reconnect to the same wallet.
  const context = useMemo(
    () => ({ wallet, assemblyID: assembly.id, itemID, config, isOwner }),
    [wallet, assembly.id, itemID, config, isOwner],
  );
  const active = useRef(context);
  active.current = context;
  const mounted = useRef(false);
  const signing = useRef(false);
  const mutating = useRef(false);
  const mutationVersion = useRef(0);
  const [authorization, setAuthorization] = useState<{
    context: typeof context;
    session: IndustrySession;
  } | null>(null);
  const [reading, setReading] = useState<{
    context: typeof context;
    data: IndustryStatus;
    updatedAt: number;
  } | null>(null);
  const [storageReading, setStorageReading] = useState<{
    context: typeof context;
    units: IndustryStorageUnit[];
  } | null>(null);
  const [storageFailure, setStorageFailure] = useState<{
    context: typeof context;
    message: string;
  } | null>(null);
  const [blueprintReading, setBlueprintReading] = useState<{
    context: typeof context;
    blueprints: IndustryBlueprint[];
  } | null>(null);
  const [blueprintFailure, setBlueprintFailure] = useState<{
    context: typeof context;
    message: string;
  } | null>(null);
  const [blueprintDraft, setBlueprintDraft] = useState({
    context,
    blueprintID: "",
    storageUnitID: "",
  });
  const [failure, setFailure] = useState<{
    context: typeof context;
    message: string;
  } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<
    | "start"
    | "sync"
    | "transfer"
    | "storage-sync"
    | "blueprints"
    | "blueprint"
    | "empty"
    | null
  >(null);
  const [feedback, setFeedback] = useState<{
    context: typeof context;
    message: string;
    error: boolean;
  } | null>(null);
  const [draft, setDraft] = useState({ context, runs: "1", continuous: false });
  const emptyTransfer = {
    storageUnitID: "",
    direction: "deposit" as const,
    side: "inputs" as const,
    typeID: "",
    quantity: "1",
  };
  const [transferDraft, setTransferDraft] = useState<
    { context: typeof context } & Omit<IndustryTransferRequest, "requestID">
  >({ context, ...emptyTransfer });
  const [transferReceipt, setTransferReceipt] = useState<{
    context: typeof context;
    result: IndustryTransferResult | IndustryEmptyResult;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(Date.now());
  const session =
    authorization?.context === context ? authorization.session : null;
  const status = reading?.context === context ? reading.data : null;
  const liveStorageUnits =
    storageReading?.context === context ? storageReading.units : null;
  const projection = status
    ? projectIndustryQueue(
        status,
        liveStorageUnits,
        queuedTasks,
        assembly,
        wallet,
      )
    : null;
  const actionStatus = projection?.status || status;
  const storageUnits = projection?.storageUnits ?? liveStorageUnits;
  const queueError = projection?.error || "";
  const pendingIndustry = !!projection?.pendingCount;
  const directReason = pendingIndustry
    ? "Run or clear queued Industry actions before applying an action immediately."
    : "";
  const storageError =
    storageFailure?.context === context ? storageFailure.message : "";
  const blueprints =
    blueprintReading?.context === context ? blueprintReading.blueprints : null;
  const blueprintError =
    blueprintFailure?.context === context ? blueprintFailure.message : "";
  const blueprintSelection =
    blueprintDraft.context === context
      ? blueprintDraft
      : { blueprintID: "", storageUnitID: "" };
  const transfer =
    transferDraft.context === context ? transferDraft : emptyTransfer;
  const lastTransfer =
    transferReceipt?.context === context ? transferReceipt.result : null;
  const error = failure?.context === context ? failure.message : "";
  const notice = feedback?.context === context ? feedback : null;
  const runs = draft.context === context ? draft.runs : "1";
  const continuous = draft.context === context && draft.continuous;
  const canAccess =
    !!wallet &&
    isOwner &&
    config.network === "localnet" &&
    /^[1-9]\d*$/.test(itemID) &&
    Number.isSafeInteger(Number(itemID));

  useEffect(() => {
    onBusyChange?.(
      authBusy
        ? "Authorizing Industry access"
        : operation
          ? "Completing an Industry operation"
          : "",
    );
    return () => onBusyChange?.("");
  }, [authBusy, operation, onBusyChange]);

  useEffect(() => {
    if (queuedTransfer) setTransferReceipt({ context, result: queuedTransfer });
  }, [context, queuedTransfer]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!visible || !session || !canAccess || disabled || operation) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let pending = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const current = () =>
      !cancelled && mounted.current && active.current === context;
    const expire = (message: string) => {
      stopped = true;
      setAuthorization(null);
      setFailure({ context, message });
    };
    async function read() {
      if (
        !current() ||
        pending ||
        stopped ||
        document.hidden ||
        mutating.current
      )
        return;
      clearTimeout(timer);
      if (new Date(session!.expiresAt).getTime() <= Date.now()) {
        expire(
          "Industry access expired. Refresh industry status to reconnect.",
        );
        return;
      }
      pending = true;
      controller = new AbortController();
      const request = controller;
      const version = mutationVersion.current;
      setLoading(true);
      try {
        const [facilityRead, storageRead] = await Promise.allSettled([
          api.status(itemID, session!.token, request.signal),
          api.storage(itemID, session!.token, request.signal),
        ]);
        if (
          !current() ||
          request.signal.aborted ||
          mutating.current ||
          version !== mutationVersion.current
        )
          return;
        if (storageRead.status === "fulfilled") {
          setStorageReading({ context, units: storageRead.value.storageUnits });
          setStorageFailure(null);
        } else {
          setStorageFailure({ context, message: describe(storageRead.reason) });
          if (
            storageRead.reason instanceof IndustryApiError &&
            storageRead.reason.status === 401
          )
            throw storageRead.reason;
        }
        if (facilityRead.status === "rejected") throw facilityRead.reason;
        const next = facilityRead.value;
        if (
          next.facility.snapshot.owner_id !== String(session!.characterID) ||
          (next.chain.assemblyObjectID &&
            normalizeSuiAddress(next.chain.assemblyObjectID) !==
              normalizeSuiAddress(assembly.id))
        )
          throw new Error(
            "The status belongs to a different assembly or owner. Reload the assembly.",
          );
        setReading({ context, data: next, updatedAt: Date.now() });
        setFailure(null);
      } catch (cause) {
        if (
          !current() ||
          request.signal.aborted ||
          mutating.current ||
          version !== mutationVersion.current
        )
          return;
        if (
          cause instanceof IndustryApiError &&
          (cause.status === 401 || cause.status === 403)
        )
          expire(`${describe(cause)} Refresh industry status to reconnect.`);
        else setFailure({ context, message: describe(cause) });
      } finally {
        pending = false;
        if (current()) {
          setLoading(false);
          if (!stopped && !document.hidden)
            timer = setTimeout(
              () => void read(),
              request.signal.aborted ? 0 : POLL_MS,
            );
        }
      }
    }
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) controller?.abort();
      else void read();
    };
    const resume = () => {
      void read();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    };
  }, [
    visible,
    session,
    canAccess,
    disabled,
    context,
    itemID,
    assembly.id,
    refreshKey,
    operation,
  ]);

  const production = status?.production;
  useEffect(() => {
    if (!visible || !production || production.state === "STOPPED") return;
    setNow(Date.now());
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [visible, production]);

  async function refresh() {
    if (
      !wallet ||
      !canAccess ||
      disabled ||
      signing.current ||
      mutating.current
    )
      return;
    if (session && new Date(session.expiresAt).getTime() > Date.now() + 5000) {
      setRefreshKey((value) => value + 1);
      return;
    }
    signing.current = true;
    setAuthBusy(true);
    setFailure(null);
    try {
      const next = await api.authenticate(wallet, config);
      if (mounted.current && active.current === context)
        setAuthorization({ context, session: next });
    } catch (cause) {
      if (mounted.current && active.current === context)
        setFailure({ context, message: describe(cause) });
    } finally {
      signing.current = false;
      if (mounted.current) setAuthBusy(false);
    }
  }

  const stale = !!error || (!!status && !session);
  const snapshot = actionStatus?.facility.snapshot;
  const running = production && production.state !== "STOPPED";
  const prepareStart = () => {
    if (!status)
      throw new Error("Load industry status before starting production.");
    return industryStartRequest(status, continuous ? null : runs);
  };
  let startReason = "";
  try {
    prepareStart();
  } catch (cause) {
    startReason = describe(cause);
  }
  const prepareQueuedStart = () => {
    if (queueError) throw new Error(queueError);
    if (projection?.productionQueued)
      throw new Error(
        "Production is already queued. Run or remove that task before queueing another job.",
      );
    if (!actionStatus)
      throw new Error("Load industry status before queueing production.");
    return queuedIndustryStartRequest(actionStatus, continuous ? null : runs);
  };
  let queueStartReason = "";
  try {
    prepareQueuedStart();
  } catch (cause) {
    queueStartReason = describe(cause);
  }

  const selectedBlueprint = blueprints?.find(
    (blueprint) => blueprint.blueprintID === blueprintSelection.blueprintID,
  );
  const typeName = useLocalizedTypeNames(
    [
      ...(snapshot?.inputs.map((item) => item.type_id) ?? []),
      ...(snapshot?.outputs.map((item) => item.type_id) ?? []),
      ...(snapshot?.blueprint_inputs.map((item) => item.type_id) ?? []),
      ...(snapshot?.blueprint_outputs.map((item) => item.type_id) ?? []),
      ...(storageUnits ?? []).flatMap((unit) =>
        unit.items.map((item) => item.typeID),
      ),
      ...(blueprints ?? []).flatMap((blueprint) => [
        blueprint.blueprintID,
        ...blueprint.inputs.map((item) => item.type_id),
        ...blueprint.outputs.map((item) => item.type_id),
      ]),
    ],
    assembly.tenant || config.defaultTenant,
  );
  const emptyStorage = storageUnits?.find(
    (unit) => String(unit.storageUnitID) === blueprintSelection.storageUnitID,
  );
  const hasBlueprintItems =
    !!snapshot &&
    [...snapshot.inputs, ...snapshot.outputs].some(
      (item) => BigInt(item.quantity) > 0n,
    );
  let blueprintIdentityReason = "";
  try {
    if (queueError) throw new Error(queueError);
    if (projection?.productionQueued)
      throw new Error(
        "Production is already queued. Run or remove that task before emptying or changing the blueprint.",
      );
    if (!actionStatus)
      throw new Error(
        "Load industry status before managing the active blueprint.",
      );
    industryBlueprintExpectation(actionStatus);
  } catch (cause) {
    blueprintIdentityReason = describe(cause);
  }
  const queueBlueprintReason =
    blueprintIdentityReason ||
    (blueprintError
      ? "Reload available blueprints before selecting one."
      : !selectedBlueprint
        ? "Load available blueprints and select a different one."
        : selectedBlueprint.blueprintID === snapshot?.blueprint_id
          ? "Select a different blueprint."
          : "");
  const changeBlueprintReason =
    directReason ||
    queueBlueprintReason ||
    (hasBlueprintItems
      ? "Empty all input and output materials before changing the active blueprint."
      : "");
  const emptyBlueprintReason =
    blueprintIdentityReason ||
    (snapshot?.blueprint_id === "0"
      ? "There is no active blueprint to empty."
      : !storageUnits
        ? "Load nearby storage inventories before emptying the active blueprint."
        : storageError
          ? "Refresh nearby storage inventories before emptying the active blueprint."
          : !storageUnits.length
            ? "No accessible online Smart Storage Units are nearby. Move within range of both structures."
            : !emptyStorage
              ? "Select a nearby Smart Storage Unit for all input and output materials."
              : !hasBlueprintItems
                ? "The active blueprint's input and output inventories are already empty."
                : "");
  const updateBlueprint = (
    change: Partial<{ blueprintID: string; storageUnitID: string }>,
  ) => setBlueprintDraft({ context, ...blueprintSelection, ...change });
  const prepareBlueprintChange = (): IndustryBlueprintChangeRequest => ({
    requestID: crypto.randomUUID(),
    ...industryBlueprintExpectation(actionStatus!),
    blueprintID: selectedBlueprint!.blueprintID,
    blueprintHash: selectedBlueprint!.blueprintHash,
  });
  const prepareBlueprintEmpty = (): IndustryEmptyRequest => ({
    requestID: crypto.randomUUID(),
    ...industryBlueprintExpectation(actionStatus!),
    storageUnitID: blueprintSelection.storageUnitID,
  });

  async function loadBlueprints() {
    if (
      !session ||
      !canAccess ||
      disabled ||
      !visible ||
      signing.current ||
      mutating.current
    )
      return;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      setAuthorization(null);
      setFailure({
        context,
        message:
          "Industry access expired. Refresh industry status to reconnect.",
      });
      return;
    }
    mutating.current = true;
    mutationVersion.current++;
    setOperation("blueprints");
    const current = () => mounted.current && active.current === context;
    try {
      const result = await api.blueprints(itemID, session.token);
      if (!current()) return;
      setBlueprintReading({ context, blueprints: result.blueprints });
      setBlueprintFailure(null);
    } catch (cause) {
      if (!current()) return;
      setBlueprintFailure({ context, message: describe(cause) });
      if (
        cause instanceof IndustryApiError &&
        (cause.status === 401 || cause.code === "ACCESS_DENIED")
      )
        setAuthorization(null);
    } finally {
      mutating.current = false;
      mutationVersion.current++;
      if (mounted.current) setOperation(null);
    }
  }

  function queueBlueprintAction(action: "blueprint" | "empty") {
    const reason =
      action === "blueprint" ? queueBlueprintReason : emptyBlueprintReason;
    if (
      !onQueueTask ||
      !session ||
      !canAccess ||
      disabled ||
      !visible ||
      authBusy ||
      operation ||
      stale ||
      reason
    )
      return;
    onQueueTask({
      title:
        action === "blueprint"
          ? "Change Industry blueprint"
          : "Empty active Industry blueprint",
      details:
        action === "blueprint"
          ? `${snapshot!.blueprint_id === "0" ? "No blueprint" : `Blueprint #${snapshot!.blueprint_id}`} → ${typeName(selectedBlueprint!.blueprintID, selectedBlueprint!.name)} (#${selectedBlueprint!.blueprintID})`
          : `All Industry inputs and outputs → ${emptyStorage!.name || "Storage"} (#${emptyStorage!.storageUnitID})`,
      assembly: structuredClone(assembly),
      operation:
        action === "blueprint"
          ? {
              kind: "industry-blueprint",
              request: prepareBlueprintChange(),
              blueprint: structuredClone(selectedBlueprint!),
            }
          : { kind: "industry-empty", request: prepareBlueprintEmpty() },
    });
    setFeedback({
      context,
      error: false,
      message:
        action === "blueprint"
          ? "Blueprint change added to the task queue. Subsequent inventory and queued actions use the new recipe. Both inventories must be empty when the change executes."
          : "Empty active blueprint added to the task queue. All input and output materials will move to the selected storage when it executes.",
    });
  }

  async function manageBlueprint(action: "blueprint" | "empty") {
    const reason =
      directReason ||
      (action === "blueprint" ? changeBlueprintReason : emptyBlueprintReason);
    if (
      !session ||
      !canAccess ||
      disabled ||
      !visible ||
      signing.current ||
      mutating.current ||
      stale ||
      reason
    )
      return;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      setAuthorization(null);
      setFailure({
        context,
        message:
          "Industry access expired. Refresh industry status to reconnect.",
      });
      return;
    }
    // Bind the request to the recipe and job the user reviewed, before any wait.
    const request =
      action === "blueprint"
        ? prepareBlueprintChange()
        : prepareBlueprintEmpty();
    mutating.current = true;
    mutationVersion.current++;
    setOperation(action);
    setFeedback(null);
    const current = () => mounted.current && active.current === context;
    try {
      if (action === "blueprint") {
        const result = await api.changeBlueprint(
          itemID,
          session.token,
          request as IndustryBlueprintChangeRequest,
        );
        if (!current()) return;
        setReading({ context, data: result, updatedAt: Date.now() });
        const chainMessage =
          result.chain.status === "synced"
            ? "The blockchain is synchronized."
            : result.chain.status === "disabled"
              ? "Blockchain synchronization is disabled on the server."
              : "Check blockchain synchronization below.";
        setFeedback({
          context,
          error: false,
          message: `${typeName(selectedBlueprint!.blueprintID, selectedBlueprint!.name)} (#${result.selectedBlueprintID}) is now the active blueprint on the server. ${chainMessage}`,
        });
      } else {
        const result = await api.emptyBlueprint(
          itemID,
          session.token,
          request as IndustryEmptyRequest,
        );
        if (!current()) return;
        setTransferReceipt({ context, result });
        const chainMessage =
          result.chain.status === "synced"
            ? "Both blockchain inventories are synchronized."
            : result.chain.status === "disabled"
              ? "Blockchain synchronization is disabled on the server."
              : `Blockchain synchronization is ${result.chain.status === "error" ? "awaiting recovery" : "pending"} (Industry: ${result.chain.industryStatus}; storage: ${result.chain.storageStatus}).`;
        setFeedback({
          context,
          error: false,
          message: `All input and output materials moved to storage #${result.storageUnitID} on the server. ${chainMessage}`,
        });
      }
    } catch (cause) {
      if (!current()) return;
      setFeedback({
        context,
        error: true,
        message: `${describe(cause)} Check the refreshed blueprint and both inventories before trying again. This request will not be retried automatically.`,
      });
      if (
        cause instanceof IndustryApiError &&
        (cause.status === 401 || cause.code === "ACCESS_DENIED")
      )
        setAuthorization(null);
    } finally {
      mutating.current = false;
      mutationVersion.current++;
      if (current()) {
        setStorageReading(null);
        setFailure({
          context,
          message:
            "Refreshing the blueprint and both inventories after the request.",
        });
      }
      if (mounted.current) {
        setOperation(null);
        setRefreshKey((value) => value + 1);
      }
    }
  }

  function queueProduction() {
    if (
      !onQueueTask ||
      !session ||
      !canAccess ||
      disabled ||
      !visible ||
      authBusy ||
      operation ||
      stale ||
      queueStartReason
    )
      return;
    const request = prepareQueuedStart();
    onQueueTask({
      title: "Start Industry production",
      details: `Blueprint #${request.blueprintID} · ${request.runs === null ? "continuous production" : `${amount(request.runs)} runs`}`,
      assembly: structuredClone(assembly),
      operation: { kind: "industry-start", request },
    });
    setFeedback({
      context,
      error: false,
      message:
        "Production added to the task queue. Inputs and facility readiness will be checked when it executes.",
    });
  }

  const selectedStorage = storageUnits?.find(
    (unit) => String(unit.storageUnitID) === transfer.storageUnitID,
  );
  const transferable = new Map<string, { name: string; quantity: bigint }>();
  if (transfer.direction === "deposit") {
    const accepted = new Set(
      snapshot?.blueprint_inputs.map((slot) => slot.type_id),
    );
    for (const item of selectedStorage?.items || []) {
      const type = String(item.typeID);
      if (!accepted.has(type)) continue;
      transferable.set(type, {
        name: typeName(type, item.name),
        quantity:
          (transferable.get(type)?.quantity ?? 0n) + BigInt(item.quantity),
      });
    }
  } else {
    for (const item of snapshot?.[transfer.side] || [])
      transferable.set(item.type_id, {
        name: typeName(
          item.type_id,
          selectedStorage?.items.find(
            (stack) => String(stack.typeID) === item.type_id,
          )?.name,
        ),
        quantity: BigInt(item.quantity),
      });
  }
  const selectedItem = transferable.get(transfer.typeID);
  let transferReason = "";
  if (queueError) transferReason = queueError;
  else if (!storageUnits)
    transferReason = "Load nearby storage inventories before moving items.";
  else if (storageError)
    transferReason = "Refresh nearby storage inventories before moving items.";
  else if (!storageUnits.length)
    transferReason =
      "No accessible online Smart Storage Units are nearby. Move within range of both structures.";
  else if (!selectedStorage)
    transferReason = "Select a nearby Smart Storage Unit.";
  else if (!selectedItem)
    transferReason = transferable.size
      ? "Select an item type to move."
      : transfer.direction === "deposit"
        ? "This storage unit has no items accepted by the selected Industry blueprint."
        : "The selected Industry inventory is empty.";
  else if (Number(transfer.typeID) > INDUSTRY_TRANSFER_MAX)
    transferReason = "This item type is not supported by storage transfers.";
  else if (
    !/^[1-9]\d*$/.test(transfer.quantity) ||
    !Number.isSafeInteger(Number(transfer.quantity)) ||
    Number(transfer.quantity) > INDUSTRY_TRANSFER_MAX
  )
    transferReason = "Enter a whole quantity from 1 to 4294967295.";
  else if (BigInt(transfer.quantity) > selectedItem.quantity)
    transferReason = "The selected inventory does not have that quantity.";
  else if (transfer.direction === "deposit") {
    const capacity =
      snapshot?.blueprint_inputs.find(
        (slot) => slot.type_id === transfer.typeID,
      )?.max_quantity || "0";
    const stored =
      snapshot?.inputs.find((stack) => stack.type_id === transfer.typeID)
        ?.quantity || "0";
    if (BigInt(stored) + BigInt(transfer.quantity) > BigInt(capacity))
      transferReason =
        "The Industry input slot does not have room for that quantity.";
  }
  const updateTransfer = (
    change: Partial<Omit<IndustryTransferRequest, "requestID">>,
  ) => setTransferDraft({ context, ...transfer, ...change });

  function queueTransfer() {
    if (
      !onQueueTask ||
      !session ||
      !canAccess ||
      disabled ||
      !visible ||
      authBusy ||
      operation ||
      stale ||
      transferReason
    )
      return;
    const request: IndustryTransferRequest = {
      requestID: crypto.randomUUID(),
      storageUnitID: transfer.storageUnitID,
      direction: transfer.direction,
      side: transfer.side,
      typeID: transfer.typeID,
      quantity: transfer.quantity,
    };
    onQueueTask({
      title: "Transfer Industry items",
      details: `${amount(request.quantity)} × ${selectedItem?.name || typeName(request.typeID)} · ${request.direction === "deposit" ? `storage #${request.storageUnitID} → Industry inputs` : `Industry ${request.side} → storage #${request.storageUnitID}`}`,
      assembly: structuredClone(assembly),
      operation: { kind: "industry-transfer", request },
    });
    setFeedback({
      context,
      error: false,
      message:
        "Transfer added to the task queue. Items will move when the queue executes.",
    });
  }

  async function moveItems() {
    if (
      !session ||
      !canAccess ||
      disabled ||
      !visible ||
      signing.current ||
      mutating.current ||
      stale ||
      directReason ||
      transferReason
    )
      return;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      setAuthorization(null);
      setFailure({
        context,
        message:
          "Industry access expired. Refresh industry status to reconnect.",
      });
      return;
    }
    mutating.current = true;
    mutationVersion.current++;
    setOperation("transfer");
    setFeedback(null);
    const current = () => mounted.current && active.current === context;
    try {
      // A fresh identifier represents one deliberate transfer; uncertain requests are never resubmitted.
      const result = await api.transfer(itemID, session.token, {
        requestID: crypto.randomUUID(),
        storageUnitID: transfer.storageUnitID,
        direction: transfer.direction,
        side: transfer.side,
        typeID: transfer.typeID,
        quantity: transfer.quantity,
      });
      if (!current()) return;
      setTransferReceipt({ context, result });
      const chainMessage =
        result.chain.status === "synced"
          ? "Both blockchain inventories are synchronized."
          : result.chain.status === "disabled"
            ? "Blockchain synchronization is disabled on the server."
            : `Blockchain synchronization is ${result.chain.status === "error" ? "awaiting recovery" : "pending"} (Industry: ${result.chain.industryStatus}; storage: ${result.chain.storageStatus}).`;
      setFeedback({
        context,
        error: false,
        message: `${amount(transfer.quantity)} ${transfer.quantity === "1" ? "item" : "items"} moved ${transfer.direction === "deposit" ? "from storage to Industry inputs" : `from Industry ${transfer.side} to storage`} on the server. ${chainMessage}`,
      });
      setTransferDraft({ context, ...transfer, quantity: "1" });
    } catch (cause) {
      if (!current()) return;
      setFeedback({
        context,
        error: true,
        message: `${describe(cause)} Check both refreshed inventories before submitting another transfer. This request will not be retried automatically.`,
      });
      if (
        cause instanceof IndustryApiError &&
        (cause.status === 401 || cause.code === "ACCESS_DENIED")
      )
        setAuthorization(null);
    } finally {
      mutating.current = false;
      mutationVersion.current++;
      if (current()) {
        // Never reuse inventory quantities observed before a possibly committed move.
        setStorageReading(null);
        setFailure({
          context,
          message: "Refreshing both inventories after the transfer request.",
        });
      }
      if (mounted.current) {
        setOperation(null);
        setRefreshKey((value) => value + 1);
      }
    }
  }

  async function syncTransfer() {
    if (
      !lastTransfer ||
      !session ||
      !canAccess ||
      disabled ||
      !visible ||
      signing.current ||
      mutating.current
    )
      return;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      setAuthorization(null);
      setFailure({
        context,
        message:
          "Industry access expired. Refresh industry status to reconnect.",
      });
      return;
    }
    mutating.current = true;
    mutationVersion.current++;
    setOperation("storage-sync");
    const current = () => mounted.current && active.current === context;
    try {
      const chain = await api.storageSync(
        itemID,
        session.token,
        String(lastTransfer.storageUnitID),
      );
      if (!current()) return;
      setTransferReceipt({ context, result: { ...lastTransfer, chain } });
      setFeedback({
        context,
        error: false,
        message:
          chain.status === "synced"
            ? "The last transfer is committed on the server, and both blockchain inventories are synchronized."
            : `The last transfer remains committed on the server. Blockchain synchronization: Industry ${chain.industryStatus}; storage ${chain.storageStatus}.`,
      });
    } catch (cause) {
      if (!current()) return;
      setFeedback({
        context,
        error: true,
        message: `The last transfer remains committed on the server. ${describe(cause)}`,
      });
      if (
        cause instanceof IndustryApiError &&
        (cause.status === 401 || cause.code === "ACCESS_DENIED")
      )
        setAuthorization(null);
    } finally {
      mutating.current = false;
      mutationVersion.current++;
      if (mounted.current) {
        setOperation(null);
        setRefreshKey((value) => value + 1);
      }
    }
  }

  async function act(action: "start" | "sync") {
    if (
      !session ||
      !canAccess ||
      disabled ||
      !visible ||
      signing.current ||
      mutating.current ||
      (action === "start" && (stale || !!directReason || !!startReason))
    )
      return;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      setAuthorization(null);
      setFailure({
        context,
        message:
          "Industry access expired. Refresh industry status to reconnect.",
      });
      return;
    }
    // Invalidate reads immediately, before React can clean up the polling effect.
    // A read that began before the mutation must never replace its committed result.
    mutating.current = true;
    mutationVersion.current++;
    setOperation(action);
    setFeedback(null);
    const current = () => mounted.current && active.current === context;
    try {
      const result =
        action === "start"
          ? await api.start(itemID, session.token, prepareStart())
          : await api.sync(itemID, session.token);
      if (!current()) return;
      if (
        result.facility.snapshot.owner_id !== String(session.characterID) ||
        (result.chain.assemblyObjectID &&
          normalizeSuiAddress(result.chain.assemblyObjectID) !==
            normalizeSuiAddress(assembly.id))
      )
        throw new Error(
          "The status belongs to a different assembly or owner. Reload the assembly.",
        );
      setReading({ context, data: result, updatedAt: Date.now() });
      setFailure(null);
      const chainMessage =
        result.chain.status === "synced"
          ? "The blockchain is synchronized."
          : result.chain.status === "disabled"
            ? "Blockchain synchronization is disabled on the server."
            : result.chain.status === "error"
              ? "Blockchain synchronization needs attention. Check its status below."
              : "Blockchain synchronization is still pending. Check its status below.";
      setFeedback({
        context,
        error: false,
        message:
          action === "start" && "startedJobID" in result
            ? `Job #${result.startedJobID} started on the server. ${chainMessage}`
            : chainMessage,
      });
    } catch (cause) {
      if (!current()) return;
      const message = describe(cause);
      setFeedback({
        context,
        error: true,
        message:
          action === "start"
            ? `${message} Check the refreshed production status before trying again.`
            : message,
      });
      // Keep Start disabled until an authoritative read resolves an uncertain result.
      setFailure({
        context,
        message: "Refreshing the facility after the request.",
      });
      if (
        cause instanceof IndustryApiError &&
        (cause.status === 401 || cause.code === "ACCESS_DENIED")
      ) {
        setAuthorization(null);
        setFailure({
          context,
          message: "Refresh industry status to reconnect.",
        });
      }
    } finally {
      mutating.current = false;
      mutationVersion.current++;
      if (mounted.current) {
        setOperation(null);
        setRefreshKey((value) => value + 1);
      }
    }
  }
  const start = BigInt(production?.run_started_at_ms || "0");
  const end = BigInt(production?.run_end_at_ms || "0");
  const elapsed = BigInt(now) - start;
  const progress =
    running && end > start
      ? Math.max(0, Math.min(100, Number((elapsed * 100n) / (end - start))))
      : 0;
  const remaining = end > BigInt(now) ? (end - BigInt(now) + 999n) / 1000n : 0n;
  const chainText = {
    synced:
      "The blockchain matches the latest facility snapshot and production state.",
    pending:
      "The game status is available. Blockchain synchronization is pending.",
    error:
      "The game status is available. Blockchain synchronization needs attention.",
    disabled:
      "Blockchain synchronization is disabled. Game status is shown below.",
  };

  return (
    <section
      className="panel detail-panel industry-panel"
      aria-label="Smart Industry status"
      aria-busy={authBusy || !!operation || (!status && loading)}
    >
      <div className="section-kicker">SMART INDUSTRY / LIVE STATUS</div>
      <div className="industry-heading">
        <h2>Manage production and inventory.</h2>
        <span
          className={`state ${stale ? "offline" : session && status ? "online" : "unknown"}`}
        >
          {stale ? "STALE" : session && status ? "LIVE" : "NOT LOADED"}
        </span>
      </div>
      <p>
        Move items between nearby Smart Storage Units and this Industry
        facility. Blueprint, production, and inventory updates refresh every 3
        seconds while this view is open.
      </p>
      <div className="energy-toolbar">
        <button
          className={!status ? "primary" : ""}
          disabled={
            disabled || authBusy || loading || !!operation || !canAccess
          }
          onClick={() => void refresh()}
        >
          {authBusy
            ? "Awaiting wallet approval…"
            : status
              ? "Refresh industry status"
              : "Load industry status"}
        </button>
        <span className="muted">
          {status && reading
            ? `${stale ? "Last successful read" : "Updated"} ${new Date(reading.updatedAt).toLocaleTimeString()}`
            : loading
              ? "Reading facility status…"
              : "Authorize once for live updates, production, and inventory transfers."}
        </span>
      </div>
      {!canAccess && (
        <p>
          {!wallet
            ? "Connect the facility owner's wallet to view Industry status."
            : !isOwner
              ? "Only the facility owner's wallet can view its live Industry status."
              : "This facility needs a valid game item ID and the localnet deployment."}
        </p>
      )}
      {error && (
        <p className="energy-error" role="alert">
          {error}
          {session && (
            <span> Readings may be out of date. Retrying automatically.</span>
          )}
        </p>
      )}
      {notice && (
        <p
          className={notice.error ? "energy-error" : ""}
          role={notice.error ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}
      {pendingIndustry && (
        <p className="banner" role="status">
          Queue preview:{" "}
          {queueError
            ? "inventory is shown before the blocked task."
            : `inventory and new queued actions reflect ${projection!.pendingCount} pending Industry ${projection!.pendingCount === 1 ? "task" : "tasks"}.`}{" "}
          {directReason}
        </p>
      )}
      {queueError && (
        <p className="energy-error" role="alert">
          {queueError}
        </p>
      )}
      {status && snapshot && (
        <div
          className={
            stale ? "industry-readings stale-readings" : "industry-readings"
          }
        >
          <dl className="energy-summary industry-summary">
            <div>
              <dt>Facility</dt>
              <dd>{status.facility.status === 2 ? "Online" : "Offline"}</dd>
            </div>
            <div>
              <dt>
                {queueError
                  ? "Blueprint before blocked task"
                  : pendingIndustry
                    ? "Blueprint after queue"
                    : "Selected blueprint"}
              </dt>
              <dd>
                {snapshot.blueprint_id === "0"
                  ? "None selected"
                  : `Blueprint #${snapshot.blueprint_id}`}
              </dd>
            </div>
            <div>
              <dt>Run duration</dt>
              <dd>
                {snapshot.blueprint_id === "0"
                  ? "—"
                  : `${amount(snapshot.run_time)} s`}
              </dd>
            </div>
          </dl>
          <form
            className="industry-start industry-transfer"
            onSubmit={(event) => {
              event.preventDefault();
              void manageBlueprint("empty");
            }}
            aria-label="Empty active blueprint"
          >
            <h3>Empty active blueprint</h3>
            <p>
              Move every input and output item to one nearby Smart Storage Unit
              so the active blueprint can be changed. Production must be
              stopped.
            </p>
            <fieldset
              disabled={
                disabled ||
                !canAccess ||
                !session ||
                authBusy ||
                !!operation ||
                stale ||
                !storageUnits ||
                !!storageError
              }
            >
              <div className="industry-start-controls industry-transfer-controls">
                <label>
                  Destination storage
                  <select
                    name="emptyStorageUnitID"
                    value={emptyStorage ? blueprintSelection.storageUnitID : ""}
                    onChange={(event) =>
                      updateBlueprint({ storageUnitID: event.target.value })
                    }
                  >
                    <option value="">Select nearby storage</option>
                    {storageUnits?.map((unit) => (
                      <option
                        key={unit.storageUnitID}
                        value={String(unit.storageUnitID)}
                      >
                        {unit.name || `Storage #${unit.storageUnitID}`} (#
                        {unit.storageUnitID})
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={!!directReason || !!emptyBlueprintReason}
                >
                  {operation === "empty"
                    ? "Emptying active blueprint…"
                    : "Empty active blueprint"}
                </button>
                {onQueueTask && (
                  <button
                    type="button"
                    disabled={!!emptyBlueprintReason}
                    onClick={() => queueBlueprintAction("empty")}
                  >
                    Queue empty blueprint
                  </button>
                )}
              </div>
            </fieldset>
            {emptyStorage && (
              <p>
                {pendingIndustry ? "Live storage volume" : "Storage volume"}:{" "}
                {emptyStorage.usedVolume.toLocaleString()} /{" "}
                {emptyStorage.capacity.toLocaleString()} m³.
              </p>
            )}
            <p>
              {emptyBlueprintReason ||
                directReason ||
                "The server checks space for all materials before moving anything. Both inventories move together, then their blockchain objects synchronize."}
            </p>
          </form>
          <form
            className="industry-start industry-transfer"
            onSubmit={(event) => {
              event.preventDefault();
              void manageBlueprint("blueprint");
            }}
            aria-label="Change active blueprint"
          >
            <h3>Change active blueprint</h3>
            <p>
              Choose a new recipe after emptying the current blueprint's input
              and output inventories.
            </p>
            <button
              type="button"
              disabled={
                disabled ||
                !canAccess ||
                !session ||
                authBusy ||
                !!operation ||
                stale
              }
              onClick={() => void loadBlueprints()}
            >
              {operation === "blueprints"
                ? "Loading available blueprints…"
                : blueprints
                  ? "Reload available blueprints"
                  : "Load available blueprints"}
            </button>
            {blueprintError && (
              <p className="energy-error" role="alert">
                {blueprintError}
              </p>
            )}
            {blueprints && (
              <>
                <fieldset
                  disabled={
                    disabled ||
                    !canAccess ||
                    !session ||
                    authBusy ||
                    !!operation ||
                    stale ||
                    !!blueprintError
                  }
                >
                  <div className="industry-start-controls industry-transfer-controls">
                    <label>
                      New blueprint
                      <select
                        name="blueprintID"
                        value={
                          selectedBlueprint
                            ? blueprintSelection.blueprintID
                            : ""
                        }
                        onChange={(event) =>
                          updateBlueprint({ blueprintID: event.target.value })
                        }
                      >
                        <option value="">Select a different blueprint</option>
                        {blueprints.map((blueprint) => (
                          <option
                            key={blueprint.blueprintID}
                            value={blueprint.blueprintID}
                            disabled={
                              blueprint.blueprintID === snapshot.blueprint_id
                            }
                          >
                            {typeName(blueprint.blueprintID, blueprint.name)} (#
                            {blueprint.blueprintID})
                            {blueprint.blueprintID === snapshot.blueprint_id
                              ? pendingIndustry
                                ? " · After queue"
                                : " · Active"
                              : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="primary"
                      disabled={!!changeBlueprintReason}
                    >
                      {operation === "blueprint"
                        ? "Changing blueprint…"
                        : "Change blueprint"}
                    </button>
                    {onQueueTask && (
                      <button
                        type="button"
                        disabled={!!queueBlueprintReason}
                        onClick={() => queueBlueprintAction("blueprint")}
                      >
                        Queue blueprint change
                      </button>
                    )}
                  </div>
                </fieldset>
                {!blueprints.length && (
                  <p>No blueprints are available for this facility.</p>
                )}
                {selectedBlueprint && (
                  <p>
                    {amount(selectedBlueprint.runTime)} s per run · Inputs:{" "}
                    {selectedBlueprint.inputs
                      .map(
                        (slot) =>
                          `${amount(slot.quantity)} × ${typeName(slot.type_id)}`,
                      )
                      .join(", ") || "None"}{" "}
                    · Outputs:{" "}
                    {selectedBlueprint.outputs
                      .map(
                        (slot) =>
                          `${amount(slot.quantity)} × ${typeName(slot.type_id)}`,
                      )
                      .join(", ") || "None"}
                    .
                  </p>
                )}
              </>
            )}
            <p>
              {changeBlueprintReason ||
                "The server verifies that the selected blueprint and stopped job still match this view before changing the recipe."}
            </p>
            {onQueueTask && !queueBlueprintReason && hasBlueprintItems && (
              <p>
                Queue Empty active blueprint first, then queue this blueprint
                change. The active recipe is checked again when each task
                executes.
              </p>
            )}
          </form>
          <form
            className="industry-start"
            onSubmit={(event) => {
              event.preventDefault();
              void act("start");
            }}
            aria-label="Start Industry production"
          >
            <h3>Start a job</h3>
            <p>
              Use the selected blueprint and facility input inventory. Your
              character must be in space within 5 km of the facility.
            </p>
            <div className="industry-start-controls">
              <label>
                Number of runs
                <input
                  name="runs"
                  type="text"
                  inputMode="numeric"
                  value={runs}
                  disabled={
                    continuous ||
                    !!operation ||
                    !!running ||
                    projection?.productionQueued
                  }
                  onChange={(event) =>
                    setDraft({ context, runs: event.target.value, continuous })
                  }
                  aria-describedby="industry-start-help"
                />
              </label>
              <label className="industry-continuous">
                <input
                  type="checkbox"
                  checked={continuous}
                  disabled={
                    !!operation || !!running || projection?.productionQueued
                  }
                  onChange={(event) =>
                    setDraft({
                      context,
                      runs,
                      continuous: event.target.checked,
                    })
                  }
                />
                Continuous production
              </label>
              <button
                className="primary"
                type="submit"
                disabled={
                  disabled ||
                  !canAccess ||
                  !session ||
                  authBusy ||
                  !!operation ||
                  stale ||
                  !!directReason ||
                  !!startReason
                }
              >
                {operation === "start"
                  ? "Starting production…"
                  : "Start production"}
              </button>
              {onQueueTask && (
                <button
                  type="button"
                  disabled={
                    disabled ||
                    !canAccess ||
                    !session ||
                    authBusy ||
                    !!operation ||
                    stale ||
                    !!queueStartReason
                  }
                  onClick={queueProduction}
                >
                  Queue production
                </button>
              )}
            </div>
            <p id="industry-start-help">
              {queueError ||
                directReason ||
                startReason ||
                (continuous
                  ? "Runs until inputs run out, outputs fill up, or production is stopped in game."
                  : "Inputs are consumed one run at a time. Production stops if inputs run out or outputs fill up.")}
            </p>
            {onQueueTask &&
              queueStartReason &&
              queueStartReason !== startReason && <p>{queueStartReason}</p>}
            {onQueueTask && !queueStartReason && startReason && (
              <p>
                Production can be queued after tasks that supply inputs, clear
                outputs, or bring this facility online.
              </p>
            )}
          </form>
          <div className="industry-production" aria-live="polite">
            <div className="industry-heading">
              <h3>Production</h3>
              {production && (
                <span className={`state ${running ? "online" : "offline"}`}>
                  {production.state}
                </span>
              )}
            </div>
            {!production ? (
              <p className="storage-empty">
                No active job. New production requests will appear here
                automatically.
              </p>
            ) : (
              <>
                <dl className="energy-summary industry-summary">
                  <div>
                    <dt>Job ID</dt>
                    <dd>#{production.job_id}</dd>
                  </div>
                  <div>
                    <dt>Completed runs</dt>
                    <dd>{amount(production.completed_runs)}</dd>
                  </div>
                  <div>
                    <dt>Requested runs</dt>
                    <dd>
                      {production.requested_runs === null
                        ? "Continuous"
                        : amount(production.requested_runs)}
                    </dd>
                  </div>
                </dl>
                {running && (
                  <>
                    <progress
                      className="industry-progress"
                      max={100}
                      value={progress}
                      aria-label="Current run progress"
                    />
                    <p>
                      {stale
                        ? "Timing is based on the last successful read."
                        : remaining > 0n
                          ? `${remaining.toLocaleString()} s until the current run is due.`
                          : "Run is due. Waiting for the server's next production update."}
                    </p>
                    {production.state === "DISCONTINUING" && (
                      <p>Production will stop after the current run.</p>
                    )}
                  </>
                )}
                {production.stop_reason && (
                  <p className="industry-stop">
                    Stopped: {words(production.stop_reason)}.
                  </p>
                )}
              </>
            )}
          </div>
          <h3 className="industry-inventory-heading">
            {queueError
              ? "Facility inventory before blocked task"
              : pendingIndustry
                ? "Facility inventory after queue"
                : "Facility inventory"}
          </h3>
          <Inventory
            title="Input inventory"
            stacks={snapshot.inputs}
            recipe={snapshot.blueprint_inputs}
            typeName={typeName}
          />
          <Inventory
            title="Output inventory"
            stacks={snapshot.outputs}
            recipe={snapshot.blueprint_outputs}
            typeName={typeName}
          />
          <form
            className="industry-start industry-transfer"
            onSubmit={(event) => {
              event.preventDefault();
              void moveItems();
            }}
            aria-label="Transfer Industry inventory"
          >
            <h3>Transfer items</h3>
            <p>
              Your character must be within range of the Industry facility and
              an online Smart Storage Unit. The list shows storage inventory
              your character can access.
            </p>
            {storageError && (
              <p className="energy-error" role="alert">
                {storageError} Storage readings may be out of date.
              </p>
            )}
            <fieldset
              disabled={
                disabled ||
                !canAccess ||
                !session ||
                authBusy ||
                !!operation ||
                stale ||
                !storageUnits ||
                !!storageError
              }
            >
              <div className="industry-start-controls industry-transfer-controls">
                <label>
                  Smart Storage Unit
                  <select
                    name="storageUnitID"
                    value={selectedStorage ? transfer.storageUnitID : ""}
                    onChange={(event) =>
                      updateTransfer({
                        storageUnitID: event.target.value,
                        typeID: "",
                      })
                    }
                  >
                    <option value="">Select nearby storage</option>
                    {storageUnits?.map((unit) => (
                      <option
                        key={unit.storageUnitID}
                        value={String(unit.storageUnitID)}
                      >
                        {unit.name || `Storage #${unit.storageUnitID}`} (#
                        {unit.storageUnitID})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Direction
                  <select
                    name="direction"
                    value={transfer.direction}
                    onChange={(event) =>
                      updateTransfer({
                        direction: event.target.value as "deposit" | "withdraw",
                        side:
                          event.target.value === "deposit"
                            ? "inputs"
                            : "outputs",
                        typeID: "",
                      })
                    }
                  >
                    <option value="deposit">Storage → Industry</option>
                    <option value="withdraw">Industry → Storage</option>
                  </select>
                </label>
                <label>
                  Industry inventory
                  <select
                    name="side"
                    value={transfer.side}
                    disabled={transfer.direction === "deposit"}
                    onChange={(event) =>
                      updateTransfer({
                        side: event.target.value as "inputs" | "outputs",
                        typeID: "",
                      })
                    }
                  >
                    <option value="inputs">Inputs</option>
                    {transfer.direction === "withdraw" && (
                      <option value="outputs">Outputs</option>
                    )}
                  </select>
                </label>
                <label>
                  Item type
                  <select
                    name="typeID"
                    value={selectedItem ? transfer.typeID : ""}
                    onChange={(event) =>
                      updateTransfer({ typeID: event.target.value })
                    }
                  >
                    <option value="">Select an item</option>
                    {[...transferable].map(([type, item]) => (
                      <option key={type} value={type}>
                        {item.name} · {item.quantity.toLocaleString()} available
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Quantity
                  <input
                    name="transferQuantity"
                    type="text"
                    inputMode="numeric"
                    value={transfer.quantity}
                    onChange={(event) =>
                      updateTransfer({ quantity: event.target.value })
                    }
                    aria-describedby="industry-transfer-help"
                  />
                </label>
                <button
                  type="submit"
                  className="primary"
                  disabled={!!directReason || !!transferReason}
                >
                  {operation === "transfer" ? "Moving items…" : "Move items"}
                </button>
                {onQueueTask && (
                  <button
                    type="button"
                    disabled={!!transferReason}
                    onClick={queueTransfer}
                  >
                    Queue transfer
                  </button>
                )}
              </div>
            </fieldset>
            {selectedStorage && (
              <p>
                {pendingIndustry ? "Live storage volume" : "Storage volume"}:{" "}
                {selectedStorage.usedVolume.toLocaleString()} /{" "}
                {selectedStorage.capacity.toLocaleString()} m³.
              </p>
            )}
            <p id="industry-transfer-help">
              {transferReason ||
                directReason ||
                "The server checks inventory, access, and capacity again before moving items, then synchronizes both blockchain objects."}
            </p>
            {lastTransfer && lastTransfer.chain.status !== "synced" && (
              <div className="industry-transfer-sync">
                <p>
                  Last transfer to or from storage #{lastTransfer.storageUnitID}
                  : Industry {lastTransfer.chain.industryStatus}; storage{" "}
                  {lastTransfer.chain.storageStatus}.
                </p>
                <button
                  type="button"
                  disabled={
                    disabled ||
                    !canAccess ||
                    !session ||
                    authBusy ||
                    !!operation
                  }
                  onClick={() => void syncTransfer()}
                >
                  {operation === "storage-sync"
                    ? "Synchronizing inventories…"
                    : "Sync both inventories"}
                </button>
              </div>
            )}
          </form>
          <div className="storage-chain">
            <div className="industry-heading">
              <h3>Blockchain synchronization</h3>
              <span
                className={`state ${status.chain.status === "synced" ? "online" : "offline"}`}
              >
                {status.chain.status.toUpperCase()}
              </span>
            </div>
            <p>{chainText[status.chain.status]}</p>
            {status.chain.status !== "synced" &&
              status.chain.status !== "disabled" && (
                <button
                  disabled={
                    disabled ||
                    !canAccess ||
                    !session ||
                    authBusy ||
                    !!operation
                  }
                  onClick={() => void act("sync")}
                >
                  {operation === "sync" ? "Synchronizing…" : "Sync blockchain"}
                </button>
              )}
            <dl className="chain-details">
              <div>
                <dt>Revision</dt>
                <dd>
                  {status.chain.revision
                    ? amount(status.chain.revision)
                    : "Not yet recorded"}
                </dd>
              </div>
              <div>
                <dt>Last synchronized</dt>
                <dd>{timestamp(status.chain.syncedAtMs)}</dd>
              </div>
              {status.chain.industryObjectID && (
                <div>
                  <dt>Industry object</dt>
                  <dd>
                    <code>{status.chain.industryObjectID}</code>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}
    </section>
  );
}
