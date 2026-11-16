// Server entry point: set up Express, serve the static frontend, mount the API.
import express from "express";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { apiRouter } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// A configuration can carry CSV data files (see generator/data.js): up to
// MAX_DATA_BYTES of text, which JSON escaping can roughly double. Only the two
// endpoints that take a configuration get the larger limit; the import
// endpoints keep the default one.
const CONFIG_BODY_LIMIT = "24mb";
const DEFAULT_BODY_LIMIT = "1mb";

export function createApp() {
  const app = express();
  app.use(["/api/generate", "/api/run"], express.json({ limit: CONFIG_BODY_LIMIT }));
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
  host,
  onListening,
} = {}) {
  const app = createApp();
  const server = app.listen(port, host, () => {
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : port;
    console.log(`K6UI running at http://${host || "localhost"}:${boundPort}`);
    onListening?.();
  });
  return server;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isEntryPoint = entryPath && fileURLToPath(import.meta.url) === entryPath;
if (isEntryPoint) createServer();
