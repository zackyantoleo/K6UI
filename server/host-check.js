// K6UI runs load tests and sends requests from this machine, so by default it only
// listens on the loopback interface and only answers requests addressed to a local
// name. The Host check stops DNS rebinding: a web page that points its own domain
// at 127.0.0.1 still sends that domain as Host, and gets a 403.
//
// HOST=0.0.0.0 (or any address that is not loopback) is an explicit choice to share
// K6UI on the network: then the Host check is off, since other machines reach it
// by an address or name this process cannot know in advance.

const LOOPBACK_ADDRESS = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;

// True for a listen address that only this machine can reach.
export function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESS.test(String(address ?? ""));
}

// The name part of a Host header: "localhost:3000" → "localhost", "[::1]:3000" → "[::1]".
export function hostnameOf(hostHeader) {
  const value = String(hostHeader ?? "").trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  return value.split(":")[0];
}

// A Host header this machine itself sends: localhost, *.localhost, 127.x.x.x or [::1].
export function isLocalHostHeader(hostHeader) {
  const name = hostnameOf(hostHeader);
  return LOOPBACK_ADDRESS.test(name) || name.endsWith(".localhost");
}

export function localHostOnly(req, res, next) {
  if (isLocalHostHeader(req.headers.host)) return next();
  res.status(403).type("text/plain").send(
    "K6UI only answers on localhost. Open it as http://localhost:<port>, "
    + "or start it with HOST=0.0.0.0 to share it on your network on purpose.",
  );
}
