# Agent Díaz V2 — 2026 Agentic Architecture

Upgrade branch: `upgrade/cloudflare-real-fs`

Rollback references remain intact. This branch is promoted to `main` only after the complete repository and Cloudflare-image verification gates pass.

## Goal

Agent Díaz V2 is an agentic artifact-production runtime with a real workspace and an iterative repair loop. It keeps working until the existing deterministic production validators accept a downloadable artifact.

The proven Agent Díaz renderers, PowerPoint/PDF/HTML export behavior, visual hardening, validators, persistence, and UI/API contracts are retained. V2 modernizes the orchestration and execution layer around them.

## Core runtime

- OpenAI Agents SDK `@openai/agents` 0.17.0
- OpenAI Agents extensions `@openai/agents-extensions` 0.17.0
- `SandboxAgent` execution harness
- real sandbox filesystem, shell, patching, file inspection, and context compaction
- hosted OpenAI web search and code interpreter tools
- external MCP support through Streamable HTTP, plus reviewed stdio for non-production/development use
- existing Agent Díaz renderer/validator exposed as `build_and_validate_artifact`
- explicit terminal `accept_validated_artifact` gate
- structured logs, tracing, cancellation, revision history, and restart-safe infrastructure retry state

## Artifact loop

1. The request and explicitly attached files are materialized into the sandbox `/workspace`.
2. The agent researches or computes when needed and develops a complete `ArtifactPlan`.
3. It calls `build_and_validate_artifact`.
4. The existing deterministic builder renders the actual PPTX/DOCX/ZIP artifact and runs the production validators.
5. A rejection returns the exact failure class/rule plus model-readable diagnostic evidence when available.
6. The agent revises content, layout, assets, or infrastructure strategy and rebuilds. There is no legacy two-repair/six-model-call ceiling controlling this loop.
7. Only a validated build receives a `buildId`.
8. The run succeeds only when `accept_validated_artifact` is called with a real validated `buildId` from that run.
9. The accepted artifact is promoted into the normal Agent Díaz artifact store. Presentations continue to expose PPTX, PDF, and browser-HTML downloads.

The model cannot finish merely by claiming an artifact is ready.

## Failure and recovery policy

- `PLAN_CONTENT`: repair missing/incorrect requirements or structure.
- `PLAN_NORMALIZABLE`: normalize without discarding valid user requirements.
- `ASSET`: improve queries or retry transient acquisition while preserving requested visual coverage.
- `BUILD`: use validator/diagnostic evidence to revise layout or content.
- `INFRA`: preserve good artifact work and retry the external dependency rather than degrading content.

Each attempt stores the complete plan plus append-only `REVISION_HISTORY.jsonl`. Recovery materializes `recovery/LATEST_PLAN.json` and `recovery/REVISION_HISTORY.jsonl` into a new sandbox after process restart. Repeated identical non-infrastructure failures increase `stagnationCount` and explicitly force a strategy change.

Transient provider/sandbox/MCP failures persist `INFRA_RETRY.json` and use capped exponential retry across process restarts. Permanent configuration failures do not loop forever. User cancellation is terminal.

## Canonical production filesystem

Cloudflare Sandbox is the production execution plane.

The important distinction is:

- R2 alone is object storage, not a POSIX filesystem.
- the Cloudflare Sandbox container supplies the real Linux filesystem;
- R2 is mounted into that Linux namespace for durable storage.

The canonical paths are:

```text
/workspace          real Linux sandbox filesystem
/workspace/inputs   explicitly attached user files
/workspace/persist  R2-backed durable mount
```

`/workspace` remains the fast working tree. The Worker R2 binding is mounted at `/workspace/persist` rather than over the workspace root, so durable storage does not hide the normal sandbox tree.

Every Cloudflare sandbox session is preflighted before the model can use it:

1. mount the configured R2 Worker binding at `/workspace/persist` using a per-job prefix;
2. prove create → rename → read → delete semantics in `/workspace`;
3. repeat that filesystem sentinel on `/workspace/persist`;
4. confirm Node, Chromium, Playwright MCP, Chrome DevTools MCP, filesystem MCP, and Puppeteer are installed in the same container.

A failure at any of those gates closes the session and becomes an infrastructure failure instead of silently falling back to a fake/host filesystem.

## Cloudflare production requirements

Production Cloudflare configuration fails closed unless all of these are present:

```text
AGENT_RUNTIME=v2
AGENT_SANDBOX_PROVIDER=cloudflare
CLOUDFLARE_SANDBOX_WORKER_URL=https://<agent-diaz-sandbox-bridge>
CLOUDFLARE_SANDBOX_API_KEY=<bridge bearer secret>
CLOUDFLARE_SANDBOX_R2_BINDING=AGENT_WORKSPACE
```

