import assert from "node:assert/strict";
import { GrpcTypes } from "@mysten/sui/grpc";

function frame(bytes, flag = 0) {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

/** Real protobuf and gRPC-web framing; the browser uses its production Sui client. */
export async function serveGrpcObjects(req, res, read) {
  if (!req.url.startsWith("/rpc/")) return false;
  assert.equal(req.url, "/rpc/sui.rpc.v2.LedgerService/BatchGetObjects");
  assert.equal(req.method, "POST");
  assert.match(req.headers["content-type"], /^application\/grpc-web/);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const textProtocol = req.headers["content-type"].includes("grpc-web-text");
  const raw = Buffer.concat(chunks);
  const body = textProtocol ? Buffer.from(raw.toString(), "base64") : raw;
  assert.equal(body[0], 0, "Expected an uncompressed gRPC request");
  assert.equal(body.readUInt32BE(1), body.length - 5);
  const request = GrpcTypes.BatchGetObjectsRequest.fromBinary(body.subarray(5));
  assert.ok(request.readMask.paths.includes("json"));
  const response = GrpcTypes.BatchGetObjectsResponse.fromJson({
    objects: request.requests.map(({ objectId }) => ({ object: read(objectId) })),
  });
  const responseBody = Buffer.concat([
    frame(GrpcTypes.BatchGetObjectsResponse.toBinary(response)),
    frame(Buffer.from("grpc-status: 0\r\n"), 0x80),
  ]);
  res.setHeader("Content-Type", textProtocol ? "application/grpc-web-text+proto" : "application/grpc-web+proto");
  res.end(textProtocol ? responseBody.toString("base64") : responseBody);
  return true;
}
