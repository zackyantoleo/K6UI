// Codegen for one gRPC unary call: connect (server reflection) + invoke +
// status check + extractions + optional request logging + close + sleep.
// The request card maps onto gRPC as: url = host:port, grpcMethod =
// "package.Service/Method", body = request message JSON, headers = metadata.
import { interpolate } from "./interpolate.js";
import { buildExtractionLines } from "./extract.js";
import { oneLine, responseVar } from "./helpers.js";

export function validateGrpcRequest(req, label) {
  const method = String(req.grpcMethod || "").trim();
  if (!method) {
    throw new Error(`${label}: enter the gRPC method as "package.Service/Method".`);
  }
  if (!method.includes("{{") && !/^[\w.-]+\/\w+$/.test(method)) {
    throw new Error(`${label}: the gRPC method must look like "package.Service/Method" (got "${method}").`);
  }
  if (/^https?:\/\//i.test(String(req.url || "").trim())) {
    throw new Error(`${label}: a gRPC address is "host:port" (e.g. localhost:50051), without http(s)://.`);
  }
  const body = String(req.body || "").trim();
  if (body && !body.includes("{{")) {
    try { JSON.parse(body); }
    catch (e) { throw new Error(`${label}: the gRPC request message must be valid JSON: ${e.message}`); }
  }
}

export function buildGrpcRequestCode(req, index, ctx, { logRequests = false } = {}) {
  const clientVar  = `grpc_client_${index}`;
  const addrCode   = interpolate(String(req.url || "").trim(), ctx);
  const methodCode = interpolate(String(req.grpcMethod || "").trim(), ctx);

  const headers = {};
  if (Array.isArray(req.headers)) {
    for (const h of req.headers) {
      if (h && h.key) headers[h.key] = String(h.value == null ? "" : h.value);
    }
  }
  const metadataCode = Object.entries(headers)
    .map(([k, v]) => `${JSON.stringify(k)}: ${interpolate(v, ctx)}`)
    .join(", ");

  const connectOpts = ["reflect: true"];
  if (req.grpcPlaintext) connectOpts.push("plaintext: true");

  const body = String(req.body == null ? "" : req.body).trim();
  const msgVar = `msg_main_${index}`;
  const resVar = responseVar(index);
  const lines = [];

  lines.push(`  // Request ${index + 1}: ${oneLine(`gRPC ${req.grpcMethod} @ ${req.url}`)}`);
  lines.push(`  ${clientVar}.connect(${addrCode}, { ${connectOpts.join(", ")} });`);
  lines.push(`  const ${msgVar} = ${body ? `JSON.parse(${interpolate(body, ctx)})` : "{}"};`);
  if (logRequests) lines.push(`  const t_main_${index} = Date.now();`);
  lines.push(
    `  const ${resVar} = ${clientVar}.invoke(${methodCode}, ${msgVar}${
      metadataCode ? `, { metadata: { ${metadataCode} } }` : ""
    });`
  );
  if (logRequests) lines.push(`  const d_main_${index} = Date.now() - t_main_${index};`);

  if (req.checkStatus !== false) {
    const label = `grpc status OK: request ${index + 1}`;
    lines.push(`  check(${resVar}, { ${JSON.stringify(label)}: (r) => r && r.status === grpc.StatusOK });`);
  }

  const extractCode = buildExtractionLines(req.extractions, resVar, { mode: "grpc", declared: ctx?.localVars, hoisted: ctx?.hoistedVars });
  if (extractCode) lines.push(extractCode);

  // Same {__r:1,...} JSON line as HTTP requests (logGrpcRequest() in generator/request-log.js).
  if (logRequests) {
    const metadataObject = metadataCode ? `{ ${metadataCode} }` : "{}";
    lines.push(
      `  try { logGrpcRequest(${index}, ${addrCode}, ${methodCode}, ${msgVar}, ${metadataObject}, ${resVar}, d_main_${index}); } catch (e) {}`
    );
  }

  lines.push(`  ${clientVar}.close();`);

  const sleepAfter = Number(req.sleepAfter);
  if (sleepAfter > 0) lines.push(`  sleep(${sleepAfter});`);

  return lines.join("\n");
}
