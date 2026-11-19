import { createRequire } from 'node:module';
// Assemble the express app: JSON body parsing, the self-hosted web UI, then
// every /api route. Kept as a factory so index.ts can wrap it in an http.Server
// and attach the websocket bridge.
import express from "express";
import path from "node:path";
import { ROOT, WEB_DIR } from "../core/paths.js";
import { registerRoutes } from "./routes.js";
import { registerJunctionRoutes } from "../junction/routes.js";
import { permitsNodeRequest } from "./nodeguard.js";

export function createApp() {
  const app = express();
  app.use((req, res, next) => {
    if (!permitsNodeRequest(req)) { res.status(403).json({error:'Open this device through the cloud workspace.'}); return; }
    next();
  });
  app.use(express.json());
  // Highlight.js is pinned as an installed dependency and exposed locally only
  // under this narrow path. The browser loads the common bundle lazily, then a
  // known grammar on demand; code preview never depends on a public CDN.
  app.use("/vendor/highlight", express.static(path.dirname(createRequire(import.meta.url).resolve('@highlightjs/cdn-assets/package.json'))));
  app.use(express.static(WEB_DIR));
  registerRoutes(app);
  registerJunctionRoutes(app);
  return app;
}
