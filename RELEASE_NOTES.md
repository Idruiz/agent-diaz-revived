# Agent Díaz 3.2.2

## Javier runtime style gate

- Moved Javier's final output contract after skill, continuity, transcript, and archival context so older polite answers can no longer dominate the active voice.
- Added an executable style inspection for Cuban street register, distributed profanity, profanity variety, colloquial texture, volatility, formal-language leakage, and sanitized list structure.
- Javier chat drafts are now quarantined until they pass; rejected drafts are never streamed to the browser or persisted to shared conversation memory.
- A failed first draft receives one fact-preserving style rewrite. A second sanitized result fails visibly and remains retryable instead of silently impersonating Javier.
- The other five personas keep the original direct streaming path and incur no extra model call.
- Realtime voice now receives Javier's final output contract after the supplied transcript and durable memory.
- Added regression coverage using the exact polite unisex-bathroom response captured from production.

# Agent Díaz 3.2.1

## Javier voice correction

- Rebuilt Javier as a street-educated, street-smart Cuban rebel rather than an academic assistant decorated with occasional slang.
- Made colloquial Cuban Spanish, naturally distributed profanity, flowing diatribes, contrarian judgment, and anti-establishment reasoning part of the enforceable persona contract.
- Explicitly rejects reflexive both-sides framing, corporate neutrality, management jargon, therapy language, tidy point-form answers, and token swear words.
- Keeps factual accuracy and hard safety boundaries, but requires brief in-character warnings or refusals instead of sanitized policy lectures.
- Strengthened both written and OpenAI Realtime prompt tests so Javier's street register reaches chat and voice sessions.

## Agent Díaz 3.2.0

## Persona and voice release

- Added six conversation personas with distinct reasoning and communication behavior: Díaz, Javier, Vega, Mara, Luz, and Salcedo.
- Added durable per-conversation persona selection plus persona snapshots on jobs and assistant messages, so old responses keep their original speaker after a persona switch.
- Added a shared-memory boundary that preserves facts, decisions, preferences, and constraints while excluding persona jokes, profanity, role-play, and exaggeration from autobiographical memory.
- Realtime voice is now assigned on the server by persona: Cedar, Echo, Sage, Ash, Coral, and Marin respectively.
- Spoken delivery instructions make each persona sound distinct; Javier receives Cuban cadence and natural Cuban Spanish code-switching.
- Removed manual voice selection from the client contract, preventing the browser from overriding persona identity.
- Confirmed the application uses OpenAI WebRTC audio only and never browser speech-synthesis voices.
- Changed the Quick/Luna UI wording from `low` to `light` without changing the API reasoning value.
- Added regression coverage for persona contracts, unique voices, server-owned voice selection, prompt injection, SQLite persistence, and persona provenance.
- Replaced reusable credential-shaped test literals with per-run random smoke/test values.

# Agent Díaz 3.1.0

## Conversational production pass

- Ordinary chat now streams directly into the transcript through authenticated SSE; user messages appear immediately and stop/retry are inline.
- Quick, Balanced, and Deep model/reasoning profiles persist per conversation and are recorded on every job.
- Attachments are bound to their visible user message and sent as image or file inputs; spreadsheets automatically enable Code Interpreter.
- Upload preparation, file-reading, provider, interruption, and restart failures remain visible and retryable.
- Voice chat uses WebRTC, short-lived Realtime client secrets, the cost-controlled Realtime model, Marin/Cedar voices, and durable transcript pairs.
- Artifact work remains a durable background pipeline with progress, cancellation, approvals, deterministic builders, and authenticated downloads.
- SQLite, uploads, and artifacts can now live under one `STORAGE_DIR`, enabling a single Render persistent-disk mount.
- The UI is now a responsive modern conversation workspace with a fixed composer and compact artifact/task controls.
- GitHub Actions were removed; verified releases are deployed manually.

## Revival baseline

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
