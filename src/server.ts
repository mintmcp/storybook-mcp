// HTTP server: serves the official @storybook/mcp docs toolset over streamable HTTP at /mcp.

import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createStorybookMcpHandler } from "@storybook/mcp";
import type { Config } from "./config.js";
import { createManifestProvider } from "./manifests.js";

export const MCP_PATH = "/mcp";
const LOG = "[storybook-mcp]";

export interface RunningServer {
  /** Port actually bound (useful when started on port 0). */
  port: number;
  manifestProvider: ReturnType<typeof createManifestProvider>;
  /** Stops accepting requests and closes open connections, including SSE streams. */
  stop(): Promise<void>;
}

export async function startServer(config: Config, port: number, host = "0.0.0.0"): Promise<RunningServer> {
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
      const response = await handler(toFetchRequest(req, port));
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => (headers[key] = value));
      res.writeHead(response.status, headers);
      if (!response.body) {
        res.end();
        return;
      }
      // Stream, so SSE responses flush as they are produced. A client disconnect ends the pipeline.
      await pipeline(Readable.fromWeb(response.body as WebReadableStream), res).catch(() => {});
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

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    port: boundPort,
    manifestProvider,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() waits for open connections; an SSE stream (GET /mcp) never ends on its own.
        server.closeAllConnections();
      }),
  };
}

function toFetchRequest(req: http.IncomingMessage, port: number): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://localhost:${port}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as BodyInit) : undefined,
    // Required by Node's fetch when the body is a stream.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}
