// Server entry point: set up Express, serve the static frontend, mount the API.
import express from "express";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { apiGuard } from "./api-guard.js";
import { isLoopbackAddress, localHostOnly } from "./host-check.js";
import { apiRouter } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Loopback only unless HOST says otherwise (see host-check.js).
const DEFAULT_HOST = "127.0.0.1";

// A configuration can carry CSV data files (see generator/data.js): up to
// MAX_DATA_BYTES of text, which JSON escaping can roughly double. Only the two
// endpoints that take a configuration (and Send once, which carries one) get the
// larger limit; the import endpoints keep the default one.
const CONFIG_BODY_LIMIT = "24mb";
const DEFAULT_BODY_LIMIT = "1mb";

// `localOnly` (default true): answer only requests addressed to localhost.
export function createApp({ localOnly = true } = {}) {
  const app = express();
  if (localOnly) app.use(localHostOnly);
  // Only K6UI's own page may call the API (see api-guard.js); checked before a body is read.
  app.use("/api", apiGuard);
  app.use(["/api/generate", "/api/run", "/api/send-once"], express.json({ limit: CONFIG_BODY_LIMIT }));
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
  app.use(express.static(join(__dirname, "..", "public")));
  app.use("/api", apiRouter);
  // A body over its limit would otherwise get Express's HTML error page.
  app.use("/api", (err, _req, res, next) => {
    if (err?.type !== "entity.too.large") return next(err);
    res.status(413).json({ error: `The request is too large (the limit is ${Math.round(err.limit / 1024 / 1024)} MB). Use smaller data files.` });
  });
  return app;
}

export function createServer({
  port = process.env.PORT || 3000,
  host = process.env.HOST || DEFAULT_HOST,
  onListening,
} = {}) {
  const localOnly = isLoopbackAddress(host);
  const app = createApp({ localOnly });
  const server = app.listen(port, host, () => {
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    console.log(`K6UI running at http://${localOnly ? "localhost" : host}:${boundPort}`);
    if (!localOnly) {
      console.warn(`Warning: K6UI listens on ${host}, so other machines can reach it. Anyone who can open it can run load tests and send requests from this machine.`);
    }
    onListening?.();
  });
  return server;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isEntryPoint = entryPath && fileURLToPath(import.meta.url) === entryPath;
if (isEntryPoint) createServer();
