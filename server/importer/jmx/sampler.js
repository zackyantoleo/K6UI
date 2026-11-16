// JMeter HTTP Request sampler → K6UI request (URL, query or body arguments),
// plus the HTTP Header Manager and HTTP Request Defaults it inherits.
import { argumentsOf, bool, items, jmxText, prop, str, titleOf } from "./props.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_PORT = { http: "80", https: "443" };

// HTTP Request Defaults (ConfigTestElement) uses the same keys as the sampler.
export function urlParts(el) {
  return {
    protocol: str(el, "HTTPSampler.protocol").trim(),
    domain: str(el, "HTTPSampler.domain").trim(),
    port: str(el, "HTTPSampler.port").trim(),
    path: str(el, "HTTPSampler.path").trim(),
  };
}

export function readHeaders(el, ctx) {
  return items(el, "HeaderManager.headers")
    .map((h) => ({
      key: str(h, "Header.name").trim(),
      value: jmxText(str(h, "Header.value"), ctx, el, `header "${str(h, "Header.name").trim()}"`),
    }))
    .filter((h) => h.key);
}

// Later headers replace earlier ones with the same name (case-insensitive).
export function mergeHeaders(base, extra) {
  const out = [...base];
  for (const h of extra) {
    const i = out.findIndex((x) => x.key.toLowerCase() === h.key.toLowerCase());
    if (i >= 0) out[i] = h;
    else out.push(h);
  }
  return out;
}

// {{x}} placeholders must survive URL-encoding.
const encode = (text) => text.split(/(\{\{\w+\}\})/).map((part, i) => (i % 2 ? part : encodeURIComponent(part))).join("");

function argumentPairs(args, sampler, ctx) {
  return args
    .map((arg) => {
      const rawName = str(arg, "Argument.name");
      const name = jmxText(rawName, ctx, sampler, "a parameter name");
      const value = jmxText(str(arg, "Argument.value"), ctx, sampler, `parameter "${rawName}"`);
      if (!name && !value) return "";
      const encoded = bool(arg, "HTTPArgument.always_encode");
      const [k, v] = encoded ? [encode(name), encode(value)] : [name, value];
      return !v && !bool(arg, "HTTPArgument.use_equals", true) ? k : `${k}=${v}`;
    })
    .filter(Boolean);
}

function buildUrl(sampler, defaults, ctx) {
  const own = urlParts(sampler);
  const part = (key) => own[key] || defaults[key] || "";
  const name = titleOf(sampler);
  let path = part("path");
  const domain = part("domain");

  let url;
  if (/^https?:\/\//i.test(path) || (!domain && path.startsWith("${"))) {
    url = path; // the path holds the whole URL
  } else if (!domain) {
    ctx.warn(sampler, `HTTP request "${name}" has no server name; check its URL.`);
    url = path;
  } else {
    const port = part("port");
    const protocol = (part("protocol") || (port === "443" ? "https" : "http")).toLowerCase();
    if (path && !path.startsWith("/")) path = `/${path}`;
    url = `${protocol}://${domain}${port && port !== DEFAULT_PORT[protocol] ? `:${port}` : ""}${path || "/"}`;
  }
  return jmxText(url, ctx, sampler, `the URL of "${name}"`);
}

// → { req, form } where form = the body is urlencoded parameters; null when skipped.
export function buildRequest(sampler, defaults, ctx, id) {
  const name = titleOf(sampler);
  const method = (str(sampler, "HTTPSampler.method").trim() || "GET").toUpperCase();
  if (!METHODS.has(method)) {
    ctx.warn(sampler, `HTTP request "${name}" was skipped: method ${method} is not supported.`);
    return null;
  }

  const req = {
    id, name: name.slice(0, 120), enabled: true, groupId: "", type: "http", method,
    url: buildUrl(sampler, defaults, ctx),
    headers: [], body: "", checkStatus: true, sleepAfter: "0",
    extractions: [], assertions: [], preScript: "", postScript: "", pre: null, post: null,
  };

  const args = argumentsOf(sampler, "HTTPsampler.Arguments");
  const files = items(prop(sampler, "HTTPsampler.Files"), "HTTPFileArgs.files");
  let form = false;
  if (files.length || bool(sampler, "HTTPSampler.DO_MULTIPART_POST")) {
    ctx.warn(sampler, `File uploads and multipart bodies are not supported; "${name}" was imported without its body.`);
  } else if (bool(sampler, "HTTPSampler.postBodyRaw")) {
    const text = args.map((arg) => str(arg, "Argument.value")).join("");
    if (BODY_METHODS.has(method)) req.body = jmxText(text, ctx, sampler, `the body of "${name}"`);
    else if (text.trim()) ctx.warn(sampler, `${method} requests in K6UI have no body; the body of "${name}" was ignored.`);
  } else if (args.length) {
    const pairs = argumentPairs(args, sampler, ctx);
    if (BODY_METHODS.has(method)) {
      req.body = pairs.join("&");
      form = pairs.length > 0;
    } else if (pairs.length) {
      req.url += (req.url.includes("?") ? "&" : "?") + pairs.join("&");
    }
  }

  if (bool(sampler, "HTTPSampler.image_parser")) {
    ctx.warn(sampler, `Downloading embedded resources is not supported; "${name}" only requests its own URL.`);
  }
  if (str(sampler, "HTTPSampler.connect_timeout").trim() || str(sampler, "HTTPSampler.response_timeout").trim()) {
    ctx.warn(sampler, `The timeouts of "${name}" are not supported and were ignored.`);
  }
  return { req, form };
}
