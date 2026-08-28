// Server entry point: set up Express, serve the static frontend, mount the API.
import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { apiRouter } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(join(__dirname, "..", "public")));
  app.use("/api", apiRouter);
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

const entryPath = process.argv[1] ? join(process.cwd(), process.argv[1]) : '';
const isEntryPoint = entryPath && fileURLToPath(import.meta.url) === entryPath;
if (isEntryPoint) createServer();
