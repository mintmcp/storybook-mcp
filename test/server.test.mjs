// Runs the MCP handler against a fake Storybook host serving fixture manifests.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createStorybookMcpHandler } from "@storybook/mcp";
import { loadConfig, parseAuthHeader } from "../dist/config.js";
import { createManifestProvider } from "../dist/manifests.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const COMPONENTS = fixture("components.json");
const DOCS = fixture("docs.json");

// Fake Storybook hosts, one per scenario, keyed by path prefix.
let host;
let base;
const leakedHeaders = [];
before(async () => {
  host = http.createServer((req, res) => {
    const [, scenario, ...rest] = req.url.split("/");
    const path = rest.join("/");
    const json = (body) => res.writeHead(200, { "content-type": "application/json" }).end(body);
    if (scenario === "public") {
      if (path === "manifests/components.json") return json(COMPONENTS);
      if (path === "manifests/docs.json") return json(DOCS);
    }
    if (scenario === "nodocs" && path === "manifests/components.json") return json(COMPONENTS);
    if (scenario === "private") {
      if (req.headers.authorization !== "Bearer s3cret") return res.writeHead(401).end();
      if (path === "manifests/components.json") return json(COMPONENTS);
      if (path === "manifests/docs.json") return json(DOCS);
    }
    if (scenario === "moved") {
      return res.writeHead(301, { location: `/public/${path}` }).end();
    }
    if (scenario === "offsite") {
      // Records whether the auth header followed a cross-origin redirect.
      return res.writeHead(302, { location: `http://localhost:${host.address().port}/leak/${path}` }).end();
    }
    if (scenario === "leak") {
      leakedHeaders.push(req.headers["x-sb-token"]);
      return json(COMPONENTS);
    }
    if (scenario === "loginpage") {
      return res.writeHead(200, { "content-type": "text/html" }).end("<html>Sign in</html>");
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => host.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${host.address().port}`;
});
after(() => host.close());

async function callTool(env, name, args = {}) {
  const handler = await createStorybookMcpHandler({ manifestProvider: createManifestProvider(loadConfig(env)) });
  const res = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? text;
  const msg = JSON.parse(data);
  return { isError: Boolean(msg.error || msg.result?.isError), text: msg.error?.message ?? msg.result.content.map((c) => c.text).join("\n") };
}

test("public Storybook: docs-list and docs-show", async () => {
  const env = { STORYBOOK_URL: `${base}/public/` };
  const list = await callTool(env, "docs-list");
  assert.equal(list.isError, false);
  assert.match(list.text, /Button \(example-button\)/);
  const show = await callTool(env, "docs-show", { id: "example-button" });
  assert.match(show.text, /label: string/);
  const story = await callTool(env, "docs-show-story", { storyId: "example-button--primary" });
  assert.equal(story.isError, false, story.text);
});

test("build-machine paths are scrubbed from manifests", async () => {
  const provider = createManifestProvider(loadConfig({ STORYBOOK_URL: `${base}/public` }));
  const body = await provider(undefined, "./manifests/components.json");
  assert.doesNotMatch(body, /definedInFile|\/build\/agent/);
});

test("Storybook without docs.json still lists components", async () => {
  const list = await callTool({ STORYBOOK_URL: `${base}/nodocs` }, "docs-list");
  assert.equal(list.isError, false, list.text);
  assert.match(list.text, /example-button/);
});

test("private Storybook: auth header required, sent when set", async () => {
  const denied = await callTool({ STORYBOOK_URL: `${base}/private` }, "docs-list");
  assert.equal(denied.isError, true);
  assert.match(denied.text, /STORYBOOK_AUTH_HEADER/);
  const ok = await callTool({ STORYBOOK_URL: `${base}/private`, STORYBOOK_AUTH_HEADER: "Authorization: Bearer s3cret" }, "docs-list");
  assert.equal(ok.isError, false, ok.text);
});

test("no manifest: explains the Storybook requirement", async () => {
  const res = await callTool({ STORYBOOK_URL: `${base}/old` }, "docs-list");
  assert.equal(res.isError, true);
  assert.match(res.text, /componentsManifest/);
});

test("same-origin redirects are followed", async () => {
  const list = await callTool({ STORYBOOK_URL: `${base}/moved` }, "docs-list");
  assert.equal(list.isError, false, list.text);
});

test("cross-origin redirect is refused and the auth header is not sent", async () => {
  const res = await callTool({ STORYBOOK_URL: `${base}/offsite`, STORYBOOK_AUTH_HEADER: "X-SB-Token: s3cret" }, "docs-list");
  assert.equal(res.isError, true);
  assert.match(res.text, /outside STORYBOOK_URL/);
  assert.deepEqual(leakedHeaders, []);
});

test("HTML instead of JSON: points at URL or auth", async () => {
  const res = await callTool({ STORYBOOK_URL: `${base}/loginpage` }, "docs-list");
  assert.equal(res.isError, true);
  assert.match(res.text, /did not return JSON/);
});

test("config parsing", () => {
  assert.throws(() => loadConfig({}), /STORYBOOK_URL is required/);
  assert.throws(() => loadConfig({ STORYBOOK_URL: "ftp://x" }), /http\(s\)/);
  assert.equal(loadConfig({ STORYBOOK_URL: "https://sb.example.com/ui/index.html?path=/docs/x" }).storybookUrl, "https://sb.example.com/ui");
  assert.deepEqual(parseAuthHeader("Bearer abc"), { Authorization: "Bearer abc" });
  assert.deepEqual(parseAuthHeader("CF-Access-Client-Id: a\\nCF-Access-Client-Secret: b"), {
    "CF-Access-Client-Id": "a",
    "CF-Access-Client-Secret": "b",
  });
  assert.deepEqual(parseAuthHeader(undefined), {});
});
