// Cache behaviour of the manifest provider, with a stubbed fetch and clock (no network).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import { createManifestProvider } from "../dist/manifests.js";

const BODY = '{"v":0,"components":{}}';
const realNow = Date.now;
let offset = 0;
beforeEach(() => {
  offset = 0;
  Date.now = () => realNow() + offset;
});
afterEach(() => {
  Date.now = realNow;
});

/** fetch stub whose behaviour is switched by `mode`; counts calls. */
function stub() {
  const s = {
    mode: "ok",
    calls: 0,
    fetch: async () => {
      s.calls++;
      if (s.mode === "ok") return new Response(BODY);
      if (s.mode === "down") throw new TypeError("fetch failed");
      if (s.mode === "5xx") return new Response("", { status: 503 });
      if (s.mode === "404") return new Response("", { status: 404 });
      if (s.mode === "slow") return new Promise((r) => setTimeout(() => r(new Response(BODY)), 50));
      throw new Error(`unknown mode ${s.mode}`);
    },
  };
  return s;
}

const provider = (s) => createManifestProvider(loadConfig({ STORYBOOK_URL: "https://sb.example.com" }), s.fetch);
const load = (p, path = "manifests/components.json") => p(undefined, path);

test("a fresh copy is reused within the TTL", async () => {
  const s = stub();
  const p = provider(s);
  await load(p);
  offset = 59_000;
  assert.equal(await load(p), BODY);
  assert.equal(s.calls, 1);
  offset = 61_000;
  await load(p);
  assert.equal(s.calls, 2);
});

for (const mode of ["down", "5xx"]) {
  test(`outage (${mode}): stale copy served, then reused without refetching for the back-off`, async () => {
    const s = stub();
    const p = provider(s);
    await load(p);
    s.mode = mode;
    offset = 61_000;
    assert.equal(await load(p), BODY);
    assert.equal(s.calls, 2);
    offset = 61_000 + 29_000;
    assert.equal(await load(p), BODY);
    assert.equal(s.calls, 2, "no fetch during the back-off");
    offset = 61_000 + 31_000;
    s.mode = "ok";
    await load(p);
    assert.equal(s.calls, 3, "fetches again after the back-off");
  });
}

test("a 4xx after a good copy is an error, not a stale copy", async () => {
  const s = stub();
  const p = provider(s);
  await load(p);
  s.mode = "404";
  offset = 61_000;
  await assert.rejects(load(p), /returned 404/);
});

test("failures are cached for the back-off (missing docs.json isn't refetched on every call)", async () => {
  const s = stub();
  s.mode = "404";
  const p = provider(s);
  await assert.rejects(load(p, "./manifests/docs.json"));
  await assert.rejects(load(p, "./manifests/docs.json"));
  assert.equal(s.calls, 1);
  offset = 31_000;
  await assert.rejects(load(p, "./manifests/docs.json"));
  assert.equal(s.calls, 2);
});

test("an outage with no cached copy is cached too, so calls don't each wait on the host", async () => {
  const s = stub();
  s.mode = "down";
  const p = provider(s);
  await assert.rejects(load(p), /Could not reach/);
  await assert.rejects(load(p), /Could not reach/);
  assert.equal(s.calls, 1);
});

test("concurrent loads share one fetch", async () => {
  const s = stub();
  s.mode = "slow";
  const p = provider(s);
  const results = await Promise.all([load(p), load(p), load(p)]);
  assert.deepEqual(results, [BODY, BODY, BODY]);
  assert.equal(s.calls, 1);
});

test("404 wording depends on which file is missing", async () => {
  const s = stub();
  s.mode = "404";
  const p = provider(s);
  await assert.rejects(load(p, "./manifests/components.json"), /no components manifest/);
  await assert.rejects(load(p, "./services/core/docgen/example-button.json"), /refers to this file but it isn't published/);
});
