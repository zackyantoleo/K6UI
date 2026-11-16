// k6 http.* calls → K6UI request objects (method, URL, headers, body).
import {
  Unresolvable, keyOf, resolveConst, safeText, sourceOf, tryStatic, unwrap,
} from "./values.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// body / params = argument index (null = the call has no such argument).
const HTTP_CALLS = {
  get:     { method: "GET",     body: null, params: 1 },
  head:    { method: "HEAD",    body: null, params: 1 },
  post:    { method: "POST",    body: 1,    params: 2 },
  put:     { method: "PUT",     body: 1,    params: 2 },
  patch:   { method: "PATCH",   body: 1,    params: 2 },
  del:     { method: "DELETE",  body: 1,    params: 2 },
  delete:  { method: "DELETE",  body: 1,    params: 2 },
  options: { method: "OPTIONS", body: 1,    params: 2 },
  request: { method: null,      body: 2,    params: 3 },
};

// Returns the call's argument nodes when `node` is `http.<verb>(...)`, else null.
export function httpCallInfo(rawNode, ctx) {
  const node = unwrap(rawNode);
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed
      || callee.object.type !== "Identifier" || callee.object.name !== ctx.names.http) {
    return null;
  }
  const verb = callee.property.name;
  if (!Object.hasOwn(HTTP_CALLS, verb)) return null;
  const spec = HTTP_CALLS[verb];
  const args = node.arguments;
  const verbArgs = spec.method ? 0 : 1; // http.request(method, url, ...) shifts everything by one
  return {
    method: spec.method,
    methodNode: spec.method ? null : args[0],
    url: args[verbArgs],
    body: spec.body == null ? undefined : args[spec.body],
    params: args[spec.params],
  };
}

const isNullish = (node) =>
  !node || (node.type === "Literal" && node.value === null)
  || (node.type === "Identifier" && node.name === "undefined");

function readHeaders(node, ctx) {
  const obj = resolveConst(node, ctx);
  if (obj?.type !== "ObjectExpression") {
    ctx.warn(node, `Headers \`${sourceOf(node, ctx)}\` could not be read and were ignored.`);
    return [];
  }
  const headers = [];
  for (const prop of obj.properties) {
    if (prop.type !== "Property" || prop.kind !== "init") {
      ctx.warn(prop, "A spread in the headers object was skipped.");
      continue;
    }
    let key;
    try {
      key = String(keyOf(prop.key, prop.computed, ctx));
    } catch (e) {
      if (!(e instanceof Unresolvable)) throw e;
      ctx.warn(prop, `Header name \`${sourceOf(prop.key, ctx)}\` is not a plain string; header skipped.`);
      continue;
    }
    headers.push({ key, value: safeText(prop.value, ctx, `header "${key}"`) });
  }
  return headers;
}

function readTagName(node, ctx) {
  const obj = resolveConst(node, ctx);
  if (obj?.type !== "ObjectExpression") return "";
  for (const prop of obj.properties) {
    if (prop.type === "Property" && !prop.computed && (prop.key.name === "name" || prop.key.value === "name")) {
      const value = tryStatic(prop.value, ctx);
      return typeof value === "string" ? value.slice(0, 120) : "";
    }
  }
  return "";
}

function applyParams(node, req, ctx) {
  if (isNullish(node)) return;
  const obj = resolveConst(node, ctx);
  if (obj?.type !== "ObjectExpression") {
    ctx.warn(node, `Request options \`${sourceOf(node, ctx)}\` could not be read and were ignored.`);
    return;
  }
  for (const prop of obj.properties) {
    if (prop.type !== "Property") {
      ctx.warn(prop, "A spread in the request options was skipped.");
      continue;
    }
    const key = prop.computed ? null : (prop.key.name ?? prop.key.value);
    if (key === "headers") req.headers.push(...readHeaders(prop.value, ctx));
    else if (key === "tags") req.name = readTagName(prop.value, ctx) || req.name;
    else ctx.warn(prop, `Request option "${key ?? sourceOf(prop.key, ctx)}" is not supported and was ignored.`);
  }
}

