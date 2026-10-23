import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { serveGrpcObjects } from "./fixtures/grpc.mjs";

for (const format of ["text", "binary"]) {
  test(`browser gRPC fixture supports native ${format} protobuf transport`, async t => {
    const requested = [];
    const errors = [];
    const objectId = normalizeSuiAddress("0x10");
    const ownerId = normalizeSuiAddress("0x20");
    const server = http.createServer(async (req, res) => {
      try {
        if (await serveGrpcObjects(req, res, id => {
          requested.push(id);
          return {
            objectId: id, objectType: "0x2::example::Object", version: "3",
            digest: "11111111111111111111111111111111",
            owner: { kind: "ADDRESS", address: ownerId },
            json: { status: { "@variant": "ONLINE" }, quantity: "18446744073709551615" },
          };
        })) return;
        res.writeHead(404).end();
      } catch (error) {
        errors.push(error);
        res.writeHead(500).end(String(error));
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    const client = new SuiGrpcClient({
      network: "localnet", format, baseUrl: `http://127.0.0.1:${server.address().port}/rpc`,
    });
    const { object } = await client.getObject({ objectId, include: { json: true } });
    assert.deepEqual(errors, []);
    assert.deepEqual(requested, [objectId]);
    assert.equal(object.objectId, objectId);
    assert.deepEqual(object.owner, { $kind: "AddressOwner", AddressOwner: ownerId });
    assert.deepEqual(object.json, { status: { "@variant": "ONLINE" }, quantity: "18446744073709551615" });
  });
}