The repository includes `cloudflare/sandbox-bridge/`, which owns:

- the official `@cloudflare/sandbox` bridge Worker;
- Durable Object/Container bindings;
- the R2 binding `AGENT_WORKSPACE`;
- the custom sandbox image;
- Chromium and the browser/MCP toolchain;
- deployment and CI smoke tests.

The configured R2 bucket is `agent-diaz-v2-workspace`.

Cloudflare Sandbox/Containers requires Workers Paid. Warm-pool target is `0` by default so merely deploying the bridge does not intentionally maintain idle pre-warmed containers.

## Browser and MCP execution boundary

Browser tooling that must inspect or manipulate Agent Díaz workspace files lives inside the Cloudflare sandbox image:

- Chromium
- Playwright MCP
- Chrome DevTools MCP
- MCP filesystem server
- Puppeteer

That means these processes and the agent shell see the same `/workspace` namespace.

`MCP_SERVERS_JSON` remains available for external MCP systems, especially Streamable HTTP services. Its stdio mode runs on the Agent Díaz application host. That host is not the Cloudflare sandbox and therefore cannot be treated as sharing `/workspace`; production rejects host-level stdio MCP by default unless explicitly overridden.

The current OpenAI Agents 0.17 Cloudflare client does not implement exposed-port resolution from a sandbox back to the app host. V2 therefore does not fake a localhost connection from Render to a sandbox-local Playwright server. Browser/filesystem automation that depends on the canonical workspace stays inside the sandbox execution boundary. External MCP stays external.

This boundary can later be simplified if the provider adds supported sandbox port resolution; the artifact loop itself will not need a rewrite.

## Sandbox backend compatibility

Backend selection remains pluggable:

- `cloudflare`: required/recommended production isolation boundary
- `docker`: local isolated development/test backend
- `unix`: development fallback only; production refuses it unless the emergency `AGENT_SANDBOX_ALLOW_UNSAFE_UNIX=true` override is deliberately set

If `CLOUDFLARE_SANDBOX_WORKER_URL` is configured and no explicit provider is selected, V2 selects Cloudflare automatically.

## External MCP configuration

Example external server:

```json
[
  {
    "transport": "http",
    "name": "Research MCP",
    "url": "https://example.com/mcp",
    "authorizationEnv": "RESEARCH_MCP_AUTH",
    "allowedTools": ["search", "fetch"]
  }
]
```

Server names must be unique. Credentials may be referenced by environment-variable name instead of embedded in JSON. Per-server allow/block filters are supported. Partially connected runtimes are rolled back on failure and servers close in reverse order.

Legacy single-remote-server settings remain supported:

```text
MCP_SERVER_URL
MCP_SERVER_LABEL
MCP_AUTHORIZATION
```

## Diagnostics and acceptance

Rejected builds return structured text plus, when available, the preserved failed artifact as tool file output. PPTX/DOCX failures also receive a LibreOffice-rendered diagnostic PDF when conversion succeeds. Host-only diagnostic paths are never treated as sufficient evidence for a remote model.

`GET /healthz` reports process liveness.

`GET /readyz` reports static deployment readiness and returns 503 for unsafe/incomplete V2 configuration. In Cloudflare production, static readiness requires the authenticated bridge and R2 binding configuration. The first real job still must pass the live sandbox preflight described above.

`GET /version` exposes non-secret runtime metadata only.

## CI production gate

Promotion is blocked unless CI passes all existing Agent Díaz tests plus the Cloudflare execution proof:

1. root TypeScript, tests, production build, runtime smoke, and reviewed audit;
2. Cloudflare bridge Worker typecheck;
3. custom Cloudflare sandbox image build;
4. real POSIX create/rename/read/delete in `/workspace`;
5. Chromium, Playwright MCP, Chrome DevTools MCP, filesystem MCP, and Puppeteer presence;
6. real Puppeteer navigation/render/screenshot using a file written in `/workspace`;
7. real filesystem MCP read from `/workspace`;
8. real Playwright MCP navigation to HTML written in `/workspace`;
9. checkpoint-3 golden artifact matrix;
10. exact-prompt presentation route regression;
11. production Agent Díaz container build;
12. preservation of the regression artifact packages.

This proves the repository and the exact Cloudflare container image contract. It does not substitute for the final paid-provider smoke after the Cloudflare Worker, R2 bucket, and secrets are actually deployed.

## Rollout

- `AGENT_RUNTIME=legacy` remains an emergency compatibility switch.
- existing deterministic renderer/validator regression coverage remains intact.
- no production deployment is performed merely by merging this code.
- after repository CI is green and the branch is promoted, the live rollout is: enable Workers Paid, create the R2 bucket, deploy the included bridge, configure the application environment, confirm `/readyz`, then run a real provider artifact and repair-loop smoke test.