// {{x}} placeholders must survive URL-encoding.
function encodeForm(text) {
  return text.split(/(\{\{\w+\}\})/).map((part, i) => (i % 2 ? part : encodeURIComponent(part))).join("");
}

// JS value tree for JSON.stringify(): variables stay {{placeholders}}, other
// plain values keep their JSON type.
function jsonTree(rawNode, ctx) {
  const node = resolveConst(rawNode, ctx);
  switch (node.type) {
    case "ObjectExpression": {
      const out = {};
      for (const prop of node.properties) {
        if (prop.type !== "Property" || prop.kind !== "init") {
          ctx.warn(prop, "A spread in the JSON body was skipped.");
          continue;
        }
        out[String(keyOf(prop.key, prop.computed, ctx))] = jsonTree(prop.value, ctx);
      }
      return out;
    }
    case "ArrayExpression":
      return node.elements.map((el) => (el && el.type !== "SpreadElement" ? jsonTree(el, ctx) : null));
    case "Literal":
      if (!node.regex) return node.value;
      break;
    case "Identifier":
    case "MemberExpression":
    case "UnaryExpression": {
      const value = tryStatic(node, ctx);
      if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
      break;
    }
    default:
  }
  return safeText(node, ctx, "JSON value");
}

function isJsonStringify(node) {
  const c = node.callee;
  return node.type === "CallExpression" && c.type === "MemberExpression" && !c.computed
    && c.object.type === "Identifier" && c.object.name === "JSON" && c.property.name === "stringify";
}

// → { text, form } where form = body came from a plain object (urlencoded by k6).
function readBody(rawNode, ctx) {
  const node = resolveConst(rawNode, ctx);
  if (isNullish(node)) return { text: "", form: false };

  if (isJsonStringify(node)) {
    if (!node.arguments[0]) return { text: "", form: false };
    return { text: JSON.stringify(jsonTree(node.arguments[0], ctx), null, 2), form: false };
  }
  if (node.type === "ObjectExpression") {
    const pairs = [];
    for (const prop of node.properties) {
      if (prop.type !== "Property" || prop.kind !== "init") {
        ctx.warn(prop, "A spread in the form body was skipped.");
        continue;
      }
      const key = String(keyOf(prop.key, prop.computed, ctx));
      pairs.push(`${encodeForm(key)}=${encodeForm(safeText(prop.value, ctx, `form field "${key}"`))}`);
    }
    return { text: pairs.join("&"), form: true };
  }
  return { text: safeText(node, ctx, "body"), form: false };
}

export function buildRequest(callNode, info, ctx, id) {
  let method = info.method;
  if (!method) {
    const value = info.methodNode ? tryStatic(info.methodNode, ctx) : undefined;
    method = typeof value === "string" ? value.toUpperCase() : "";
    if (!METHODS.has(method)) {
      ctx.warn(callNode, `Request skipped: HTTP method \`${info.methodNode ? sourceOf(info.methodNode, ctx) : "?"}\` is not supported.`);
      return null;
    }
  }
  if (!info.url) {
    ctx.warn(callNode, "Request skipped: no URL argument.");
    return null;
  }

  const req = {
    id, name: "", enabled: true, groupId: "", type: "http", method,
    url: safeText(info.url, ctx, "URL"),
    headers: [], body: "", checkStatus: false, sleepAfter: "0",
    extractions: [], assertions: [], preScript: "", postScript: "", pre: null, post: null,
  };
  applyParams(info.params, req, ctx);

  if (!isNullish(info.body)) {
    if (BODY_METHODS.has(method)) {
      const { text, form } = readBody(info.body, ctx);
      req.body = text;
      if (form && !req.headers.some((h) => h.key.toLowerCase() === "content-type")) {
        req.headers.push({ key: "Content-Type", value: "application/x-www-form-urlencoded" });
      }
    } else {
      ctx.warn(callNode, `${method} requests in K6UI have no body; the body argument was ignored.`);
    }
  }
  return req;
}
