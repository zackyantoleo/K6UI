// Titik masuk server: setup Express, serve frontend statis, dan mount API.
import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { apiRouter } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "..", "public")));
app.use("/api", apiRouter);

app.listen(PORT, () => {
  console.log(`K6UI berjalan di http://localhost:${PORT}`);
});
