import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import {
  buildAssemblyTransaction,
  configFromEnv,
  FEATURE_PACKAGES,
  loadAssembly,
  resolveAssemblyId,
  validateAssemblyAction,
} from "./assembly/index.ts";
import type { AssemblyAction, AssemblySnapshot } from "./assembly/index.ts";
import { TransactionSubmissionError } from "./wallet.ts";
import {
  adminItemId,
  adminOperationFinished,
  adminRecoveryKey,
  createAdminClient,
  readAdminRecovery,
  validatePreparedAdminTransaction,
} from "./admin/client.ts";
import type { AdminSession, SignedAdminTransaction } from "./admin/client.ts";
import { createWalletConnection } from "./wallet-connection.ts";
import { ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { StoragePanel } from "./components/StoragePanel.tsx";
import { EnergyGridPanel } from "./components/EnergyGridPanel.tsx";
import { RemoteScanningPanel } from "./components/RemoteScanningPanel.tsx";
import { FuelMonitorPanel } from "./components/FuelMonitorPanel.tsx";
import { GatePanel } from "./components/GatePanel.tsx";
import { IndustryPanel } from "./components/IndustryPanel.tsx";
import { TaskQueuePanel } from "./components/TaskQueuePanel.tsx";
import { createTaskQueue } from "./tasks/queue.ts";
import { executeTask } from "./tasks/execute.ts";
import {
  MAX_IMPORTED_QUEUE_BYTES,
  parseTaskQueue,
  serializeTaskQueue,
} from "./tasks/portable.ts";
import type { TaskDraft } from "./tasks/types.ts";
import type { WalletSession } from "./wallet.ts";
import type { AssemblyEnvironment } from "./assembly/runtime-config.ts";
import {
  assemblyInput,
  assemblySelection,
  assemblyView,
  assemblyViewUrl,
} from "./assembly/routes.ts";
import type { AssemblyView } from "./assembly/routes.ts";

const labels = {
  assembly: "Smart Assembly",
  gate: "Smart Gate",
  storage_unit: "Smart Storage Unit",
  turret: "Smart Turret",
  network_node: "Network Node",
};
const featureLabels = {
  npc: "NPC identity",
  catapult: "Catapult",
  smartIndustry: "Smart industry",
  transponder: "Transponder",
  assemblyAccess: "Assembly access",
};
const adminApi = createAdminClient();
async function readForReview(
  config: Parameters<typeof loadAssembly>[0],
  id: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      loadAssembly(config, id),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Reading the assembly timed out. Check the local Sui node and refresh before trying again.",
              ),
            ),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function readConfig(env: AssemblyEnvironment, configurationError: string) {
  try {
    if (configurationError) throw new Error(configurationError);
    return { config: configFromEnv(env), error: "" };
  } catch (error) {
    return { config: configFromEnv({}), error: message(error) };
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function short(value?: string) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—";
}
function affected(snapshot: AssemblySnapshot) {
  return snapshot.connectedAssemblies
    .map((a) => `${a.id}:${a.state}`)
    .sort()
    .join("|");
}
type Activity = {
  time: string;
  title: string;
  digest: string;
  failed?: boolean;
};

function AssemblyGraphic({ state }: { state: string }) {
  return (
    <div className={`assembly-graphic ${state}`} aria-hidden="true">
      <svg viewBox="0 0 380 300" fill="none">
        <defs>
          <pattern
            id="grid"
            width="28"
            height="28"
            patternUnits="userSpaceOnUse"
          >
            <path d="M28 0H0V28" stroke="currentColor" strokeOpacity=".08" />
          </pattern>
        </defs>
        <rect width="380" height="300" fill="url(#grid)" />
        <ellipse
          cx="190"
          cy="239"
          rx="118"
          ry="34"
          stroke="currentColor"
          strokeOpacity=".2"
          strokeDasharray="4 7"
        />
        <path
          d="M190 25V275M30 150H350"
          stroke="currentColor"
          strokeOpacity=".15"
          strokeDasharray="3 6"
        />
        <path
          d="M124 219 190 256 257 219 190 181Z"
          fill="#171d1b"
          stroke="currentColor"
        />
        <path
          d="M190 60 231 84 231 212 190 238 149 212 149 84Z"
          fill="#151b18"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="m149 84 41 24 41-24M190 108v130M149 120l41 24 41-24M149 161l41 24 41-24"
          stroke="currentColor"
        />
        <path
          d="m124 147-27 15v56l27 15 25-14v-57ZM256 147l27 15v56l-27 15-25-14v-57Z"
          fill="#151b18"
          stroke="currentColor"
        />
        <path
          d="m163 91 27 16 27-16-27-16Z"
          className="core"
          fill="currentColor"
          fillOpacity=".22"
          stroke="currentColor"
        />
        <path
          d="m161 121 18 11v24l-18-11ZM202 131l17-10v24l-17 10Z"
          fill="currentColor"
          fillOpacity=".35"
        />
        <path
          d="M83 75h28M97 61v28M280 222h26M293 209v26"
          stroke="currentColor"
          strokeOpacity=".4"
        />
      </svg>
      <span className="diagram-tag">
        {state === "unknown"
          ? "AWAITING TELEMETRY"
          : `SYSTEM ${state.toUpperCase()}`}
      </span>
    </div>
  );
}

function App({
  env = import.meta.env,
  configurationError = "",
}: {
  env?: AssemblyEnvironment;
  configurationError?: string;
}) {
  const [initial] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const settings = readConfig(env, configurationError);
    return {
      ...settings,
      params,
      input: assemblyInput(settings.config, params),
    };
  });
  const { config, params: initialParams, input: initialInput } = initial;
  const [selection, setSelection] = useState(initialParams);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const [input, setInput] = useState(initialInput);
  const [tenant, setTenant] = useState(
    initialParams.get("tenant") || config.defaultTenant || "dev",
  );
  const [assembly, setAssembly] = useState<AssemblySnapshot | null>(null);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState("");
  const [actionBusy, setBusy] = useState("");
  const [industryBusy, setIndustryBusy] = useState("");
  const [taskQueue] = useState(createTaskQueue);
  const queueState = useSyncExternalStore(
    taskQueue.subscribe,
    taskQueue.getSnapshot,
  );
  const [queueProgress, setQueueProgress] = useState("");
  const [queueRevision, setQueueRevision] = useState(0);
  const busy =
    actionBusy ||
    industryBusy ||
    (queueState.running ? queueProgress || "Running task queue" : "");
  const mounted = useRef(true);
  const [stale, setStale] = useState(false);
  const [walletConnection] = useState(() => createWalletConnection(config));
  const {
    wallets,
    wallet,
    pending: walletPending,
    retrying: walletRetrying,
    error: walletError,
  } = useSyncExternalStore(
    walletConnection.subscribe,
    walletConnection.getSnapshot,
  );
  const [walletId, setWalletId] = useState("");
  const [review, setReview] = useState<{
    action: AssemblyAction;
    snapshot: AssemblySnapshot;
  } | null>(null);
  const currentReview = useRef(review);
  currentReview.current = review;
  const [activity, setActivity] = useState<Activity[]>([]);
  const [adminSession, setAdminSession] = useState<AdminSession | null>(null);
  const [adminRecovery, setAdminRecovery] =
    useState<SignedAdminTransaction | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  const assemblyId = assembly?.id || "";
  const recoveryKey = adminRecoveryKey(
    config,
    assemblyId,
    wallet?.address || "",
  );
  const [tab, setTab] = useState<AssemblyView | "activity">(
    assemblyView(window.location.pathname),
  );
  const [connected, setConnected] = useState(navigator.onLine);
  const request = useRef(0);
  const lock = useRef(false);
  const configured = !!config.packageId && !initial.error;
  const canReachNetwork = config.network === "localnet" || connected;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      taskQueue.stop();
    };
  }, [taskQueue]);

  useEffect(() => {
    if (configured) return walletConnection.start();
  }, [configured, walletConnection]);
  useEffect(() => {
    setReview(null);
    setAdminSession(null);
  }, [wallet]);
  useEffect(() => {
    setAdminRecovery(null);
    setRecoveryError("");
    if (!assemblyId || !wallet || config.network !== "localnet") return;
    try {
      setAdminRecovery(
        readAdminRecovery(
          sessionStorage.getItem(recoveryKey),
          assemblyId,
          wallet.address,
        ),
      );
    } catch (err) {
      setRecoveryError(message(err));
    }
  }, [assemblyId, wallet, config.network, recoveryKey, queueRevision]);
  useEffect(() => {
    const update = () => {
      setConnected(navigator.onLine);
      if (!navigator.onLine && config.network !== "localnet") {
        setStale(true);
        setReview(null);
      }
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [config.network]);

  const refresh = useCallback(
    async (id: string) => {
      if (!configured) return;
      const token = ++request.current;
      setBusy("Reading chain state");
      setError("");
      setReview(null);
      try {
        const snapshot = await loadAssembly(config, id);
        if (token === request.current) {
          setAssembly(snapshot);
          setStale(false);
        }
      } catch (err) {
        if (token === request.current) {
          setError(message(err));
          setStale(true);
        }
      } finally {
        if (token === request.current) setBusy("");
      }
    },
    [config, configured],
  );

  useEffect(() => {
    const selectedInput = assemblyInput(config, selection);
    setInput(selectedInput);
    setTenant(selection.get("tenant") || config.defaultTenant || "dev");
    setAssembly(null);
    setReview(null);
    setNotice("");
    setError(initial.error);
    setBusy("");
    if (!selectedInput || !configured) return;
    const requestCounter = request;
    try {
      void refresh(resolveAssemblyId(config, selection));
    } catch (err) {
      setError(message(err));
    }
    return () => {
      requestCounter.current++;
    };
  }, [config, configured, initial.error, selection, refresh]);

  useEffect(() => {
    const navigate = () => {
      setTab(assemblyView(window.location.pathname));
      const params = new URLSearchParams(window.location.search);
      setSelection((current) =>
        current.toString() === params.toString() ? current : params,
      );
    };
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);

  function changeView(view: AssemblyView | "activity") {
    setTab(view);
    if (view !== "activity") {
      const url = assemblyViewUrl(view, window.location.search);
      if (url !== `${window.location.pathname}${window.location.search}`)
        window.history.pushState(null, "", url);
    }
  }

  async function openAssembly(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !configured) return;
    setNotice("");
    setAssembly(null);
    try {
      const params = assemblySelection(window.location.search, input, tenant);
      resolveAssemblyId(config, params);
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${params}`,
      );
      setSelection(params);
    } catch (err) {
      setError(message(err));
    }
  }

  async function toggleWallet() {
    if (busy || walletPending || !configured) return;
    setReview(null);
    if (wallet) await walletConnection.disconnect();
    else await walletConnection.connect(walletId || wallets[0]?.id || "");
  }

  async function prepare(action: AssemblyAction) {
    if (
      !configured ||
      !assembly ||
      !wallet ||
      busy ||
      lock.current ||
      adminRecovery ||
      recoveryError
    )
      return;
    lock.current = true;
    const selected = currentSelection.current;
    setBusy("Checking assembly");
    setError("");
    setNotice("");
    try {
      const fresh = await readForReview(config, assembly.id);
      if (
        walletConnection.getSnapshot().wallet !== wallet ||
        currentSelection.current !== selected
      )
        return;
      setAssembly(fresh);
      setStale(false);
      validateAssemblyAction(config, fresh, action, wallet.address);
      if (config.network === "localnet") adminItemId(fresh, config);
      setReview({ action, snapshot: fresh });
    } catch (err) {
      if (currentSelection.current !== selected) return;
      setError(message(err));
      setStale(true);
    } finally {
      lock.current = false;
      if (currentSelection.current === selected) setBusy("");
    }
  }

  async function authenticateAdmin() {
    if (!wallet) throw new Error("Connect the assembly owner's wallet.");
    if (
      adminSession &&
      new Date(adminSession.expiresAt).getTime() > Date.now() + 5000
    )
      return adminSession;
    setBusy("Awaiting wallet approval to connect to the admin service");
    const session = await adminApi.authenticate(wallet, config);
    if (walletConnection.getSnapshot().wallet !== wallet)
      throw new Error("The wallet changed. Reconnect and review again.");
    setAdminSession(session);
    return session;
  }

  async function recoverAdmin() {
    if (!adminRecovery || !wallet || busy || lock.current) return;
    lock.current = true;
    const selected = currentSelection.current;
    const sameContext = () =>
      currentSelection.current === selected &&
      walletConnection.getSnapshot().wallet === wallet;
    setError("");
    try {
      const session = await authenticateAdmin();
      if (!sameContext()) return;
      setBusy("Checking the submitted admin transaction");
      const result = await adminApi.execute(session.token, adminRecovery);
      sessionStorage.removeItem(recoveryKey);
      setActivity((items) => [
        {
          time: new Date().toLocaleTimeString(),
          title: `Assembly brought ${result.action}`,
          digest: result.digest,
        },
        ...items,
      ]);
      if (!sameContext()) return;
      setAdminRecovery(null);
      setNotice(
        `Transaction confirmed. The game and chain recorded the assembly as ${result.action}.`,
      );
      await refresh(adminRecovery.assemblyObjectID);
    } catch (err) {
      if (adminOperationFinished(err)) {
        sessionStorage.removeItem(recoveryKey);
        if (sameContext()) setAdminRecovery(null);
        setActivity((items) => [
          {
            time: new Date().toLocaleTimeString(),
            title: message(err),
            digest: adminRecovery.digest,
            failed: true,
          },
          ...items,
        ]);
      }
      if (sameContext()) {
        setAdminSession(null);
        setError(message(err));
      }
    } finally {
      lock.current = false;
      if (currentSelection.current === selected) setBusy("");
    }
  }

  async function execute() {
    if (
      !configured ||
      !review ||
      !wallet ||
      busy ||
      lock.current ||
      !canReachNetwork
    )
      return;
    lock.current = true;
    const selected = currentSelection.current;
    const sameContext = () =>
      currentSelection.current === selected &&
      walletConnection.getSnapshot().wallet === wallet;
    let operation: SignedAdminTransaction | undefined;
    setBusy("Awaiting wallet approval and confirmation");
    setError("");
    try {
      const fresh = await readForReview(config, review.snapshot.id);
      if (currentSelection.current !== selected) return;
      if (
        currentReview.current !== review ||
        walletConnection.getSnapshot().wallet !== wallet
      ) {
        throw new Error(
          "The review was closed or your wallet changed. Review the action again.",
        );
      }
      if (
        fresh.state !== review.snapshot.state ||
        fresh.kind !== review.snapshot.kind ||
        fresh.networkNodeId !== review.snapshot.networkNodeId ||
        affected(fresh) !== affected(review.snapshot)
      )
        throw new Error(
          "The assembly changed while you were reviewing it. Review the action again.",
        );
      validateAssemblyAction(config, fresh, review.action, wallet.address);
      let result: { digest: string };
      if (config.network === "localnet") {
        const assertCurrent = () => {
          if (
            currentSelection.current !== selected ||
            currentReview.current !== review ||
            walletConnection.getSnapshot().wallet !== wallet
          )
            throw new Error(
              "The wallet or assembly changed. Review the action again.",
            );
        };
        const session = await authenticateAdmin();
        assertCurrent();
        setBusy("Preparing a sponsored admin transaction");
        const prepared = await adminApi.prepare(
          fresh,
          config,
          session.token,
          review.action,
        );
        const checked = await validatePreparedAdminTransaction(
          prepared,
          config,
          fresh,
          review.action,
          wallet.address,
        );
        assertCurrent();
        setBusy("Awaiting wallet approval; the server pays gas");
        const signed = await wallet.signTransaction(
          checked.transaction,
          config,
        );
        assertCurrent();
        if (signed.bytes !== checked.bytes)
          throw new Error(
            "The wallet changed the prepared transaction. Review the action again.",
          );
        operation = {
          transactionUUID: prepared.transactionUUID,
          action: review.action,
          assemblyID: adminItemId(fresh, config),
          assemblyObjectID: fresh.id,
          walletAddress: wallet.address,
          bytes: signed.bytes,
          signature: signed.signature,
          digest: checked.digest,
        };
        // Persist before submission so a reload or lost response can recover identical bytes.
        sessionStorage.setItem(recoveryKey, JSON.stringify(operation));
        setAdminRecovery(operation);
        setBusy("Confirming the sponsored transaction and game state");
        result = await adminApi.execute(session.token, operation);
        sessionStorage.removeItem(recoveryKey);
        if (sameContext()) setAdminRecovery(null);
      } else {
        const transaction = buildAssemblyTransaction(
          config,
          fresh,
          review.action,
          wallet.address,
        );
        result = await wallet.signAndExecute(transaction, config);
      }
      setActivity((items) => [
        {
          time: new Date().toLocaleTimeString(),
          title: `${labels[fresh.kind]} brought ${review.action}`,
          digest: result.digest,
        },
        ...items,
      ]);
      if (!sameContext()) return;
      setNotice(
        config.network === "localnet"
          ? `Transaction confirmed. The game and chain recorded the assembly as ${review.action}.`
          : `Transaction confirmed. Assembly is ${review.action}.`,
      );
      setReview(null);
      try {
        const updated = await loadAssembly(config, fresh.id);
        if (currentSelection.current !== selected) return;
        setAssembly(updated);
        setStale(false);
      } catch {
        if (currentSelection.current !== selected) return;
        setStale(true);
        setAdminSession(null);
        setError(
          "The transaction confirmed, but refreshing the assembly failed. Refresh to read its latest state.",
        );
      }
    } catch (err) {
      if (operation && adminOperationFinished(err)) {
        sessionStorage.removeItem(recoveryKey);
        if (sameContext()) setAdminRecovery(null);
        setActivity((items) => [
          {
            time: new Date().toLocaleTimeString(),
            title: message(err),
            digest: operation!.digest,
            failed: true,
          },
          ...items,
        ]);
      }
      if (sameContext()) {
        setError(message(err));
        setReview(null);
        setStale(true);
        setAdminSession(null);
      }
      if (err instanceof TransactionSubmissionError && err.digest)
        setActivity((items) => [
          {
            time: new Date().toLocaleTimeString(),
            title: "Check transaction result before retrying",
            digest: err.digest,
            failed: true,
          },
          ...items,
        ]);
    } finally {
      lock.current = false;
      if (currentSelection.current === selected) setBusy("");
    }
  }

  function enqueueTask(draft: TaskDraft) {
    if (!configured || !wallet || busy || lock.current) return;
    if (taskQueue.enqueue(draft, wallet, wallet.address))
      setNotice(
        `${draft.title} added to the task queue. Review the queue, then select Run queue.`,
      );
    else
      setError(
        "The task queue is full. Remove or export pending tasks before adding another.",
      );
  }

  function exportTaskQueue() {
    if (!configured || !wallet || taskQueue.getSnapshot().running) return;
    setError("");
    try {
      const contents = serializeTaskQueue(
        taskQueue.getSnapshot().tasks,
        config,
        wallet.address,
      );
      const blob = new Blob([contents], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `eve-frontier-queue-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice(
        "Pending tasks exported. The file contains no signatures, authorizations, or recovery records.",
      );
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function importTaskQueue(file: File) {
    if (!configured || !wallet || busy || lock.current) return;
    if (file.size > MAX_IMPORTED_QUEUE_BYTES) {
      setError(
        `Queue files must be no larger than ${MAX_IMPORTED_QUEUE_BYTES.toLocaleString()} bytes.`,
      );
      return;
    }
    const originalWallet = wallet;
    lock.current = true;
    setBusy("Importing task queue");
    setError("");
    setNotice("");
    try {
      const contents = await file.text();
      if (
        !mounted.current ||
        walletConnection.getSnapshot().wallet !== originalWallet
      )
        throw new Error(
          "The wallet session changed while the queue file was being read. Import it again with the intended wallet.",
        );
      const drafts = parseTaskQueue(contents, config, originalWallet.address);
      const count = taskQueue.importTasks(
        drafts,
        originalWallet,
        originalWallet.address,
      );
      setNotice(
        `${count} ${count === 1 ? "task" : "tasks"} imported and bound to the connected wallet. Review the queue before running it.`,
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy("");
    }
  }

  function queueAssemblyState(action: AssemblyAction) {
    if (!assembly || actionDisabled) return;
    const shutdown = assembly.kind === "network_node" && action === "offline";
    enqueueTask({
      title:
        action === "online" ? "Bring assembly online" : "Take assembly offline",
      details: `Set ${assembly.name} ${action}.${shutdown ? ` This also takes its ${assembly.connectedAssemblies.length} connected assemblies offline: ${assembly.connectedAssemblies.map((item) => item.name || item.id).join(", ") || "none"}.` : ""}`,
      assembly,
      operation: { kind: "assembly-state", action, snapshot: assembly },
    });
  }

  async function runTaskQueue() {
    if (
      !configured ||
      !wallet ||
      busy ||
      lock.current ||
      review ||
      !canReachNetwork
    )
      return;
    lock.current = true;
    setNotice("");
    const originalWallet = wallet;
    const assertCurrent = () => {
      if (
        !mounted.current ||
        walletConnection.getSnapshot().wallet !== originalWallet
      )
        throw new Error(
          "The wallet session changed. Remove the remaining tasks and queue them again with the connected wallet.",
        );
      if (config.network !== "localnet" && !navigator.onLine)
        throw new Error(
          "The network disconnected. Inspect the task before continuing.",
        );
    };
    const guardedWallet: WalletSession = {
      ...originalWallet,
      async signTransaction(transaction, settings) {
        assertCurrent();
        const signed = await originalWallet.signTransaction(
          transaction,
          settings,
        );
        assertCurrent();
        return signed;
      },
      async signAndExecute(transaction, settings) {
        assertCurrent();
        return originalWallet.signAndExecute(transaction, settings);
      },
    };
    try {
      await taskQueue.run(async (task, signal) => {
        assertCurrent();
        if (task.walletIdentity !== originalWallet)
          throw new Error(
            "This task was queued with a different wallet session. Remove it and queue it again with the connected wallet.",
          );
        setQueueProgress(task.title);
        const result = await executeTask(task, {
          config,
          wallet: guardedWallet,
          assertCurrent,
          progress: setQueueProgress,
          signal,
        });
        if (mounted.current)
          setActivity((items) =>
            [
              {
                time: new Date().toLocaleTimeString(),
                title: `${task.title} · ${task.assembly.name} · ${result.message}`,
                digest: result.digest || `Queue task ${task.id}`,
              },
              ...items,
            ].slice(0, 200),
          );
        return result;
      });
    } finally {
      if (mounted.current) {
        setQueueProgress("");
        // Reload specialized panels to expose current inventory, production and recovery controls.
        setQueueRevision((value) => value + 1);
        try {
          await refresh(resolveAssemblyId(config, currentSelection.current));
        } catch {
          /* No selected assembly. */
        }
      }
      lock.current = false;
    }
  }

  const isOwner =
    !!wallet &&
    !!assembly &&
    normalizeSuiAddress(wallet.address) ===
      normalizeSuiAddress(assembly.ownerAddress);
  const actionDisabled =
    !configured ||
    !!busy ||
    !wallet ||
    !isOwner ||
    stale ||
    !canReachNetwork ||
    !!adminRecovery ||
    !!recoveryError;
  const status = assembly?.state || "unknown";
  let monitorAssemblyId: string | null = null;
  if (tab === "network" && configured) {
    try {
      monitorAssemblyId = resolveAssemblyId(config, selection);
    } catch {
      /* The assembly locator displays selection errors below. */
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href={assemblyViewUrl("overview", window.location.search)}
          aria-label="Assembly Control home"
        >
          <span className="brand-mark">F</span>
          <span>
            EVE <b>FRONTIER</b>
            <small>BUILDER SCAFFOLD</small>
          </span>
        </a>
        <div className="header-actions">
          <span className="network-pill">
            <i />
            {config.network}
          </span>
          {!wallet && wallets.length > 1 && (
            <select
              aria-label="Wallet"
              value={walletId || wallets[0]?.id}
              onChange={(e) => setWalletId(e.target.value)}
              disabled={!!busy || walletPending}
            >
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="wallet-button"
            disabled={
              !configured ||
              !!busy ||
              walletPending ||
              (!wallet && !wallets.length)
            }
            onClick={() => void toggleWallet()}
          >
            {walletPending
              ? "Connecting wallet…"
              : wallet
                ? `${short(wallet.address)} · Disconnect`
                : wallets.length
                  ? "Connect wallet ↗"
                  : "No wallet detected"}
          </button>
        </div>
      </header>
      <main>
        {tab === "network" && (
          <FuelMonitorPanel
            key={monitorAssemblyId || "unselected"}
            assemblyId={monitorAssemblyId}
            config={config}
            tenant={assembly?.tenant || tenant}
            visible
          />
        )}
        <div className="page-heading">
          <div>
            <div className="eyebrow">FRONTIER OPERATIONS / 01</div>
            <h1>
              {tab === "storage"
                ? "Storage inventory"
                : tab === "industry"
                  ? "Smart Industry status"
                  : tab === "gate"
                    ? "Smart Gate links"
                    : tab === "behaviour"
                      ? "Assembly behaviour"
                      : tab === "network"
                        ? "Network monitoring"
                        : tab === "scanning"
                          ? "Remote system scanning"
                          : tab === "scanResults"
                            ? "Remote scan results"
                        : "Assembly control"}
              <span>.</span>
            </h1>
            <p>
              {tab === "behaviour"
                ? "Inspect configured behaviour and control the assembly’s operational state."
                : tab === "industry"
                  ? "Follow production, blueprint selection, and inventory as requests reach this assembly."
                  : tab === "network"
                    ? "Monitor fuel and inspect the node’s connected infrastructure."
                    : tab === "scanning"
                      ? "Survey reachable solar systems for sites, resources, and aggregate entity signatures."
                      : tab === "scanResults"
                        ? "Inspect resolved signatures and an interactive three-dimensional entity heat map."
                    : "Inspect your assembly’s configuration and current state from the chain."}
            </p>
          </div>
          <div className="live-label">
            <i className={connected ? "dot" : "dot muted"} />
            {connected ? "WALLET-SIGNED OPERATIONS" : "BROWSER DISCONNECTED"}
          </div>
        </div>
        <form className="locator" onSubmit={openAssembly}>
          <label className="id-input">
            <span>ASSEMBLY ID</span>
            <input
              aria-label="Assembly ID"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Game item ID or 0x object ID"
              spellCheck={false}
              disabled={!!busy}
              required
            />
          </label>
          <label className="tenant-input">
            <span>TENANT</span>
            <input
              aria-label="Tenant"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              disabled={!!busy}
              required
            />
          </label>
          <button
            className="primary"
            disabled={!!busy || !configured || !canReachNetwork}
          >
            Load assembly <span>↗</span>
          </button>
        </form>
        {(initial.error || error) && (
          <div className="banner error" role="alert">
            <b>{initial.error ? "Configuration error" : "Attention"}</b>
            <span>{initial.error || error}</span>
            {!initial.error && (
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            )}
          </div>
        )}
        {walletRetrying && (
          <div className="banner" role="status">
            Waiting for EVE Vault to finish starting. Connecting automatically…
          </div>
        )}
        {walletError && (
          <div className="banner error" role="alert">
            <b>Wallet connection</b>
            <span>{walletError} Use Connect wallet to retry.</span>
          </div>
        )}
        {notice && (
          <div className="banner success" role="status">
            {notice}
          </div>
        )}
        {recoveryError && (
          <div className="banner error" role="alert">
            {recoveryError}
          </div>
        )}
        {adminRecovery && (
          <div className="banner" role="status">
            <span>
              An admin transaction needs confirmation. Check this operation
              before starting another state change.
              <br />
              Transaction <code>{adminRecovery.digest}</code>
            </span>
            <button
              disabled={!!busy || !wallet}
              onClick={() => void recoverAdmin()}
            >
              Check transaction
            </button>
          </div>
        )}
        {!connected && (
          <div className="banner">
            {config.network === "localnet"
              ? "Internet is disconnected. Localnet operations remain available while your local Sui node is running."
              : "Reconnect to read current state and submit a transaction."}
          </div>
        )}
        <TaskQueuePanel
          queue={taskQueue}
          assembly={assembly}
          onQueueTask={enqueueTask}
          disabled={
            !configured || !wallet || !!busy || !!review || !canReachNetwork
          }
          progress={queueProgress}
          onRun={() => void runTaskQueue()}
          onRepeat={() => {
            if (taskQueue.repeatCompleted()) void runTaskQueue();
          }}
          onExport={exportTaskQueue}
          onImport={importTaskQueue}
        />
        <div className="workspace">
          <section className="assembly-card panel">
            <div className="panel-top">
              <span>SELECTED ASSEMBLY</span>
              <span className={`state ${status}`}>
                {stale
                  ? "STALE"
                  : status === "unknown"
                    ? "NOT LOADED"
                    : status.toUpperCase()}
              </span>
            </div>
            <AssemblyGraphic state={status} />
            <div className="assembly-name">
              <span className="eyebrow">
                {assembly ? labels[assembly.kind] : "SMART INFRASTRUCTURE"}
              </span>
              <h2>{assembly?.name || "Awaiting assembly"}</h2>
              <p>
                {assembly
                  ? `Item ${assembly.itemId || "—"} · ${assembly.tenant || tenant}`
                  : "Load an assembly to inspect its state."}
              </p>
            </div>
            <dl className="identity">
              <div>
                <dt>Object ID</dt>
                <dd title={assembly?.id}>{short(assembly?.id)}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd title={assembly?.ownerAddress}>
                  {assembly?.ownerName || short(assembly?.ownerAddress)}
                </dd>
              </div>
              <div>
                <dt>Last observed</dt>
                <dd>
                  {assembly
                    ? new Date(assembly.observedAt).toLocaleTimeString()
                    : "—"}
                </dd>
              </div>
            </dl>
            <button
              className="refresh-button"
              onClick={() => assembly && void refresh(assembly.id)}
              disabled={!configured || !assembly || !!busy || !canReachNetwork}
            >
              ↻ Refresh chain state
            </button>
          </section>
          <div className="right-column">
            <nav className="tabs" aria-label="Assembly views">
              {(
                [
                  ["overview", "Overview"],
                  ["behaviour", "Behaviour"],
                  ["storage", "Storage"],
                  ["industry", "Industry"],
                  ["gate", "Gate"],
                  ["network", "Network"],
                  ["scanning", "Scanning"],
                  ["scanResults", "Results"],
                  ["activity", "Activity"],
                ] as const
              ).map(([key, text]) => (
                <button
                  key={key}
                  aria-current={tab === key ? "page" : undefined}
                  className={tab === key ? "active" : ""}
                  disabled={!!busy}
                  onClick={() => changeView(key)}
                >
                  {text}
                  {key === "activity" && activity.length > 0 && (
                    <small>{activity.length}</small>
                  )}
                </button>
              ))}
              <span>ASSEMBLY CONSOLE</span>
            </nav>
            {tab === "overview" && (
              <section className="panel detail-panel">
                <div className="section-kicker">BASE CONFIGURATION</div>
                <h2>Assembly details.</h2>
                {assembly ? (
                  <>
                    <p className="chain-description">
                      {assembly.description ||
                        "No description has been set on chain."}
                    </p>
                    <dl className="chain-details">
                      <div>
                        <dt>Assembly type</dt>
                        <dd>{labels[assembly.kind]}</dd>
                      </div>
                      <div>
                        <dt>Game item ID</dt>
                        <dd>{assembly.itemId || "Unavailable"}</dd>
                      </div>
                      <div>
                        <dt>Tenant</dt>
                        <dd>{assembly.tenant || tenant}</dd>
                      </div>
                      <div>
                        <dt>Object ID</dt>
                        <dd>
                          <code>{assembly.id}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Owner</dt>
                        <dd>
                          {assembly.ownerName || "Unnamed character"}
                          <code>{assembly.ownerAddress}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>State</dt>
                        <dd>
                          {stale
                            ? "Stale — refresh to read current state"
                            : assembly.state}
                        </dd>
                      </div>
                      <div>
                        <dt>dApp URL</dt>
                        <dd>{assembly.url || "No custom dApp URL set"}</dd>
                      </div>
                      <div>
                        <dt>Network node</dt>
                        <dd>
                          {assembly.kind === "network_node"
                            ? "This assembly supplies the network"
                            : assembly.networkNodeId || "Not connected"}
                        </dd>
                      </div>
                    </dl>
                    {assembly.kind === "storage_unit" && (
                      <button
                        disabled={!!busy}
                        onClick={() => changeView("storage")}
                      >
                        Manage storage inventory ↗
                      </button>
                    )}
                    {assembly.kind === "gate" && (
                      <button
                        disabled={!!busy}
                        onClick={() => changeView("gate")}
                      >
                        Manage gate destination ↗
                      </button>
                    )}
                    <button
                      disabled={!!busy}
                      onClick={() => changeView("behaviour")}
                    >
                      View behaviour and controls ↗
                    </button>
                  </>
                ) : (
                  <div className="empty-content">
                    <span>◇</span>
                    <h3>{busy || "No assembly loaded"}</h3>
                    <p>
                      Open this view from a Smart Assembly or enter its ID
                      above.
                    </p>
                  </div>
                )}
              </section>
            )}
            {tab === "behaviour" && (
              <>
                {assembly?.kind === "gate" && (
                  <section className="panel behaviour-panel">
                    <div className="section-kicker">SMART GATE DESTINATION</div>
                    <h2>Connect two gates.</h2>
                    <p>
                      Choose another gate of the same type within the configured
                      range and sync its link with the blockchain.
                    </p>
                    <button
                      disabled={!!busy}
                      onClick={() => changeView("gate")}
                    >
                      Manage gate destination ↗
                    </button>
                  </section>
                )}
                {assembly?.kind === "storage_unit" && (
                  <section className="panel behaviour-panel">
                    <div className="section-kicker">STORAGE INVENTORY</div>
                    <h2>Add and remove items.</h2>
                    <p>
                      Manage your active ship's cargo and the deployed unit's
                      inventory in game and on chain.
                    </p>
                    <button
                      disabled={!!busy}
                      onClick={() => changeView("storage")}
                    >
                      Open storage controls ↗
                    </button>
                  </section>
                )}
                <section className="panel behaviour-panel">
                  <div className="section-kicker">ON-CHAIN BEHAVIOUR</div>
                  <h2>Configured extensions.</h2>
                  {!assembly ? (
                    <p>Load an assembly to inspect its behaviour.</p>
                  ) : assembly.extensionTypes === undefined ? (
                    <p>
                      {assembly.kind === "assembly" ||
                      assembly.kind === "network_node"
                        ? "This assembly type uses the world’s built-in behaviour."
                        : "Extension configuration is unavailable in this chain response."}
                    </p>
                  ) : assembly.extensionTypes.length ? (
                    <>
                      <p>
                        This assembly authorizes the following extension types:
                      </p>
                      <ul>
                        {assembly.extensionTypes.map((type) => (
                          <li key={type}>
                            <code>{type}</code>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p>
                      No custom extension is configured. This assembly uses the
                      world’s default behaviour.
                    </p>
                  )}
                </section>
                <section className="panel operation-panel">
                  <div className="section-kicker">01 / STATE MANAGEMENT</div>
                  <h2>Power your assembly.</h2>
                  <p>
                    Bring systems online when they’re ready. Take them offline
                    when you need to make a change.
                  </p>
                  <div className="actions-grid">
                    <div className="action-card">
                      <span className="power-icon">⏻</span>
                      <h3>Bring online</h3>
                      <p>
                        {assembly?.kind === "network_node"
                          ? "Activate the node and begin supplying energy to its network."
                          : "Activate the assembly using its connected network node."}
                      </p>
                      <button
                        className="primary"
                        disabled={
                          !assembly || actionDisabled || status !== "offline"
                        }
                        onClick={() => void prepare("online")}
                      >
                        Bring online <span>↗</span>
                      </button>
                      <button
                        disabled={!assembly || actionDisabled}
                        onClick={() => queueAssemblyState("online")}
                      >
                        Queue online
                      </button>
                    </div>
                    <div className="action-card">
                      <span className="power-icon muted">⏻</span>
                      <h3>Take offline</h3>
                      <p>
                        Deactivate the assembly and release its allocated
                        energy.
                      </p>
                      <button
                        disabled={
                          !assembly || actionDisabled || status !== "online"
                        }
                        onClick={() => void prepare("offline")}
                      >
                        Take offline <span>↘</span>
                      </button>
                      <button
                        disabled={!assembly || actionDisabled}
                        onClick={() => queueAssemblyState("offline")}
                      >
                        Queue offline
                      </button>
                    </div>
                  </div>
                  <div className="control-note">
                    <span>◇</span>
                    {busy ||
                      (!assembly
                        ? "Load an assembly to enable state controls."
                        : stale
                          ? "Refresh chain state before changing this assembly."
                          : !wallet
                            ? "Connect the owner’s wallet to manage this assembly."
                            : !isOwner
                              ? "Read-only access. Connect the owner’s wallet to change state."
                              : config.network === "localnet"
                                ? "Approve each state change in your wallet. The game server pays gas."
                                : "Every state change requires approval in your wallet.")}
                  </div>
                </section>
                <section className="panel connection-panel">
                  <div>
                    <div className="section-kicker">02 / ENERGY CONNECTION</div>
                    <h3>
                      {assembly?.kind === "network_node"
                        ? "Network source"
                        : "Connected network node"}
                    </h3>
                    <p>
                      {assembly?.kind === "network_node"
                        ? `${assembly.connectedAssemblies.length} connected assemblies`
                        : short(assembly?.networkNodeId)}
                    </p>
                  </div>
                  <span
                    className={`state ${assembly?.networkNodeState || "unknown"}`}
                  >
                    {assembly?.kind === "network_node"
                      ? "SOURCE"
                      : assembly?.networkNodeState?.toUpperCase() ||
                        "UNAVAILABLE"}
                  </span>
                </section>
              </>
            )}
            {assembly?.kind === "gate" && config.network === "localnet" && (
              <div hidden={tab !== "gate"}>
                <GatePanel
                  key={`${assembly.id}:${queueRevision}`}
                  assembly={assembly}
                  config={config}
                  wallet={wallet}
                  isOwner={isOwner}
                  visible={tab === "gate"}
                  disabled={!configured || !!busy || !canReachNetwork}
                  onBusyChange={setBusy}
                  onQueueTask={enqueueTask}
                />
              </div>
            )}
            {assembly?.kind === "assembly" && config.network === "localnet" && (
              <div hidden={tab !== "industry"}>
                <IndustryPanel
                  key={`${assembly.id}:${queueRevision}`}
                  assembly={assembly}
                  config={config}
                  wallet={wallet}
                  isOwner={isOwner}
                  visible={tab === "industry"}
                  disabled={!configured || !!busy || !canReachNetwork}
                  onBusyChange={setIndustryBusy}
                  onQueueTask={enqueueTask}
                  queuedTasks={queueState.tasks}
                  queuedTransfer={
                    [...queueState.tasks]
                      .reverse()
                      .find(
                        (task) =>
                          task.status === "completed" &&
                          task.assembly.id === assembly.id &&
                          task.walletIdentity === wallet &&
                          task.result?.industryTransfer,
                      )?.result?.industryTransfer
                  }
                />
              </div>
            )}
            {tab === "industry" &&
              !(
                assembly?.kind === "assembly" && config.network === "localnet"
              ) && (
                <section className="panel detail-panel">
                  <div className="section-kicker">SMART INDUSTRY</div>
                  <h2>Industry status.</h2>
                  <p>
                    {!assembly
                      ? "Load a deployed Industry facility to view its current production, blueprint, and inventory."
                      : config.network !== "localnet"
                        ? "Live Industry status requires the game's localnet deployment."
                        : "This assembly is not an Industry facility. Load a deployed Industry facility to monitor production."}
                  </p>
                </section>
              )}
            {tab === "gate" &&
              !(assembly?.kind === "gate" && config.network === "localnet") && (
                <section className="panel detail-panel">
                  <div className="section-kicker">SMART GATE</div>
                  <h2>Gate destination.</h2>
                  <p>
                    {assembly?.kind === "gate"
                      ? "Gate linking controls require the game's localnet deployment."
                      : assembly
                        ? "This assembly is not a Smart Gate. Open a deployed gate to manage its destination."
                        : "Load a deployed Smart Gate to view compatible destinations and blockchain synchronization."}
                  </p>
                </section>
              )}
            {assembly?.kind === "storage_unit" && (
              <div hidden={tab !== "storage"}>
                <StoragePanel
                  key={`${assembly.id}:${queueRevision}`}
                  assembly={assembly}
                  config={config}
                  wallet={wallet}
                  disabled={!configured || !!busy || !canReachNetwork}
                  onBusyChange={setBusy}
                  onQueueTask={enqueueTask}
                  onActivity={(item) =>
                    setActivity((items) => [item, ...items])
                  }
                />
              </div>
            )}
            {tab === "storage" && assembly?.kind !== "storage_unit" && (
              <section className="panel detail-panel">
                <div className="section-kicker">SMART STORAGE UNIT</div>
                <h2>Storage inventory.</h2>
                <p>
                  {assembly
                    ? "This assembly is not a Smart Storage Unit. Open a deployed storage unit to manage its contents."
                    : "Load a deployed Smart Storage Unit to view cargo and transfer items."}
                </p>
              </section>
            )}
            {assembly?.kind === "network_node" &&
              config.network === "localnet" && (
                <div hidden={tab !== "network"}>
                  <EnergyGridPanel
                    key={`${assembly.id}:${queueRevision}`}
                    assembly={assembly}
                    config={config}
                    wallet={wallet}
                    isOwner={isOwner}
                    visible={tab === "network"}
                    disabled={!configured || !!busy || !canReachNetwork}
                    onBusyChange={setBusy}
                    onQueueTask={enqueueTask}
                  />
                </div>
              )}
            {tab === "network" &&
              !(
                assembly?.kind === "network_node" &&
                config.network === "localnet"
              ) && (
                <section className="panel detail-panel">
                  <div className="section-kicker">NETWORK TOPOLOGY</div>
                  <h2>Connected infrastructure.</h2>
                  <p>
                    Taking a network node offline also takes its connected
                    assemblies offline in the same transaction.
                  </p>
                  {assembly?.kind === "network_node" ? (
                    <>
                      <div className="connection-count">
                        {assembly.connectedAssemblies.length}
                        <span>CONNECTED ASSEMBLIES</span>
                      </div>
                      {assembly.connectedAssemblies.length ? (
                        <ul className="connection-list">
                          {assembly.connectedAssemblies.map((a) => (
                            <li key={a.id}>
                              <div>
                                <b>{a.name || labels[a.kind]}</b>
                                <code title={a.id}>{short(a.id)}</code>
                              </div>
                              <span className={`state ${a.state}`}>
                                {a.state.toUpperCase()}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>No assemblies are connected to this node.</p>
                      )}
                    </>
                  ) : (
                    <div className="empty-content">
                      <span>◇</span>
                      <h3>
                        {assembly?.networkNodeId
                          ? short(assembly.networkNodeId)
                          : "No network node selected"}
                      </h3>
                      <p>
                        {assembly?.networkNodeId
                          ? "Load this network node to inspect its connected assemblies."
                          : "Load a network node to see its connections."}
                      </p>
                      {assembly?.networkNodeId && (
                        <button
                          disabled={!!busy}
                          onClick={() => {
                            const params = assemblySelection(
                              window.location.search,
                              assembly.networkNodeId!,
                              tenant,
                            );
                            window.history.replaceState(
                              null,
                              "",
                              `${window.location.pathname}?${params}`,
                            );
                            setSelection(params);
                          }}
                        >
                          Inspect network node ↗
                        </button>
                      )}
                    </div>
                  )}
                </section>
              )}
            {assembly?.kind === "network_node" &&
              config.network === "localnet" && (
                <div hidden={tab !== "scanning" && tab !== "scanResults"}>
                  <RemoteScanningPanel
                    key={assembly.id}
                    assembly={assembly}
                    config={config}
                    wallet={wallet}
                    isOwner={isOwner}
                    visible={tab === "scanning" || tab === "scanResults"}
                    view={tab === "scanResults" ? "results" : "scanner"}
                    onOpenResults={() => changeView("scanResults")}
                    onOpenScanner={() => changeView("scanning")}
                    disabled={!configured || !!busy || !canReachNetwork}
                    onBusyChange={setBusy}
                  />
                </div>
              )}
            {(tab === "scanning" || tab === "scanResults") &&
              !(
                assembly?.kind === "network_node" &&
                config.network === "localnet"
              ) && (
                <section className="panel detail-panel">
                  <div className="section-kicker">REMOTE SIGNATURE ARRAY</div>
                  <h2>Solar-system scanning.</h2>
                  <p>
                    {!assembly
                      ? "Load a deployed Network Node to scan reachable solar systems."
                      : config.network !== "localnet"
                        ? "Remote system scanning requires the game's localnet server package."
                        : "This assembly is not a Network Node. Open a deployed Network Node to access its scanner."}
                  </p>
                </section>
              )}
            {tab === "activity" && (
              <section className="panel detail-panel">
                <div className="section-kicker">THIS SESSION</div>
                <h2>Transaction activity.</h2>
                <p>
                  Confirmed operations and submitted transactions appear here.
                </p>
                {activity.length ? (
                  <ul className="activity-list">
                    {activity.map((item, index) => (
                      <li key={`${item.digest}-${index}`}>
                        <span className={item.failed ? "muted" : "positive"}>
                          {item.failed ? "◇" : "✓"}
                        </span>
                        <div>
                          <b>{item.title}</b>
                          <time>{item.time}</time>
                          <code>{item.digest}</code>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="empty-content">
                    <span>↗</span>
                    <h3>No transactions yet</h3>
                    <p>
                      Your assembly operations will appear here after signing.
                    </p>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
        <details className="configuration" open={!configured}>
          <summary>
            <span>World connection</span>
            <span>
              {configured ? `${config.network} / CONFIGURED` : "SETUP REQUIRED"}{" "}
              <b>+</b>
            </span>
          </summary>
          <div className="configuration-body">
            <p>
              Local hosting reads the current deployment when this page loads.
              After <code>efctl env up</code>, reload the page. Run{" "}
              <code>pnpm configure:local</code> to select a deployment source.
              For a static host or another world, edit <code>.env.local</code>{" "}
              and rebuild.
            </p>
            <dl>
              <div>
                <dt>RPC endpoint</dt>
                <dd>{config.rpcUrl}</dd>
              </div>
              <div>
                <dt>World package</dt>
                <dd>{config.packageId || "Not configured"}</dd>
              </div>
              <div>
                <dt>Object registry</dt>
                <dd>{config.objectRegistryId || "Not configured"}</dd>
              </div>
              {FEATURE_PACKAGES.map((name) => (
                <div key={name}>
                  <dt>{featureLabels[name]}</dt>
                  <dd>
                    package {config.features?.[name].packageId || "not configured"}
                    <br />
                    registry {config.features?.[name].registryId || "not configured"}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="muted">
              Assemblies must exist in this Sui world. EveJS-only assembly
              records use a separate local state system.
            </p>
          </div>
        </details>
        <footer>
          <span>
            BUILDER SCAFFOLD <b>/</b> ASSEMBLY CONTROL
          </span>
          <span>
            SUI NETWORK <b>·</b> {config.network.toUpperCase()}
          </span>
        </footer>
      </main>
      {review && (
        <ConfirmDialog
          labelledBy="review-title"
          busy={!!busy}
          onDismiss={() => setReview(null)}
        >
          <div className="section-kicker">REVIEW OPERATION</div>
          <h2 id="review-title">
            {review.action === "online"
              ? "Bring assembly online?"
              : "Take assembly offline?"}
          </h2>
          <p>
            <b>{review.snapshot.name}</b> will change from{" "}
            {review.snapshot.state} to {review.action} on {config.network}.
          </p>
          {review.snapshot.kind === "network_node" &&
            review.action === "offline" && (
              <div className="banner">
                This also takes {review.snapshot.connectedAssemblies.length}{" "}
                connected assemblies offline.
                {review.snapshot.connectedAssemblies.length > 0 && (
                  <ul>
                    {review.snapshot.connectedAssemblies.map((a) => (
                      <li key={a.id}>
                        {a.name} ({short(a.id)})
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          <p className="muted">
            {config.network === "localnet"
              ? "The game server pays the network fee. Your wallet approves the state change. On first use, approve a separate connection signature for your active game character."
              : "Your wallet will show the transaction for approval. Network fees apply."}
          </p>
          <div className="modal-actions">
            <button disabled={!!busy} onClick={() => setReview(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={!configured || !!busy || !canReachNetwork}
              onClick={() => void execute()}
            >
              {busy ? "Confirming…" : "Continue to wallet ↗"}
            </button>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default App;
