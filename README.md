# storybook-mcp

Hosted MCP server that gives coding agents your component library's documentation, read from a
**published Storybook**. It runs the official [`@storybook/mcp`](https://www.npmjs.com/package/@storybook/mcp)
docs toolset over streamable HTTP and loads the Storybook's component manifest from a URL, so it needs
no access to your source code.

Image: `mintmcp/storybook-mcp` (linux/amd64). Listens on `0.0.0.0:8000/mcp`.

## Tools

The docs toolset from `@storybook/mcp`:

- `docs-list`: all components and docs pages, with IDs
- `docs-show`: one component's description, stories with code, and props
- `docs-show-story`: one story's full code

Storybook's development and testing tools (story previews, changed stories, `test-run`) need a running
local dev server, so they aren't part of this image. Use `@storybook/addon-mcp` on the developer's machine
for those.

## Storybook requirements

The published Storybook must include a components manifest:

1. Storybook 10.x with a framework that supports the manifest (React frameworks, `@storybook/angular-vite`,
   `@storybook/vue3-vite` with the experimental docgen server).
2. In `.storybook/main.ts`:

   ```ts
   features: { componentsManifest: true },
   ```

3. `storybook build` and publish as usual. The build then contains `manifests/components.json`
   (and `manifests/docs.json` for MDX pages). Check with
   `curl <your-storybook-url>/manifests/components.json`.

## Configuration

| Env var | Required | Description |
|---|---|---|
| `STORYBOOK_URL` | Yes | Root URL of the published Storybook, e.g. `https://design.example.com`. A link to `index.html?path=...` or `iframe.html?id=...` also works. Must not contain a username or password; use `STORYBOOK_AUTH_HEADER` instead. |
| `STORYBOOK_AUTH_HEADER` | No | Header(s) sent when fetching manifests from a private Storybook. `Name: value`, several separated by newlines or a literal `\n`. A line with a scheme and credentials and no header name (`Bearer abc`, `Basic dXNlcjpwYXNz`) is sent as `Authorization`. Any other line stops the server at startup. |

The server ignores `$PORT` and the per-request `Authorization` header; all access to the Storybook uses
the settings above. Redirects are followed only within the Storybook's origin, so the auth header never goes
to another host. Absolute build-machine paths (`definedInFile`) are removed from manifests.

Manifests are cached for 60 seconds, and concurrent requests for the same file share one fetch. If the
Storybook host is down (network error, timeout, 5xx), the last good copy is served and the host is retried
after 30 seconds, so tool calls don't each wait on it. Other failures, such as a missing file, are also
remembered for 30 seconds.

## Run

```bash
docker run --rm -p 8000:8000 -e STORYBOOK_URL=https://design.example.com mintmcp/storybook-mcp:0.1.0
```

```bash
curl -s http://localhost:8000/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"docs-list","arguments":{}}}'
```

Health check: `GET /health` (or `/healthz`).

## Develop

```bash
npm ci
npm test        # builds, then runs the tests against a fake Storybook host (test/fixtures) and a stubbed fetch
STORYBOOK_URL=http://localhost:6006 npm start
```

Build the image (MintMCP hosts are amd64):

```bash
docker buildx build --platform linux/amd64 -t mintmcp/storybook-mcp:0.1.0 .
```
