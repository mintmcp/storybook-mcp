// The node:http bridge in src/server.ts: routing, a real MCP call over HTTP, SSE streaming, and shutdown.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { loadConfig } from "../dist/config.js";
import { startServer } from "../dist/server.js";

const COMPONENTS = readFileSync(new URL("./fixtures/components.json", import.meta.url), "utf8");

let storybook;
let server;
let base;
before(async () => {
  storybook = http.createServer((req, res) => {
    if (req.url === "/manifests/components.json") return res.writeHead(200).end(COMPONENTS);
    res.writeHead(404).end();
  });
  await new Promise((r) => storybook.listen(0, "127.0.0.1", r));
  const config = loadConfig({ STORYBOOK_URL: `http://127.0.0.1:${storybook.address().port}` });
  server = await startServer(config, 0, "127.0.0.1");
  base = `http://127.0.0.1:${server.port}`;
});
after(async () => {
  await server?.stop();
  storybook.close();
});

test("/health and /healthz answer 200; other paths 404", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test("POST /mcp tools/call returns the tool result over SSE", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "docs-list", arguments: {} } }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /Button \(example-button\)/);
});

test("stop() ends open SSE streams instead of waiting for them", async () => {
  // A second server, so stopping it doesn't affect the other tests.
  const config = loadConfig({ STORYBOOK_URL: `http://127.0.0.1:${storybook.address().port}` });
  const s = await startServer(config, 0, "127.0.0.1");
  const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, { headers: { accept: "text/event-stream" } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();

  const started = Date.now();
  await s.stop();
  assert.ok(Date.now() - started < 1_000, `stop() took ${Date.now() - started} ms`);
  // The client sees the stream end (or error) instead of hanging.
  await reader.read().catch(() => ({ done: true }));
});
