import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

// Opt in to an isolated headless browser; every wallet, RPC, and API call is a fixture.
for (const kind of ["assembly", "network_node"])
  test(
    `browser queues ${kind} without signing, preserves immediate recovery, and stops the queue after a lost response`,
    {
      skip: !process.env.DAPP_BROWSER_SMOKE,
      timeout: 90000,
    },
    async (t) => {
      const cleanup = [];
      t.after(async () => {
        const errors = [];
        for (const close of cleanup.reverse()) {
          try {
            await close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, "Browser test cleanup failed");
      });
      const { createServer } = await import("vite");
      const { default: react } = await import("@vitejs/plugin-react-swc");
      const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
      const cache = path.join(root, "node_modules/.cache");
      await mkdir(cache, { recursive: true });
      const profile = await mkdtemp(path.join(cache, "admin-browser-"));
      cleanup.push(async () => {
        const relative = path.relative(cache, path.resolve(profile));
        assert.ok(
          relative && !relative.startsWith("..") && !path.isAbsolute(relative),
        );
        await rm(profile, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      });
      const id = (value) => normalizeSuiAddress(`0x${value}`);
      const digest = "11111111111111111111111111111111";
      const config = {
        network: "localnet",
        rpcUrl: "",
        packageId: id("a"),
        objectRegistryId: id("b"),
        energyConfigId: id("c"),
        fuelConfigId: id("d"),
      };
      const assembly = {
        id: id("10"),
        itemId: "100",
        tenant: "dev",
        kind,
        name: "Browser test assembly",
        state: "offline",
        ownerAddress: id("99"),
        characterId: id("30"),
        ownerCapId: id("20"),
        ownerCapRef: { objectId: id("20"), version: "1", digest },
        networkNodeId: id("40"),
        networkNodeState: "online",
        connectedAssemblies: [],
        observedAt: new Date().toISOString(),
      };
      const type = `${config.packageId}::${kind}::${kind === "network_node" ? "NetworkNode" : "Assembly"}`;
      async function operation(action, sequence) {
        const tx = new Transaction();
        tx.setSender(assembly.ownerAddress);
        const shared = (objectId) =>
          tx.sharedObjectRef({
            objectId,
            initialSharedVersion: "1",
            mutable: objectId !== id("6"),
          });
        const [cap, receipt] = tx.moveCall({
          target: `${config.packageId}::character::borrow_owner_cap`,
          typeArguments: [type],
          arguments: [
            shared(assembly.characterId),
            tx.receivingRef(assembly.ownerCapRef),
          ],
        });
        if (kind === "network_node" && action === "offline") {
          const [remaining] = tx.moveCall({
            target: `${config.packageId}::network_node::offline`,
            arguments: [
              shared(assembly.id),
              shared(config.fuelConfigId),
              cap,
              shared(id("6")),
            ],
          });
          tx.moveCall({
            target: `${config.packageId}::network_node::destroy_offline_assemblies`,
            arguments: [remaining],
          });
        } else {
          tx.moveCall({
            target: `${config.packageId}::${kind}::${action}`,
            arguments:
              kind === "network_node"
                ? [shared(assembly.id), cap, shared(id("6"))]
                : [
                    shared(assembly.id),
                    shared(assembly.networkNodeId),
                    shared(config.energyConfigId),
                    cap,
                  ],
          });
        }
        tx.moveCall({
          target: `${config.packageId}::character::return_owner_cap`,
          typeArguments: [type],
          arguments: [shared(assembly.characterId), cap, receipt],
        });
        tx.setGasOwner(id("88"));
        tx.setGasBudget(100000000);
        tx.setGasPrice(1000);
        tx.setGasPayment([{ objectId: id("77"), version: "1", digest }]);
        const bytes = toBase64(await tx.build());
        const operationDigest = await tx.getDigest();
        const uuid = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
        return {
          prepared: {
            transactionUUID: uuid,
            transactionData: bytes,
            expiresAt: Date.now() + 120000,
            action,
            assemblyID: 100,
            assemblyObjectID: assembly.id,
            walletAddress: assembly.ownerAddress,
            sponsorAddress: id("88"),
            deployment: { ...config, chainId: "browser-test" },
          },
          result: {
            transactionUUID: uuid,
            action,
            assemblyID: 100,
            assemblyObjectID: assembly.id,
            digest: operationDigest,
            gameCommitted: true,
            replayed: true,
          },
        };
      }
      const operations = {
        online: await operation("online", 1),
        offline: await operation("offline", 2),
      };
      const bytes = operations.online.prepared.transactionData;
      const auth = new Transaction();
      auth.setSender(assembly.ownerAddress);
      auth.setGasOwner(assembly.ownerAddress);
      auth.setGasBudget(1);
      auth.setGasPrice(1);
      auth.setGasPayment([{ objectId: id("66"), version: "1", digest }]);
      const authData = await auth.toJSON();
      const session = {
        token: "test-token",
        walletAddress: assembly.ownerAddress,
        characterID: 200,
        expiresAt: Date.now() + 600000,
      };
      const submitted = [];
      const preparationRequests = [];
      let authChallenges = 0;
      let loseSubmission = 1;
      let online = false;
      const object = (
        objectId,
        type,
        fields,
        owner = { Shared: { initial_shared_version: "1" } },
      ) => ({
        data: {
          objectId,
          digest,
          version: "1",
          type,
          owner,
          content: {
            dataType: "moveObject",
            type,
            hasPublicTransfer: false,
            fields,
          },
        },
      });
      const read = (objectId) => {
        if (objectId === assembly.id)
          return object(objectId, type, {
            owner_cap_id: assembly.ownerCapId,
            key: { item_id: "100", tenant: "dev" },
            metadata: { name: assembly.name },
            status: { variant: online ? "ONLINE" : "OFFLINE" },
            energy_source_id: assembly.networkNodeId,
            ...(kind === "network_node" ? { connected_assembly_ids: [] } : {}),
          });
        if (objectId === assembly.ownerCapId)
          return object(
            objectId,
            `${config.packageId}::access::OwnerCap<${type}>`,
            { authorized_object_id: assembly.id },
            { AddressOwner: assembly.characterId },
          );
        if (objectId === assembly.characterId)
          return object(objectId, `${config.packageId}::character::Character`, {
            character_address: assembly.ownerAddress,
          });
        if (objectId === assembly.networkNodeId)
          return object(
            objectId,
            `${config.packageId}::network_node::NetworkNode`,
            { status: { variant: "ONLINE" } },
          );
        throw new Error(`Unexpected RPC object ${objectId}`);
      };
      // Vite still injects its WebSocket client with hmr:false. Give each
      // fixture its own loopback port so browser suites can run concurrently.
      const hmrServer = http.createServer();
      await new Promise((resolve) => hmrServer.listen(0, "127.0.0.1", resolve));
      cleanup.push(
        () =>
          new Promise((resolve) => {
            hmrServer.close(resolve);
            hmrServer.closeAllConnections();
          }),
      );
      const vite = await createServer({
        configFile: false,
        root,
        cacheDir: path.join(profile, "vite-cache"),
        envFile: false,
        logLevel: "error",
        plugins: [
          react(),
          {
            name: "isolated-wallet-fixture",
            resolveId(source) {
              if (source === "/test-wallet.ts") return "\0test-wallet";
            },
            load(source) {
              if (source === "\0test-wallet")
                return `
      import { Transaction } from '@mysten/sui/transactions';
      import { toBase64 } from '@mysten/sui/utils';
      window.testSignatures = 0;
      window.WALLET_API_CHAIN = 'sui:localnet';
      window.callWallet = async ({method,params}) => {
        if (method === 'connect') return {result:{accounts:[{suiAddress:${JSON.stringify(assembly.ownerAddress)},chains:['sui:localnet']}]}};
        if (method === 'signTransaction') { window.testSignatures++; return {result:{bytes:toBase64(await Transaction.from(params.transaction).build()),signature:'fixture-owner-signature'}}; }
        throw new Error('Unexpected wallet request '+method);
      };
      await import('/src/main.tsx');
    `;
            },
          },
        ],
        server: {
          middlewareMode: true,
          hmr: {
            server: hmrServer,
            host: "127.0.0.1",
            clientPort: hmrServer.address().port,
          },
        },
      });
      cleanup.push(() => vite.close());
      const server = http.createServer(async (req, res) => {
        const send = (data) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };
        try {
          if (req.url.startsWith("/client/behaviour")) {
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                '<!doctype html><div id="root"></div><script type="module" src="/test-wallet.ts"></script>',
              ),
            );
            return;
          }
          if (req.url === "/assembly-config.json")
            return send({
              VITE_SUI_NETWORK: "localnet",
              VITE_SUI_RPC_URL: config.rpcUrl,
              VITE_TENANT: "dev",
              VITE_EVE_WORLD_PACKAGE_ID: config.packageId,
              VITE_OBJECT_REGISTRY_ID: config.objectRegistryId,
              VITE_ENERGY_CONFIG_ID: config.energyConfigId,
              VITE_FUEL_CONFIG_ID: config.fuelConfigId,
            });
          if (req.url === "/rpc" || req.url.startsWith("/evejs/admin/")) {
            let raw = "";
            for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw);
            if (req.url === "/rpc") {
              assert.equal(body.method, "sui_getObject");
              return send({
                jsonrpc: "2.0",
                id: body.id,
                result: read(body.params[0]),
              });
            }
            if (req.url.endsWith("/auth/challenge")) {
              authChallenges++;
              return send({
                success: true,
                data: { challengeId: "challenge", transactionData: authData },
              });
            }
            if (req.url.endsWith("/auth/session"))
              return send({ success: true, data: session });
            if (req.url.endsWith("/prepare")) {
              assert.ok(
                operations[body.action],
                "The requested action has a fixture",
              );
              preparationRequests.push(body);
              return send({
                success: true,
                data: operations[body.action].prepared,
              });
            }
            if (req.url.endsWith("/execute")) {
              submitted.push(body);
              const operation = operations[body.action];
              assert.ok(operation, "The submitted action has a fixture");
              assert.equal(
                body.transactionUUID,
                operation.prepared.transactionUUID,
              );
              online = body.action === "online";
              // A proxy loses the committed result. HTTP 502 avoids Chromium's
              // transparent socket retry so the application's recovery UI is exercised.
              if (submitted.length === loseSubmission) {
                res.statusCode = 502;
                return send({
                  success: false,
                  errorMsg: "TRANSACTION_PENDING",
                  message: "The proxy lost the transaction response.",
                });
              }
              return send({ success: true, data: operation.result });
            }
            throw new Error(`Unexpected API ${req.url}`);
          }
          vite.middlewares(req, res);
        } catch (error) {
          res.statusCode = 500;
          send({ error: String(error) });
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanup.push(
        () =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      );
      const origin = `http://127.0.0.1:${server.address().port}`;
      config.rpcUrl = `${origin}/rpc`;
      const browser = spawn(
        process.env.DAPP_BROWSER_PATH ||
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--no-first-run",
          "--disable-extensions",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          "about:blank",
        ],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
      cleanup.push(async () => {
        if (browser.exitCode === null) {
          const closed = new Promise((resolve) =>
            browser.once("exit", resolve),
          );
          browser.kill();
          await closed;
        }
      });
      const endpoint = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error("Browser startup timeout")),
          15000,
        );
        browser.once("error", reject);
        browser.stderr.on("data", (chunk) => {
          output += chunk;
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
          if (match) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
      });
      const socket = new WebSocket(endpoint);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("DevTools connection timed out")),
          5000,
        );
        socket.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        socket.onerror = reject;
      });
      cleanup.push(async () => {
        socket.send(JSON.stringify({ id: ++next, method: "Browser.close" }));
        await new Promise((resolve) => setTimeout(resolve, 200));
        socket.close();
      });
      let next = 0;
      const pending = new Map();
      const errors = [];
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(String(data));
        if (message.id) {
          const call = pending.get(message.id);
          if (!call) return;
          pending.delete(message.id);
          message.error
            ? call.reject(new Error(JSON.stringify(message.error)))
            : call.resolve(message.result);
        } else if (message.method === "Runtime.exceptionThrown")
          errors.push(message.params.exceptionDetails);
      };
      const cdp = (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
          const id = ++next;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`DevTools ${method} timed out`));
          }, 5000);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          socket.send(
            JSON.stringify({
              id,
              method,
              params,
              ...(sessionId ? { sessionId } : {}),
            }),
          );
        });
      const { targetId } = await cdp("Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = await cdp("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await cdp("Runtime.enable", {}, sessionId);
      await cdp(
        "Emulation.setDeviceMetricsOverride",
        { width: 420, height: 700, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      const evaluate = async (expression) => {
        const result = await cdp(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        );
        if (result.exceptionDetails)
          throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      async function until(expression) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if (await evaluate(expression)) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          `Browser condition timed out: ${expression}\n${await evaluate("document.body.innerText")}`,
        );
      }
      const findButton = (label) =>
        `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)}))`;
      await cdp(
        "Page.navigate",
        {
          url: `${origin}/client/behaviour/?objectId=${assembly.id}&tenant=dev`,
        },
        sessionId,
      );
      await until(
        `${findButton("Bring online")} && !${findButton("Bring online")}.disabled`,
      );
      await evaluate(`${findButton("Queue offline")}.click()`);
      await evaluate(`${findButton("Queue online")}.click()`);
      await until(
        "document.querySelectorAll('[data-task-status=queued]').length === 2",
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.task-queue-list li b')].map(item => item.textContent)",
        ),
        ["Take assembly offline", "Bring assembly online"],
        "Tasks retain the requested FIFO order, including a future state change",
      );
      assert.equal(
        await evaluate("window.testSignatures"),
        0,
        "Staging tasks does not open the wallet",
      );
      assert.equal(
        authChallenges,
        0,
        "Staging tasks does not request authentication",
      );
      assert.equal(
        preparationRequests.length,
        0,
        "Staging tasks does not prepare expiring authorizations",
      );
      assert.equal(
        submitted.length,
        0,
        "Staging tasks does not mutate the assembly",
      );
      assert.equal(online, false);
      assert.equal(
        await evaluate("!!document.querySelector('[role=dialog]')"),
        false,
      );

      if (kind === "assembly" && process.env.DAPP_QUEUE_SCREENSHOT) {
        const screenshotPath = process.env.DAPP_QUEUE_SCREENSHOT;
        assert.ok(
          path.isAbsolute(screenshotPath),
          "Queue screenshot path must be absolute",
        );
        await cdp(
          "Emulation.setDeviceMetricsOverride",
          { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        await evaluate(
          "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
        );
        const { cssContentSize } = await cdp(
          "Page.getLayoutMetrics",
          {},
          sessionId,
        );
        const screenshot = await cdp(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y: 0,
              width: cssContentSize.width,
              height: cssContentSize.height,
              scale: 1,
            },
          },
          sessionId,
        );
        await mkdir(path.dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
        await cdp(
          "Emulation.setDeviceMetricsOverride",
          { width: 420, height: 700, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
      }

      // Immediate review and same-operation recovery remain available with staged tasks.
      await evaluate(`${findButton("Bring online")}.click()`);
      await until(
        "document.querySelector('[role=dialog]')?.textContent.includes('server pays')",
      );
      await evaluate(`${findButton("Continue to wallet")}.click()`);
      await until(
        `${findButton("Check transaction")} && !${findButton("Check transaction")}.disabled`,
      );
      assert.equal(await evaluate("window.testSignatures"), 2);
      assert.equal(
        await evaluate(`${findButton("Bring online")}.disabled`),
        true,
      );
      await evaluate(`${findButton("Check transaction")}.click()`);
      await until("document.body.innerText.includes('Transaction confirmed.')");
      assert.equal(
        await evaluate("window.testSignatures"),
        3,
        "recovery reconnects auth after a lost response, without signing another state change",
      );
      assert.equal(submitted.length, 2);
      assert.deepEqual(submitted[0], submitted[1]);
      assert.equal(submitted[0].bytes, bytes);

      // The queued offline intent was captured before the immediate online change.
      // Running must validate fresh state, submit it first, and stop on uncertainty.
      loseSubmission = submitted.length + 1;
      await until(
        `${findButton("Run queue")} && !${findButton("Run queue")}.disabled`,
      );
      const signaturesBeforeRun = await evaluate("window.testSignatures");
      await evaluate(`${findButton("Run queue")}.click()`);
      await until(
        "document.querySelectorAll('[data-task-status=failed]').length === 1 && document.querySelectorAll('[data-task-status=queued]').length === 1",
      );
      await until(
        `${findButton("Check transaction")} && !${findButton("Check transaction")}.disabled`,
      );
      assert.deepEqual(
        await evaluate(
          "[...document.querySelectorAll('.task-queue-list li')].map(item => ({ title: item.querySelector('b').textContent, status: item.dataset.taskStatus }))",
        ),
        [
          { title: "Take assembly offline", status: "failed" },
          { title: "Bring assembly online", status: "queued" },
        ],
      );
      assert.equal(
        await evaluate("window.testSignatures"),
        signaturesBeforeRun + 2,
      );
      assert.equal(
        submitted.length,
        3,
        "The uncertain queued operation is never retried automatically",
      );
      assert.deepEqual(
        preparationRequests.map((request) => request.action),
        ["online", "offline"],
      );
      assert.equal(submitted[2].action, "offline");
      assert.equal(
        submitted[2].bytes,
        operations.offline.prepared.transactionData,
      );
      assert.equal(
        online,
        false,
        "The queued offline task executed before the later online task",
      );
      assert.equal(await evaluate(`${findButton("Run queue")}.disabled`), true);
      const saved = await evaluate(
        "Object.keys(sessionStorage).filter(key => key.startsWith('admin-transaction:')).map(key => JSON.parse(sessionStorage.getItem(key)))",
      );
      assert.equal(saved.length, 1);
      assert.equal(
        saved[0].transactionUUID,
        operations.offline.prepared.transactionUUID,
      );
      assert.equal(saved[0].bytes, submitted[2].bytes);
      assert.equal(saved[0].assemblyObjectID, assembly.id);
      assert.equal(saved[0].action, "offline");
      assert.deepEqual(errors, []);
    },
  );
