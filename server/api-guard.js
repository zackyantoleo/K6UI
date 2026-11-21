// The API runs load tests and sends requests from this machine, so only K6UI's own
// page may call it. Any web page the user has open can make the browser send a request
// to http://localhost:3000; the Host check (host-check.js) cannot tell that one apart,
// since its Host is still localhost. Two rules, for every /api request:
//
//   - Where it comes from. Sec-Fetch-Site (sent by every current browser) must be
//     "same-origin", or "none" (typed in the address bar). Without it, an Origin header
//     must name the host the request is addressed to. A request with neither (curl, a
//     script, the tests) does not come from a web page. 403 otherwise.
//   - What a POST sends. JSON (application/json), or XML for /api/import-jmx. A page on
//     another site can only send those types after a CORS preflight, which K6UI never
//     answers, so even a browser without Sec-Fetch-Site cannot start a run. Without
//     this, a plain text/plain POST started k6 with an empty configuration. 415 otherwise.
//
// Both hold with HOST=0.0.0.0 too: another machine opens K6UI by its own address, and
// its page is then the same origin as the API it calls.

const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);
const XML_TYPES = ["application/xml", "text/xml"];

// The Origin header names the host the request is addressed to ("null" never does).
function sameHost(origin, hostHeader) {
  try {
    return new URL(origin).host === String(hostHeader ?? "").trim().toLowerCase();
  } catch {
    return false;
  }
}

// → the reason the request is refused, or null.
export function crossSiteProblem(headers) {
  const site = headers["sec-fetch-site"];
  if (site !== undefined) {
    return ALLOWED_FETCH_SITES.has(String(site).toLowerCase()) ? null : `Sec-Fetch-Site is "${site}".`;
  }
  const origin = headers.origin;
  if (origin === undefined || sameHost(origin, headers.host)) return null;
  return `Origin is "${origin}".`;
}

export function apiGuard(req, res, next) {
  const problem = crossSiteProblem(req.headers);
  if (problem) {
    res.status(403).json({ error: `K6UI's API only answers K6UI's own page (${problem}) Open K6UI itself to run tests.` });
    return;
  }
  if (req.method === "POST") {
    const xml = req.path === "/import-jmx";
    if (!req.is(xml ? XML_TYPES : "application/json")) {
      res.status(415).json({ error: xml ? "Send the .jmx as XML (Content-Type: application/xml)." : "Send JSON (Content-Type: application/json)." });
      return;
    }
  }
  next();
}
