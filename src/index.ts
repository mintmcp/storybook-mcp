// Entry point: reads config and serves the Storybook docs MCP server on :8000/mcp.

import { loadConfig, type Config } from "./config.js";
import { MCP_PATH, startServer } from "./server.js";

const PORT = 8000; // hard-coded; MintMCP routes to 8000 regardless of $PORT
const SHUTDOWN_TIMEOUT_MS = 5_000;
const LOG = "[storybook-mcp]";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`${LOG} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const server = await startServer(config, PORT);
console.log(`${LOG} listening on 0.0.0.0:${PORT}${MCP_PATH}, manifests from ${config.storybookUrl}`);
if (Object.keys(config.headers).length) console.log(`${LOG} sending ${Object.keys(config.headers).join(", ")} on manifest fetches`);

// Log manifest problems at boot so misconfiguration shows up in the connector logs, but keep serving:
// the Storybook host may just be down for a moment.
server.manifestProvider(undefined, "manifests/components.json").then(
  () => console.log(`${LOG} components manifest reachable`),
  (err) => console.warn(`${LOG} warning: ${err instanceof Error ? err.message : String(err)}`),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    server.stop().then(() => process.exit(0));
  });
}
