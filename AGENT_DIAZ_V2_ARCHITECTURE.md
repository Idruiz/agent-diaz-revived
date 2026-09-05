# Agent Díaz V2 — 2026 Agentic Architecture

Branch: `variant/agent-diaz-v2`

Production `main` and `snapshot/main-2026-09-04-green` are intentionally not modified by this work.

## Goal

Agent Díaz V2 is not a scripted sequence of model calls. It is an agentic artifact-production runtime that owns a real work loop and keeps revising until a deterministic production validator accepts a downloadable artifact.

## Core runtime

- OpenAI Agents SDK (`@openai/agents`)
- SandboxAgent execution harness
- Real sandbox filesystem, shell, patching, image inspection, and context compaction
- Hosted OpenAI web search and code interpreter tools
- Optional Streamable HTTP MCP server integration
- Existing Agent Díaz deterministic renderers and validators exposed as an agent tool
- Explicit terminal acceptance tool that can only accept a build that already passed validation
- Normal Agent SDK tracing plus Agent Díaz structured application logs
- Cancellation through AbortSignal

## Artifact loop

1. The agent reads the request and input files in its sandbox workspace.
2. It researches or executes code where evidence requires it.
3. It creates a complete ArtifactPlan.
4. It calls `build_and_validate_artifact`.
5. The existing deterministic builder renders the real PPTX/DOCX/ZIP artifact and runs the real validators.
6. If validation fails, the agent receives the exact failure class, rule, diagnostic, and repair guidance.
7. The agent revises or retries and calls the builder again.
8. There is no legacy two-repair/six-LLM-call ceiling controlling V2.
9. Only a successful build receives a build ID.
10. The run terminates only when the agent calls `accept_validated_artifact` using one of those validated build IDs.
11. The accepted file is promoted into the normal Agent Díaz artifact store and becomes downloadable through the existing UI/API.

## Failure policy

- `PLAN_CONTENT`: repair requirements, structure, or content and rebuild.
- `PLAN_NORMALIZABLE`: normalize/repair the plan and rebuild.
- `ASSET`: improve image queries or retry transient image acquisition without degrading requested visual coverage.
- `BUILD`: use the deterministic rule/diagnostic to revise layout or content and rebuild.
- `INFRA`: preserve good content and retry the infrastructure operation rather than rewriting the artifact to dodge an outage.

The agent may only stop without a downloadable artifact when the user explicitly cancels or an unrecoverable external dependency prevents further progress. Failures must remain observable in logs and job state; nothing fails silently.

## Filesystem and MCP

The sandbox filesystem is the canonical workspace for the agent. MCP is an extension layer for external systems and specialized tools. This avoids using MCP as a fake filesystem abstraction when the Agents SDK already provides a real workspace, while still supporting remote MCP servers through the current `MCP_SERVER_URL`, `MCP_SERVER_LABEL`, and `MCP_AUTHORIZATION` configuration.

## Compatibility

The legacy artifact pipeline remains in the V2 branch as a compatibility fallback selected with `AGENT_RUNTIME=legacy`. The V2 branch defaults to `AGENT_RUNTIME=v2`. `main` remains unchanged.
