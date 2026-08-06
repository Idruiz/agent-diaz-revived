# Agent Díaz 3.0

Agent Díaz is a private, single-owner AI workbench for durable conversations, cited research, uploaded-file analysis, visual document production, presentations, and portable multi-page websites.

This repository is the complete application source. It does not contain credentials, generated artifacts, databases, or dependencies.

## Production capabilities

- Responses API background execution, polling, cancellation, and restart recovery.
- Full durable context inside each conversation.
- Five recent conversations retain full transcripts; older conversations are summarized and archived read-only.
- Archived summaries can inform later conversations without replaying raw transcripts.
- Explicit anti-repetition and continuity instructions.
- Hosted web search for research and fact-grounded artifacts.
- Code Interpreter analysis of uploaded files.
- Visual PPTX files with editable tables, charts, diagrams, notes, sources, and licensed photography when requested.
- Visual DOCX files with editable tables, rendered charts/diagrams, structured prose, sources, and licensed photography when requested.
- Three-to-six-page website ZIPs with responsive navigation, inline SVG visualizations, tables, embedded CSS, and embedded licensed Wikimedia images.
- `OPEN_ME_FIRST.html` in every website ZIP. Pages work when opened directly on phones and do not depend on preserved asset folders.
- Generic remote MCP support with exact per-call approval capture, durable decisions, and Responses continuation.
- Owner authentication, HTTP-only cookies, same-origin mutation protection, contained paths, upload limits, and secret-redacted logs.
- SQLite persistence for sessions, conversations, messages, jobs, approvals, uploads, and artifacts.
- Docker and GitHub Actions production tooling.

## Honest boundaries

- No specific Gmail, Calendar, Drive, Slack, or Notion connector is bundled. One trusted remote MCP server can be configured through environment variables.
- The application does not implement OAuth. If the selected MCP server requires authorization, supply and rotate its token securely through the deployment environment.
- Approval continuation is implemented, but the selected MCP server and its exact tools must be integration-tested with your account before consequential production use.
- Research and analysis artifacts are DOCX. Native XLSX, PDF, infographic, video, image-generation, live voice, and website publishing are not included in 3.0.
- This is single-owner software. Multi-user use requires identity-provider login and per-resource authorization.

## Requirements

- Node.js 22.5 or newer, or Docker.
- OpenAI API key with access to the configured models and tools.
- A unique owner passphrase of at least 16 characters.
- HTTPS reverse proxy for production.

## Local start

```bash
cp .env.example .env
# Set OPENAI_API_KEY and ADMIN_PASSWORD in .env
npm ci
npm run verify
npm run dev
```

Open `http://localhost:5173`. Vite proxies API requests to port 3000.

## Docker start

```bash
cp .env.example .env
# Set OPENAI_API_KEY, ADMIN_PASSWORD and BASE_URL in .env
docker compose up --build -d
```

Open the `BASE_URL` you configured. The Compose volumes preserve the database, artifacts, and uploads across container replacement.

## Direct production start

```bash
npm ci
npm run verify
NODE_ENV=production npm start
```

Set `BASE_URL` to the exact public HTTPS origin. Persist and back up `data/`, `artifacts/`, and `uploads/` together.

## Environment

| Variable | Required | Purpose |
|---|---:|---|
| `OPENAI_API_KEY` | Yes | Server-side API access |
| `ADMIN_PASSWORD` | Yes | Single-owner login, minimum 16 characters |
| `BASE_URL` | Production | Exact allowed origin, such as `https://diaz.example.com` |
| `OPENAI_MODEL` | No | Main model; defaults to `gpt-5.6` |
| `OPENAI_FAST_MODEL` | No | Conversation compaction model; defaults to `gpt-5.6-terra` |
| `PORT` | No | HTTP port; defaults to `3000` |
| `MAX_UPLOAD_MB` | No | Per-file limit, 1–100 MB |
| `MCP_SERVER_URL` | No | Trusted Streamable HTTP or HTTP/SSE MCP endpoint |
| `MCP_SERVER_LABEL` | No | Stable MCP server label |
| `MCP_AUTHORIZATION` | No | Server-side bearer/OAuth token required by that MCP server |

## GitHub upload

Extract the release ZIP and publish the extracted repository folder with GitHub Desktop or Git. Do not upload the ZIP itself as a repository file. The repository root must contain:

```text
.github/
src/
.dockerignore
.env.example
.gitignore
Dockerfile
docker-compose.yml
package.json
package-lock.json
README.md
tsconfig.json
vite.config.ts
```

Never commit `.env`, `data/`, `artifacts/`, `uploads/`, `dist/`, or `node_modules/`.

## Verification

```bash
npm run verify
```

The gate runs TypeScript checking, automated tests, the production client/server build, and a production dependency audit. GitHub Actions runs the same gate on pushes and pull requests.

## Architecture

```text
React UI
  -> authenticated Express API
     -> SQLite conversations, jobs, approvals, uploads, artifacts
     -> OpenAI Responses (web search / Code Interpreter / optional MCP)
     -> deterministic PPTX, DOCX, and portable website builders
     -> validation gate and authenticated downloads
```

## Security operations

- Keep the application private and behind HTTPS.
- Use only MCP servers you trust; remote MCP content can contain prompt injection.
- Keep approval enabled for every MCP call.
- Review exact arguments before approving.
- Rotate the owner passphrase and MCP authorization token periodically.
- Back up the three persistent directories together.
- Do not expose port 3000 directly to the public internet without a TLS reverse proxy.
