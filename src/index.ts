// HTTP entry: serves the official @storybook/mcp docs toolset over streamable HTTP on :8000/mcp.

import http from "node:http";
import { Readable } from "node:stream";
import { createStorybookMcpHandler } from "@storybook/mcp";
import { loadConfig, type Config } from "./config.js";
import { createManifestProvider } from "./manifests.js";

const PORT = 8000; // hard-coded; MintMCP routes to 8000 regardless of $PORT
const MCP_PATH = "/mcp";
const LOG = "[storybook-mcp]";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`${LOG} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const manifestProvider = createManifestProvider(config);
// Tools are registered once here; the handler is safe to share across requests.
const handler = await createStorybookMcpHandler({ manifestProvider });

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  if (path !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }

  try {
    const response = await handler(toFetchRequest(req));
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => (headers[key] = value));
    res.writeHead(response.status, headers);
    if (!response.body) {
      res.end();
      return;
    }
    // Stream, so SSE responses flush as they are produced.
    const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    res.on("close", () => body.destroy());
    body.pipe(res);
  } catch (err) {
    console.error(`${LOG} request error:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: err instanceof Error ? err.message : "Internal error" },
          id: null,
        }),
      );
    } else {
      res.end();
    }
  }
});

function toFetchRequest(req: http.IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://localhost:${PORT}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as BodyInit) : undefined,
    // Required by Node's fetch when the body is a stream.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`${LOG} listening on 0.0.0.0:${PORT}${MCP_PATH}, manifests from ${config.storybookUrl}`);
  if (Object.keys(config.headers).length) console.log(`${LOG} sending ${Object.keys(config.headers).join(", ")} on manifest fetches`);
});

// Log manifest problems at boot so misconfiguration shows up in the connector logs, but keep serving:
// the Storybook host may just be down for a moment.
manifestProvider(undefined, "manifests/components.json").then(
  () => console.log(`${LOG} components manifest reachable`),
  (err) => console.warn(`${LOG} warning: ${err instanceof Error ? err.message : String(err)}`),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
