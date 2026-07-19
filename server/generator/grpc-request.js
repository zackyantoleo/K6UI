// Codegen for one gRPC unary call: connect (server reflection) + invoke +
// status check + extractions + optional request logging + close + sleep.
// The request card maps onto gRPC as: url = host:port, grpcMethod =
// "package.Service/Method", body = request message JSON, headers = metadata.
import { interpolate } from "./interpolate.js";
import { buildExtractionLines } from "./extract.js";

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

export function buildGrpcRequestCode(req, index, prefix, ctx, logRequests) {
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
  const msgVar = `msg_${prefix}_${index}`;
  const resVar = `res_${prefix}_${index}`;
  const lines = [];

  lines.push(`  // Request ${index + 1}: gRPC ${req.grpcMethod} @ ${req.url}`);
  lines.push(`  ${clientVar}.connect(${addrCode}, { ${connectOpts.join(", ")} });`);
  lines.push(`  const ${msgVar} = ${body ? `JSON.parse(${interpolate(body, ctx)})` : "{}"};`);
  if (logRequests) lines.push(`  const t_${prefix}_${index} = Date.now();`);
  lines.push(
    `  const ${resVar} = ${clientVar}.invoke(${methodCode}, ${msgVar}${
      metadataCode ? `, { metadata: { ${metadataCode} } }` : ""
    });`
  );
  if (logRequests) lines.push(`  const d_${prefix}_${index} = Date.now() - t_${prefix}_${index};`);

  if (req.checkStatus !== false) {
    const label = `grpc status OK: request ${index + 1}`;
    lines.push(`  check(${resVar}, { ${JSON.stringify(label)}: (r) => r && r.status === grpc.StatusOK });`);
  }

  const extractCode = buildExtractionLines(req.extractions, resVar, null, ctx && ctx.localVars, "grpc");
  if (extractCode) lines.push(extractCode);

  // Same {__r:1,...} JSON shape as HTTP requests → "Request Details" table.
  if (logRequests) {
    lines.push(
      `  try { console.log(JSON.stringify({__r:1,vu:__VU,it:__ITER,i:${index},m:"GRPC",url:String(${addrCode})+"/"+String(${methodCode}),s:${resVar}.status,d:d_${prefix}_${index},ok:${resVar}.status===grpc.StatusOK,rb:JSON.stringify(${resVar}.message||{}).slice(0,500)})); } catch(e) {}`
    );
  }

  lines.push(`  ${clientVar}.close();`);

  const sleepAfter = Number(req.sleepAfter);
  if (sleepAfter > 0) lines.push(`  sleep(${sleepAfter});`);

  return lines.join("\n");
}
