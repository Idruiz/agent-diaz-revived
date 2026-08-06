# Agent Díaz 3.0.0

This release replaces every earlier Agent Díaz Revived archive.

## Corrected since 2.3

- Website pages now embed their CSS and photographs directly and include `OPEN_ME_FIRST.html`.
- Wikimedia search/download uses bounded exponential retry and paced sequential requests.
- Presentation and document builders now consume licensed-photo requests instead of ignoring them.
- Website planning enforces three to six pages, complete section assignment, and documentary photo briefs.
- Artifact plans remain internal; the chat transcript receives a human-readable completion result instead of raw builder JSON.
- MCP is reachable from the chat skill when configured.
- MCP approval requests are captured, shown, persisted, approved or rejected, and continued through `previous_response_id`.
- MCP credentials and tool configuration are re-sent during approval continuation as required by the API contract.
- Multiple approval requests from one response are collected before continuation.
- Concurrent jobs in the same conversation are rejected to protect message order.
- Conversations with active jobs cannot be archived.
- External Google Fonts were removed; the secured UI has no remote font dependency.
- Docker, Compose, GitHub Actions, runtime health checks, and an exact deployment guide were added.
- OpenAI SDK updated to 7.x and the main model default changed to the stable `gpt-5.6` alias.

## Verified locally

- TypeScript check.
- Eleven automated tests covering contracts, contained paths, builders, conversation lifecycle, portable website packaging, and approval persistence.
- Production Vite and server bundle.
- Authenticated runtime health/login/skills smoke test.
- Production dependency audit with zero reported vulnerabilities.
- Release ZIP integrity and secret/build-output exclusions.

## Requires deployment credentials to verify

- Live OpenAI generation and account-specific model/tool access.
- Live Code Interpreter execution against your uploaded files.
- Live web-search results and citations.
- The exact remote MCP server, authorization token, tool schemas, and external action receipts.
- Docker image build on a host with Docker installed.

These are deployment integration checks, not simulated successes. Follow the README and test a harmless read followed by a harmless approved write before trusting a configured MCP server with consequential actions.
