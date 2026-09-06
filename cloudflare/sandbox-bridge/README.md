# Agent Díaz V2 — Cloudflare Sandbox bridge

This directory is the production execution plane for Agent Díaz V2.

## What this provides

The Cloudflare Sandbox container owns one real Linux filesystem namespace:

- `/workspace` — the canonical fast Linux workspace used by the agent, shell, browser automation, and local tools.
- `/workspace/persist` — an R2 bucket binding mounted into that same namespace for durable per-job files.

The custom container image also installs Chromium, Playwright MCP, Chrome DevTools MCP, the MCP filesystem server, and Puppeteer. They therefore operate inside the same Linux container and can read/write the same `/workspace` files instead of using a separate Render-host filesystem.

Every production Cloudflare session is rejected before model use unless the app can:

1. create, rename, read, and delete a file in `/workspace`;
2. mount the configured R2 binding at `/workspace/persist` and repeat the filesystem sentinel there; and
3. confirm the browser/MCP toolchain is present in the container.

CI additionally launches Chromium through Puppeteer, drives the filesystem MCP against `/workspace`, and drives Playwright MCP against an HTML file created in `/workspace`.

## Cloudflare prerequisites

Cloudflare Sandbox/Containers requires a Workers Paid account.

Create the R2 bucket configured in `wrangler.jsonc`:

```text
agent-diaz-v2-workspace
```

The Worker binding name is:

```text
AGENT_WORKSPACE
```

Install bridge dependencies from this directory, authenticate Wrangler, and create the bridge API secret:

```bash
npm install
npx wrangler secret put SANDBOX_API_KEY
```

Use a long random value for `SANDBOX_API_KEY`. Agent Díaz sends the same value as a Bearer token through `CLOUDFLARE_SANDBOX_API_KEY`.

Then deploy:

```bash
npm run deploy
```

Warm-pool target is intentionally `0` by default so deployment does not keep idle containers pre-warmed. Increase it later only if latency justifies the additional container usage.

## Agent Díaz application configuration

After the Worker is deployed, configure the Agent Díaz web service with:

```text
AGENT_RUNTIME=v2
AGENT_SANDBOX_PROVIDER=cloudflare
CLOUDFLARE_SANDBOX_WORKER_URL=https://<your-worker-host>
CLOUDFLARE_SANDBOX_API_KEY=<same SANDBOX_API_KEY secret>
CLOUDFLARE_SANDBOX_R2_BINDING=AGENT_WORKSPACE
```

`GET /readyz` must return HTTP 200 before starting artifact work. Static readiness proves the deployment variables are safe and complete. The first real sandbox session then performs the live Linux filesystem, R2 mount, and browser-toolchain preflight.

## MCP boundary

`MCP_SERVERS_JSON` remains available for external Streamable HTTP MCP services.

Do not configure Playwright/filesystem stdio MCP on the Render host and expect it to share the Cloudflare filesystem. Host-level stdio is a different machine and production rejects it by default. Browser/filesystem capabilities that must share `/workspace` are installed and exercised inside this Cloudflare sandbox image.

The current OpenAI Agents Cloudflare client does not expose sandbox port resolution to the app host, so this design does not fake a host-to-sandbox localhost connection. The canonical workspace/browser stack stays inside the sandbox boundary until that provider capability exists.

## Deployment acceptance

Repository CI must pass all of these before promotion:

- full Agent Díaz TypeScript/test/build/audit verification;
- Cloudflare bridge typecheck;
- Cloudflare sandbox image build;
- POSIX create/rename/read/delete check in `/workspace`;
- Chromium, Playwright MCP, Chrome DevTools MCP, filesystem MCP, and Puppeteer presence;
- real Puppeteer render/screenshot using a `/workspace` HTML file;
- real filesystem MCP read from `/workspace`;
- real Playwright MCP navigation to a `/workspace` HTML file;
- existing checkpoint-3, exact-prompt presentation, and production-container regression gates.

Passing repository CI proves the code and container image contract. A paid Cloudflare deployment is still required for the final live-provider proof of the bridge, R2 binding mount, and end-to-end Agent Díaz artifact loop.
