from pathlib import Path
import re

ROOT = Path('.')


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


write('src/server/v2/diagnostic-evidence.ts', r'''import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { log } from "../log.js";

const execFileAsync = promisify(execFile);
const MAX_DIAGNOSTIC_BYTES = 18 * 1024 * 1024;

export interface V2FailureDiagnosticInput {
  jobId: string;
  kind: string;
  attempt: number;
  failureClass: string;
  ruleOrPart: string;
  message: string;
  retryAdvice: string;
  planSha: string;
  stagnationCount: number;
  diagnosticPath?: string;
}

function mediaTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pptx")
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx")
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".zip") return "application/zip";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

async function renderOfficeDiagnosticPdf(
  sourcePath: string,
  jobId: string,
): Promise<{ bytes: Buffer; filename: string } | null> {
  if (!/\.(?:pptx|docx)$/i.test(sourcePath)) return null;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-v2-diagnostic-"));
  const profileDir = path.join(tempRoot, "profile");
  const outputDir = path.join(tempRoot, "out");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    await execFileAsync(
      "soffice",
      [
        "--headless",
        "--nologo",
        "--nodefault",
        "--nolockcheck",
        "--nofirststartwizard",
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        sourcePath,
      ],
      { timeout: 120_000, maxBuffer: 1_000_000 },
    );
    const pdfPath = path.join(
      outputDir,
      `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`,
    );
    if (!fs.existsSync(pdfPath)) return null;
    const bytes = fs.readFileSync(pdfPath);
    if (
      bytes.length < 2_000 ||
      bytes.length > MAX_DIAGNOSTIC_BYTES ||
      bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
    )
      return null;
    return {
      bytes,
      filename: `${path.basename(sourcePath, path.extname(sourcePath))}-diagnostic-render.pdf`,
    };
  } catch (error) {
    log("warn", "agent_v2.diagnostic_render_unavailable", {
      jobId,
      source: path.basename(sourcePath),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function buildFailureToolOutput(
  input: V2FailureDiagnosticInput,
): Promise<any[]> {
  const attachments: any[] = [];
  let diagnosticAttached = false;
  let renderedPdfAttached = false;
  let diagnosticFileName: string | null = null;
  let diagnosticBytes: number | null = null;
  let diagnosticOmittedReason: string | null = null;

  if (input.diagnosticPath && fs.existsSync(input.diagnosticPath)) {
    try {
      const stat = fs.statSync(input.diagnosticPath);
      diagnosticFileName = path.basename(input.diagnosticPath);
      diagnosticBytes = stat.size;
      if (stat.isFile() && stat.size <= MAX_DIAGNOSTIC_BYTES) {
        attachments.push({
          type: "file",
          file: {
            data: new Uint8Array(fs.readFileSync(input.diagnosticPath)),
            filename: diagnosticFileName,
            mediaType: mediaTypeForPath(input.diagnosticPath),
          },
        });
        diagnosticAttached = true;
      } else if (stat.size > MAX_DIAGNOSTIC_BYTES) {
        diagnosticOmittedReason = `diagnostic exceeded ${MAX_DIAGNOSTIC_BYTES} byte agent-output limit`;
      }

      const rendered = await renderOfficeDiagnosticPdf(
        input.diagnosticPath,
        input.jobId,
      );
      if (rendered) {
        attachments.push({
          type: "file",
          file: {
            data: new Uint8Array(rendered.bytes),
            filename: rendered.filename,
            mediaType: "application/pdf",
          },
        });
        renderedPdfAttached = true;
      }
    } catch (error) {
      diagnosticOmittedReason =
        error instanceof Error ? error.message : String(error);
      log("warn", "agent_v2.diagnostic_attachment_failed", {
        jobId: input.jobId,
        error: diagnosticOmittedReason,
      });
    }
  }

  const summary = {
    ok: false,
    attempt: input.attempt,
    failureClass: input.failureClass,
    ruleOrPart: input.ruleOrPart,
    message: input.message,
    planSha: input.planSha,
    stagnationCount: input.stagnationCount,
    retryAdvice: input.retryAdvice,
    diagnosticAttached,
    renderedPdfAttached,
    diagnosticFileName,
    diagnosticBytes,
    diagnosticOmittedReason,
  };

  return [
    { type: "text", text: JSON.stringify(summary, null, 2) },
    ...attachments,
  ];
}
''')

write('src/server/v2/revision-ledger.ts', r'''import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface V2RevisionLedgerEntry {
  attempt: number;
  planSha: string;
  status: "validated" | "rejected";
  buildId?: string;
  failureClass?: string;
  ruleOrPart?: string;
  message?: string;
  stagnationCount?: number;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function writeV2AttemptPlan(
  workRoot: string,
  attempt: number,
  plan: unknown,
): { attemptDir: string; planPath: string; planSha: string } {
  const attemptDir = path.join(workRoot, `attempt-${attempt}`);
  fs.mkdirSync(attemptDir, { recursive: true });
  const planPath = path.join(attemptDir, "plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return { attemptDir, planPath, planSha: sha256Json(plan) };
}

export function appendV2RevisionEntry(
  workRoot: string,
  entry: V2RevisionLedgerEntry,
): void {
  fs.mkdirSync(workRoot, { recursive: true });
  fs.appendFileSync(
    path.join(workRoot, "REVISION_HISTORY.jsonl"),
    `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

export function listV2RecoveryFiles(
  workRoot: string,
): Array<{ workspacePath: string; hostPath: string }> {
  const out: Array<{ workspacePath: string; hostPath: string }> = [];
  const historyPath = path.join(workRoot, "REVISION_HISTORY.jsonl");
  if (fs.existsSync(historyPath))
    out.push({
      workspacePath: "recovery/REVISION_HISTORY.jsonl",
      hostPath: historyPath,
    });

  if (!fs.existsSync(workRoot)) return out;
  const attempts = fs
    .readdirSync(workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      number: Number(entry.name.replace("attempt-", "")),
    }))
    .sort((a, b) => b.number - a.number);
  const latest = attempts[0];
  if (latest) {
    const planPath = path.join(workRoot, latest.name, "plan.json");
    if (fs.existsSync(planPath))
      out.push({
        workspacePath: "recovery/LATEST_PLAN.json",
        hostPath: planPath,
      });
  }
  return out;
}
''')

write('src/server/v2/sandbox-runtime.ts', r'''import { CloudflareSandboxClient } from "@openai/agents-extensions/sandbox/cloudflare";
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from "@openai/agents/sandbox/local";
import { log } from "../log.js";

export type V2SandboxProvider = "cloudflare" | "docker" | "unix";

export type V2SandboxClient =
  | CloudflareSandboxClient
  | DockerSandboxClient
  | UnixLocalSandboxClient;

export interface V2SandboxRuntime {
  provider: V2SandboxProvider;
  client: V2SandboxClient;
}

function enabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function resolveV2SandboxProvider(
  env: NodeJS.ProcessEnv = process.env,
): V2SandboxProvider {
  const explicit = env.AGENT_SANDBOX_PROVIDER?.trim().toLocaleLowerCase();
  if (explicit) {
    if (explicit === "cloudflare" || explicit === "docker" || explicit === "unix")
      return explicit;
    throw new Error(
      `AGENT_SANDBOX_PROVIDER must be cloudflare, docker, or unix; received '${env.AGENT_SANDBOX_PROVIDER}'`,
    );
  }
  if (env.CLOUDFLARE_SANDBOX_WORKER_URL?.trim()) return "cloudflare";
  return "unix";
}

export function assertV2SandboxProviderReady(
  provider: V2SandboxProvider,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (provider === "cloudflare" && !env.CLOUDFLARE_SANDBOX_WORKER_URL?.trim())
    throw new Error(
      "AGENT_SANDBOX_PROVIDER=cloudflare requires CLOUDFLARE_SANDBOX_WORKER_URL",
    );
  if (
    provider === "unix" &&
    env.NODE_ENV === "production" &&
    !enabled(env.AGENT_SANDBOX_ALLOW_UNSAFE_UNIX)
  )
    throw new Error(
      "Agent Díaz V2 refuses Unix-local shell execution in production. Configure CLOUDFLARE_SANDBOX_WORKER_URL, select AGENT_SANDBOX_PROVIDER=docker, or explicitly set AGENT_SANDBOX_ALLOW_UNSAFE_UNIX=true for an emergency override.",
    );
}

export function createV2SandboxRuntime(
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): V2SandboxRuntime {
  const provider = resolveV2SandboxProvider(env);
  assertV2SandboxProviderReady(provider, env);

  if (provider === "cloudflare") {
    const workerUrl = env.CLOUDFLARE_SANDBOX_WORKER_URL!.trim();
    const client = new CloudflareSandboxClient({
      workerUrl,
      ...(env.CLOUDFLARE_SANDBOX_API_KEY
        ? { apiKey: env.CLOUDFLARE_SANDBOX_API_KEY }
        : {}),
      timeoutMs: 120_000,
      createTimeoutMs: 120_000,
      requestTimeoutMs: 120_000,
      archiveLimits: {},
    });
    log("info", "agent_v2.sandbox_selected", {
      jobId,
      provider,
      hosted: true,
    });
    return { provider, client };
  }

  if (provider === "docker") {
    const image =
      env.AGENT_SANDBOX_DOCKER_IMAGE?.trim() || "node:22-bookworm-slim";
    const client = new DockerSandboxClient({ image });
    log("info", "agent_v2.sandbox_selected", {
      jobId,
      provider,
      hosted: false,
      image,
    });
    return { provider, client };
  }

  log(
    env.NODE_ENV === "production" ? "warn" : "info",
    "agent_v2.sandbox_selected",
    {
      jobId,
      provider,
      hosted: false,
      unsafeProductionOverride:
        env.NODE_ENV === "production" &&
        enabled(env.AGENT_SANDBOX_ALLOW_UNSAFE_UNIX),
    },
  );
  return { provider, client: new UnixLocalSandboxClient() };
}
''')

write('src/server/v2/mcp-runtime.ts', r'''import {
  MCPServerStdio,
  MCPServerStreamableHttp,
} from "@openai/agents";
import { z } from "zod";
import type { Config } from "../config.js";
import { log } from "../log.js";

const ToolNameListSchema = z.array(z.string().min(1).max(128)).max(100).optional();

const HttpMcpSchema = z.object({
  transport: z.literal("http"),
  name: z.string().min(1).max(80),
  url: z.string().url(),
  authorizationEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  allowedTools: ToolNameListSchema,
  blockedTools: ToolNameListSchema,
});

const StdioMcpSchema = z.object({
  transport: z.literal("stdio"),
  name: z.string().min(1).max(80),
  fullCommand: z.string().min(1).max(2_000),
  allowedTools: ToolNameListSchema,
  blockedTools: ToolNameListSchema,
});

const McpDefinitionSchema = z.discriminatedUnion("transport", [
  HttpMcpSchema,
  StdioMcpSchema,
]);

const McpDefinitionsSchema = z.array(McpDefinitionSchema).max(12);
export type V2McpDefinition = z.infer<typeof McpDefinitionSchema>;
export type V2McpDefinitions = z.infer<typeof McpDefinitionsSchema>;
export type V2McpServer = MCPServerStreamableHttp | MCPServerStdio;

export interface V2McpRuntime {
  servers: V2McpServer[];
  descriptions: Array<{
    name: string;
    transport: "http" | "stdio";
  }>;
}

function enabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function uniqueDefinitions(definitions: V2McpDefinitions): V2McpDefinitions {
  const seen = new Set<string>();
  return definitions.filter((definition) => {
    const key = definition.name.trim().toLocaleLowerCase();
    if (seen.has(key))
      throw new Error(`Duplicate MCP server name '${definition.name}'`);
    seen.add(key);
    return true;
  });
}

export function parseV2McpDefinitions(
  raw: string | undefined,
): V2McpDefinitions {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MCP_SERVERS_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = McpDefinitionsSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `MCP_SERVERS_JSON failed validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    );
  return uniqueDefinitions(result.data);
}

export function assertV2McpEnvironmentSafe(
  definitions: V2McpDefinitions,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    env.NODE_ENV === "production" &&
    definitions.some((definition) => definition.transport === "stdio") &&
    !enabled(env.AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION)
  )
    throw new Error(
      "Agent Díaz V2 refuses host-level stdio MCP processes in production by default. Use Streamable HTTP MCP servers, or explicitly set AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION=true after reviewing the commands.",
    );
}

function toolFilterFor(definition: V2McpDefinition) {
  const allowed = new Set(definition.allowedTools ?? []);
  const blocked = new Set(definition.blockedTools ?? []);
  if (!allowed.size && !blocked.size) return undefined;
  return async (_context: any, tool: any) => {
    const name = String(tool?.name ?? "");
    return (!allowed.size || allowed.has(name)) && !blocked.has(name);
  };
}

export function createV2McpRuntime(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): V2McpRuntime {
  const definitions = parseV2McpDefinitions(env.MCP_SERVERS_JSON);

  if (config.MCP_SERVER_URL) {
    const fallbackName = config.MCP_SERVER_LABEL || "Agent Diaz MCP";
    if (
      !definitions.some(
        (definition) =>
          definition.name.trim().toLocaleLowerCase() ===
          fallbackName.trim().toLocaleLowerCase(),
      )
    )
      definitions.push({
        transport: "http",
        name: fallbackName,
        url: config.MCP_SERVER_URL,
        timeoutMs: 60_000,
      });
  }

  assertV2McpEnvironmentSafe(definitions, env);

  const servers: V2McpServer[] = [];
  const descriptions: V2McpRuntime["descriptions"] = [];
  for (const definition of definitions) {
    const toolFilter = toolFilterFor(definition);
    if (definition.transport === "http") {
      const authorization = definition.authorizationEnv
        ? env[definition.authorizationEnv]
        : config.MCP_SERVER_URL === definition.url
          ? config.MCP_AUTHORIZATION
          : undefined;
      if (definition.authorizationEnv && !authorization)
        throw new Error(
          `MCP server '${definition.name}' requires environment variable ${definition.authorizationEnv}`,
        );
      servers.push(
        new MCPServerStreamableHttp({
          url: definition.url,
          name: definition.name,
          cacheToolsList: true,
          timeout: definition.timeoutMs,
          useStructuredContent: true,
          ...(toolFilter ? { toolFilter } : {}),
          ...(authorization
            ? { requestInit: { headers: { Authorization: authorization } } }
            : {}),
        }),
      );
      descriptions.push({ name: definition.name, transport: "http" });
      continue;
    }

    servers.push(
      new MCPServerStdio({
        name: definition.name,
        fullCommand: definition.fullCommand,
        cacheToolsList: true,
        useStructuredContent: true,
        ...(toolFilter ? { toolFilter } : {}),
      }),
    );
    descriptions.push({ name: definition.name, transport: "stdio" });
  }

  return { servers, descriptions };
}

export async function connectV2McpServers(
  runtime: V2McpRuntime,
  jobId: string,
): Promise<void> {
  const connected: V2McpServer[] = [];
  try {
    for (const server of runtime.servers) {
      await server.connect();
      connected.push(server);
    }
  } catch (error) {
    for (const server of connected.reverse()) {
      try {
        await server.close();
      } catch {
        // Preserve the original connection failure.
      }
    }
    log("error", "agent_v2.mcp_connect_failed", {
      jobId,
      configured: runtime.descriptions,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function closeV2McpServers(
  runtime: V2McpRuntime,
  jobId: string,
): Promise<void> {
  for (const server of [...runtime.servers].reverse()) {
    try {
      await server.close();
    } catch (error) {
      log("warn", "agent_v2.mcp_close_failed", {
        jobId,
        server: server.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
''')

write('src/server/v2/runtime-readiness.ts', r'''import {
  assertV2McpEnvironmentSafe,
  parseV2McpDefinitions,
} from "./mcp-runtime.js";
import {
  assertV2SandboxProviderReady,
  resolveV2SandboxProvider,
  type V2SandboxProvider,
} from "./sandbox-runtime.js";

export interface V2RuntimeReadiness {
  ready: boolean;
  runtime: "v2" | "legacy";
  sandboxProvider: V2SandboxProvider | null;
  mcpServerCount: number;
  issues: string[];
  warnings: string[];
}

export function inspectV2RuntimeReadiness(
  env: NodeJS.ProcessEnv = process.env,
): V2RuntimeReadiness {
  if (env.AGENT_RUNTIME?.trim().toLocaleLowerCase() === "legacy")
    return {
      ready: true,
      runtime: "legacy",
      sandboxProvider: null,
      mcpServerCount: env.MCP_SERVER_URL?.trim() ? 1 : 0,
      issues: [],
      warnings: ["Legacy artifact runtime is explicitly selected."],
    };

  const issues: string[] = [];
  const warnings: string[] = [];
  let sandboxProvider: V2SandboxProvider | null = null;
  let mcpServerCount = env.MCP_SERVER_URL?.trim() ? 1 : 0;

  try {
    sandboxProvider = resolveV2SandboxProvider(env);
    assertV2SandboxProviderReady(sandboxProvider, env);
    if (sandboxProvider === "docker")
      warnings.push(
        "Docker sandbox readiness is verified when the first sandbox session is created; the host must expose a working Docker daemon.",
      );
    if (
      sandboxProvider === "unix" &&
      env.NODE_ENV === "production"
    )
      warnings.push(
        "Unix-local sandbox is running under an explicit unsafe production override.",
      );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const definitions = parseV2McpDefinitions(env.MCP_SERVERS_JSON);
    assertV2McpEnvironmentSafe(definitions, env);
    mcpServerCount += definitions.length;
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  return {
    ready: issues.length === 0,
    runtime: "v2",
    sandboxProvider,
    mcpServerCount,
    issues,
    warnings,
  };
}
''')

write('.env.example', r'''# Required. Never expose this key to the browser.
OPENAI_API_KEY=

# Required. Set a long unique passphrase (minimum 16 characters).
ADMIN_PASSWORD=

# Optional.
PORT=3000
BASE_URL=http://localhost:3000
OPENAI_MODEL=gpt-5.6
OPENAI_FAST_MODEL=gpt-5.6-terra
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
SESSION_DAYS=7
MAX_UPLOAD_MB=25

# Optional. On Render, mount one persistent disk here and preserve every durable byte.
STORAGE_DIR=

# Real (not AI-generated) website photography. Wikimedia Commons is free and keyless.
IMAGE_PROVIDER=wikimedia

# Agent Díaz V2 is the default artifact runtime. Set legacy only for emergency compatibility.
AGENT_RUNTIME=v2

# Production sandbox. Cloudflare hosted is the recommended production path.
# If CLOUDFLARE_SANDBOX_WORKER_URL is present, V2 selects cloudflare automatically.
AGENT_SANDBOX_PROVIDER=
CLOUDFLARE_SANDBOX_WORKER_URL=
CLOUDFLARE_SANDBOX_API_KEY=
AGENT_SANDBOX_DOCKER_IMAGE=node:22-bookworm-slim

# Emergency escape hatch only. V2 otherwise refuses Unix-local shell execution in production.
AGENT_SANDBOX_ALLOW_UNSAFE_UNIX=false

# Multi-server MCP configuration. Prefer Streamable HTTP in production.
# Example:
# MCP_SERVERS_JSON=[{"transport":"http","name":"Playwright MCP","url":"https://playwright.example.com/mcp","authorizationEnv":"PLAYWRIGHT_MCP_AUTH","allowedTools":["browser_navigate","browser_snapshot"]}]
MCP_SERVERS_JSON=

# Stdio MCP is convenient for development but executes a configured process on the app host.
# Production refuses stdio unless this explicit reviewed override is enabled.
AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION=false

# Backward-compatible single remote MCP server. Authorization stays server-side.
MCP_SERVER_URL=
MCP_SERVER_LABEL=workspace
MCP_AUTHORIZATION=
''')

# Patch artifact-agent-runtime.ts.
runtime_path = ROOT / 'src/server/v2/artifact-agent-runtime.ts'
runtime = runtime_path.read_text()

import_anchor = '''import {\n  closeV2McpServers,\n  connectV2McpServers,\n  createV2McpRuntime,\n} from "./mcp-runtime.js";\n'''
import_addition = '''import { buildFailureToolOutput } from "./diagnostic-evidence.js";\nimport {\n  appendV2RevisionEntry,\n  listV2RecoveryFiles,\n  writeV2AttemptPlan,\n} from "./revision-ledger.js";\n'''
if import_addition not in runtime:
    assert import_anchor in runtime, 'artifact runtime MCP import anchor missing'
    runtime = runtime.replace(import_anchor, import_anchor + import_addition, 1)

instruction_anchor = '    "There is no arbitrary two-repair or six-call ceiling in this V2 loop. Continue until a build returns ok:true unless the user cancels or an unrecoverable external dependency makes progress impossible.",\n'
instruction_addition = '''    "If recovery/REVISION_HISTORY.jsonl or recovery/LATEST_PLAN.json exists, inspect it before restarting work so a process restart does not erase the last known revision strategy.",\n    "A rejected build may include the exact failed artifact and a rendered diagnostic PDF as tool outputs. Inspect those files with code execution when the failure is visual, structural, or otherwise unclear before changing the plan.",\n    "Do not dead-horse an unchanged rejected plan. If stagnationCount is 2 or greater, materially change the plan, layout, asset strategy, or diagnostic approach before rebuilding unless the failure is explicitly transient infrastructure.",\n'''
if instruction_addition not in runtime:
    assert instruction_anchor in runtime, 'artifact instructions anchor missing'
    runtime = runtime.replace(instruction_anchor, instruction_anchor + instruction_addition, 1)

map_anchor = '  const successfulBuilds = new Map<string, BuiltFile>();\n'
if 'const failureFingerprints = new Map<string, number>();' not in runtime:
    assert map_anchor in runtime, 'successfulBuilds anchor missing'
    runtime = runtime.replace(
        map_anchor,
        map_anchor + '  const failureFingerprints = new Map<string, number>();\n',
        1,
    )

pattern = re.compile(r'''      attempt \+= 1;\n      const attemptDir = path\.join\(workRoot, `attempt-\$\{attempt\}`\);\n      fs\.mkdirSync\(attemptDir, \{ recursive: true \}\);\n      log\("info", "agent_v2\.artifact_build_started", \{.*?          retryAdvice: retryAdvice\(failure\),\n        \};\n      \}\n''', re.S)
replacement = r'''      attempt += 1;
      const { attemptDir, planSha } = writeV2AttemptPlan(
        workRoot,
        attempt,
        plan,
      );
      log("info", "agent_v2.artifact_build_started", {
        jobId: input.jobId,
        kind: input.kind,
        attempt,
        planSha,
      });
      try {
        const built = await buildArtifact(
          { ...input.config, artifactDir: attemptDir },
          input.kind,
          plan,
          input.prompt,
          input.jobId,
          (event) => {
            if (input.signal?.aborted)
              throw new Error("Agent Díaz V2 run cancelled");
            input.onProgress?.(event);
          },
        );
        const buildId = crypto.randomUUID();
        successfulBuilds.set(buildId, built);
        appendV2RevisionEntry(workRoot, {
          attempt,
          planSha,
          status: "validated",
          buildId,
        });
        log("info", "agent_v2.artifact_build_validated", {
          jobId: input.jobId,
          kind: input.kind,
          attempt,
          buildId,
          planSha,
          name: built.name,
          size: built.size,
        });
        return {
          ok: true as const,
          buildId,
          attempt,
          name: built.name,
          mime: built.mime,
          size: built.size,
          validation: validationSummary(built),
        };
      } catch (error) {
        const failure = classifyV2BuildFailure(error);
        const fingerprint = `${failure.failureClass}:${failure.ruleOrPart}:${planSha}`;
        const stagnationCount =
          failure.failureClass === "INFRA"
            ? 1
            : (failureFingerprints.get(fingerprint) ?? 0) + 1;
        if (failure.failureClass !== "INFRA")
          failureFingerprints.set(fingerprint, stagnationCount);
        const baseAdvice = retryAdvice(failure);
        const advice =
          stagnationCount >= 2 && failure.failureClass !== "INFRA"
            ? `${baseAdvice} This exact plan/failure fingerprint has repeated ${stagnationCount} times; do not submit the unchanged plan again. Inspect the diagnostic evidence and materially change strategy.`
            : baseAdvice;
        appendV2RevisionEntry(workRoot, {
          attempt,
          planSha,
          status: "rejected",
          failureClass: failure.failureClass,
          ruleOrPart: failure.ruleOrPart,
          message: failure.message,
          stagnationCount,
        });
        log("warn", "agent_v2.artifact_build_rejected", {
          jobId: input.jobId,
          kind: input.kind,
          attempt,
          planSha,
          stagnationCount,
          ...failure,
        });
        return await buildFailureToolOutput({
          jobId: input.jobId,
          kind: input.kind,
          attempt,
          failureClass: failure.failureClass,
          ruleOrPart: failure.ruleOrPart,
          message: failure.message,
          retryAdvice: advice,
          planSha,
          stagnationCount,
          ...(failure.diagnosticPath
            ? { diagnosticPath: failure.diagnosticPath }
            : {}),
        });
      }
'''
new_runtime, count = pattern.subn(replacement, runtime, count=1)
assert count == 1, f'artifact build block replacement count={count}'
runtime = new_runtime

attachments_anchor = '''  attachments.forEach((attachment, index) => {\n    manifestEntries[`inputs/${safeWorkspaceName(attachment.name, index)}`] = localFile({\n      src: attachment.path,\n    });\n  });\n\n'''
recovery_block = '''  for (const recoveryFile of listV2RecoveryFiles(workRoot))\n    manifestEntries[recoveryFile.workspacePath] = localFile({\n      src: recoveryFile.hostPath,\n    });\n\n'''
if recovery_block not in runtime:
    assert attachments_anchor in runtime, 'attachments manifest anchor missing'
    runtime = runtime.replace(attachments_anchor, attachments_anchor + recovery_block, 1)

config_old = '''  const sandboxRuntime = createV2SandboxRuntime(input.jobId);\n  const mcpRuntime = createV2McpRuntime(input.config);\n  const mcpServers = mcpRuntime.servers;\n'''
config_new = '''  let sandboxRuntime: ReturnType<typeof createV2SandboxRuntime>;\n  let mcpRuntime: ReturnType<typeof createV2McpRuntime>;\n  try {\n    sandboxRuntime = createV2SandboxRuntime(input.jobId);\n    mcpRuntime = createV2McpRuntime(input.config);\n  } catch (error) {\n    throw new ArtifactPipelineError(\n      "INFRA",\n      `Agent Díaz V2 configuration error: ${error instanceof Error ? error.message : String(error)}`,\n      { ruleOrPart: "agent-v2-configuration", cause: error },\n    );\n  }\n  const mcpServers = mcpRuntime.servers;\n'''
if config_new not in runtime:
    assert config_old in runtime, 'sandbox/MCP creation anchor missing'
    runtime = runtime.replace(config_old, config_new, 1)

connect_old = '    await connectV2McpServers(mcpRuntime, input.jobId);\n'
connect_new = '''    try {\n      await connectV2McpServers(mcpRuntime, input.jobId);\n    } catch (error) {\n      throw new ArtifactPipelineError(\n        "INFRA",\n        `Agent Díaz V2 MCP connection failed: ${error instanceof Error ? error.message : String(error)}`,\n        { ruleOrPart: "agent-v2-mcp-connect", cause: error },\n      );\n    }\n'''
if connect_new not in runtime:
    assert connect_old in runtime, 'MCP connect anchor missing'
    runtime = runtime.replace(connect_old, connect_new, 1)

receipt_anchor = '      acceptance: "explicit-validated-build",\n'
if 'recovery: "revision-ledger"' not in runtime:
    assert receipt_anchor in runtime, 'receipt anchor missing'
    runtime = runtime.replace(
        receipt_anchor,
        receipt_anchor + '      recovery: "revision-ledger",\n      diagnostics: "model-readable-file-output",\n',
        1,
    )

runtime_path.write_text(runtime)

# Patch openai-agent so permanent V2 configuration problems are observable but are
# not rescheduled forever by the legacy infrastructure retry timer.
agent_path = ROOT / 'src/server/openai-agent.ts'
agent = agent_path.read_text()
old = '''        if (blocked && this.config.NODE_ENV !== "test") {\n          const state = this.db.getArtifactRunState(jobId);\n'''
new = '''        if (\n          blocked &&\n          e.ruleOrPart !== "agent-v2-configuration" &&\n          this.config.NODE_ENV !== "test"\n        ) {\n          const state = this.db.getArtifactRunState(jobId);\n          if (!state) return;\n'''
if new not in agent:
    assert old in agent, 'artifact blocked retry anchor missing'
    agent = agent.replace(old, new, 1)
agent_path.write_text(agent)

# Patch index.ts with liveness/readiness separation and non-secret V2 status.
index_path = ROOT / 'src/server/index.ts'
index = index_path.read_text()
import_anchor = 'import { log } from "./log.js";\n'
readiness_import = 'import { inspectV2RuntimeReadiness } from "./v2/runtime-readiness.js";\n'
if readiness_import not in index:
    assert import_anchor in index, 'index log import anchor missing'
    index = index.replace(import_anchor, import_anchor + readiness_import, 1)

meta_anchor = 'const exactDependencyVersion = (name: string) => String(packageMeta.dependencies?.[name] ?? "unknown").replace(/^[^0-9]*/, "");\n'
if 'const agentRuntimeReadiness = inspectV2RuntimeReadiness' not in index:
    assert meta_anchor in index, 'index metadata anchor missing'
    index = index.replace(
        meta_anchor,
        meta_anchor + 'const agentRuntimeReadiness = inspectV2RuntimeReadiness(process.env);\n',
        1,
    )

routes_old = 'app.get("/healthz", (_req, res) => res.json({ ok: true }));\napp.get("/version", (_req, res) => res.json({ buildSha: process.env.RENDER_GIT_COMMIT?.trim() || "unknown", packageVersion: packageMeta.version, pptxgenjs: exactDependencyVersion("pptxgenjs"), validator: exactDependencyVersion("@xarsh/ooxml-validator") }));\n'
routes_new = '''app.get("/healthz", (_req, res) => res.json({ ok: true }));\napp.get("/readyz", (_req, res) =>\n  res.status(agentRuntimeReadiness.ready ? 200 : 503).json(agentRuntimeReadiness),\n);\napp.get("/version", (_req, res) =>\n  res.json({\n    buildSha: process.env.RENDER_GIT_COMMIT?.trim() || "unknown",\n    packageVersion: packageMeta.version,\n    pptxgenjs: exactDependencyVersion("pptxgenjs"),\n    validator: exactDependencyVersion("@xarsh/ooxml-validator"),\n    agentsSdk: exactDependencyVersion("@openai/agents"),\n    agentRuntime: agentRuntimeReadiness.runtime,\n    agentReady: agentRuntimeReadiness.ready,\n    sandboxProvider: agentRuntimeReadiness.sandboxProvider,\n    mcpServerCount: agentRuntimeReadiness.mcpServerCount,\n  }),\n);\n'''
if routes_new not in index:
    assert routes_old in index, 'health/version route anchor missing'
    index = index.replace(routes_old, routes_new, 1)

listen_old = '  log("info", "server.started", { port: config.PORT, env: config.NODE_ENV });\n'
listen_new = '''  log("info", "server.started", {\n    port: config.PORT,\n    env: config.NODE_ENV,\n    agentRuntimeReadiness,\n  });\n'''
if listen_new not in index:
    assert listen_old in index, 'server.started anchor missing'
    index = index.replace(listen_old, listen_new, 1)
index_path.write_text(index)

# Replace V2 contract test with expanded final-runtime coverage.
write('src/server/__tests__/agent-v2-runtime.test.ts', r'''import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyV2BuildFailure,
  v2ArtifactAgentInstructions,
} from "../v2/artifact-agent-runtime.js";
import { buildFailureToolOutput } from "../v2/diagnostic-evidence.js";
import {
  assertV2McpEnvironmentSafe,
  parseV2McpDefinitions,
} from "../v2/mcp-runtime.js";
import {
  appendV2RevisionEntry,
  listV2RecoveryFiles,
  writeV2AttemptPlan,
} from "../v2/revision-ledger.js";
import { inspectV2RuntimeReadiness } from "../v2/runtime-readiness.js";
import {
  assertV2SandboxProviderReady,
  resolveV2SandboxProvider,
} from "../v2/sandbox-runtime.js";
import { ArtifactPipelineError } from "../artifact-quality.js";

describe("Agent Díaz v2 artifact runtime contract", () => {
  it("requires iterative validation, diagnostic inspection, recovery, and explicit acceptance", () => {
    const instructions = v2ArtifactAgentInstructions("presentation");
    expect(instructions).toContain("build_and_validate_artifact");
    expect(instructions).toContain("accept_validated_artifact");
    expect(instructions).toContain("Continue until a build returns ok:true");
    expect(instructions).toContain("avoid rigid text stuffing");
    expect(instructions).toContain("There is no arbitrary two-repair or six-call ceiling");
    expect(instructions).toContain("recovery/REVISION_HISTORY.jsonl");
    expect(instructions).toContain("stagnationCount");
    expect(instructions).toContain("rendered diagnostic PDF");
  });

  it("preserves deterministic failure classes for agent revision", () => {
    const failure = classifyV2BuildFailure(
      new ArtifactPipelineError("BUILD", "Text overflow in slide 4", {
        ruleOrPart: "presentation-text-fit",
      }),
    );
    expect(failure).toMatchObject({
      failureClass: "BUILD",
      ruleOrPart: "presentation-text-fit",
      message: "Text overflow in slide 4",
    });
  });

  it("treats provider/network errors as infrastructure rather than content defects", () => {
    const failure = classifyV2BuildFailure(
      new Error("provider returned 503 server error"),
    );
    expect(failure.failureClass).toBe("INFRA");
    expect(failure.ruleOrPart).toBe("agent-v2-infrastructure");
  });

  it("accepts multiple filtered HTTP and stdio MCP servers", () => {
    const definitions = parseV2McpDefinitions(
      JSON.stringify([
        {
          transport: "http",
          name: "Research MCP",
          url: "https://example.com/mcp",
          authorizationEnv: "RESEARCH_MCP_AUTH",
          allowedTools: ["search", "fetch"],
        },
        {
          transport: "stdio",
          name: "Filesystem MCP",
          fullCommand: "npx -y @modelcontextprotocol/server-filesystem /workspace",
          blockedTools: ["delete_file"],
        },
        {
          transport: "stdio",
          name: "Playwright MCP",
          fullCommand: "npx -y @playwright/mcp@latest --headless",
        },
      ]),
    );
    expect(definitions).toHaveLength(3);
    expect(definitions[0]?.allowedTools).toEqual(["search", "fetch"]);
    expect(definitions.map((item) => item.transport)).toEqual([
      "http",
      "stdio",
      "stdio",
    ]);
  });

  it("rejects duplicate MCP server names before starting an agent run", () => {
    expect(() =>
      parseV2McpDefinitions(
        JSON.stringify([
          {
            transport: "http",
            name: "tools",
            url: "https://example.com/mcp",
          },
          {
            transport: "stdio",
            name: "TOOLS",
            fullCommand: "node server.js",
          },
        ]),
      ),
    ).toThrow(/Duplicate MCP server name/);
  });

  it("refuses host-level stdio MCP in production unless explicitly reviewed", () => {
    const definitions = parseV2McpDefinitions(
      JSON.stringify([
        {
          transport: "stdio",
          name: "Playwright MCP",
          fullCommand: "npx @playwright/mcp@latest --headless",
        },
      ]),
    );
    expect(() =>
      assertV2McpEnvironmentSafe(definitions, { NODE_ENV: "production" }),
    ).toThrow(/refuses host-level stdio MCP processes/);
    expect(() =>
      assertV2McpEnvironmentSafe(definitions, {
        NODE_ENV: "production",
        AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION: "true",
      }),
    ).not.toThrow();
  });

  it("prefers the hosted Cloudflare sandbox whenever a bridge URL is configured", () => {
    expect(
      resolveV2SandboxProvider({
        CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.workers.dev",
      }),
    ).toBe("cloudflare");
  });

  it("fails closed instead of silently giving the production agent a host shell", () => {
    expect(() =>
      assertV2SandboxProviderReady("unix", { NODE_ENV: "production" }),
    ).toThrow(/refuses Unix-local shell execution in production/);
    expect(() =>
      assertV2SandboxProviderReady("unix", {
        NODE_ENV: "production",
        AGENT_SANDBOX_ALLOW_UNSAFE_UNIX: "true",
      }),
    ).not.toThrow();
  });

  it("supports explicit Docker and Unix sandbox selection", () => {
    expect(resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "docker" })).toBe(
      "docker",
    );
    expect(resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "unix" })).toBe(
      "unix",
    );
    expect(() =>
      resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "spaceship" }),
    ).toThrow(/cloudflare, docker, or unix/);
  });

  it("reports deployment readiness without exposing secrets", () => {
    const blocked = inspectV2RuntimeReadiness({
      NODE_ENV: "production",
      AGENT_RUNTIME: "v2",
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.issues.join(" ")).toMatch(/Unix-local/);

    const ready = inspectV2RuntimeReadiness({
      NODE_ENV: "production",
      AGENT_RUNTIME: "v2",
      CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.workers.dev",
      CLOUDFLARE_SANDBOX_API_KEY: "super-secret-value",
    });
    expect(ready.ready).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("super-secret-value");
  });

  it("returns failed artifact bytes to the model as diagnostic file output", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-v2-test-"));
    try {
      const diagnostic = path.join(temp, "failed.zip");
      fs.writeFileSync(diagnostic, Buffer.from("PK-test-diagnostic"));
      const output = await buildFailureToolOutput({
        jobId: "job-test",
        kind: "website",
        attempt: 2,
        failureClass: "BUILD",
        ruleOrPart: "website-validation",
        message: "Website validation failed",
        retryAdvice: "Inspect and revise",
        planSha: "abc123",
        stagnationCount: 1,
        diagnosticPath: diagnostic,
      });
      expect(output[0]).toMatchObject({ type: "text" });
      expect(output.some((item) => item.type === "file")).toBe(true);
      expect(String(output[0]?.text)).not.toContain(temp);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("persists revision history and the latest plan for process-restart recovery", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-v2-recovery-"));
    try {
      const attempt = writeV2AttemptPlan(temp, 3, {
        title: "Recovered plan",
        sections: [],
      });
      appendV2RevisionEntry(temp, {
        attempt: 3,
        planSha: attempt.planSha,
        status: "rejected",
        failureClass: "BUILD",
        ruleOrPart: "presentation-text-fit",
        message: "overflow",
        stagnationCount: 1,
      });
      const files = listV2RecoveryFiles(temp);
      expect(files.map((item) => item.workspacePath).sort()).toEqual([
        "recovery/LATEST_PLAN.json",
        "recovery/REVISION_HISTORY.jsonl",
      ]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
''')

# Add deployment/readiness documentation to architecture doc exactly once.
arch_path = ROOT / 'AGENT_DIAZ_V2_ARCHITECTURE.md'
arch = arch_path.read_text()
marker = '## Final production-readiness contract'
if marker not in arch:
    arch += r'''

## Final production-readiness contract

V2 now separates liveness from agent readiness:

- `GET /healthz` answers whether the web process is alive.
- `GET /readyz` answers whether the selected V2 sandbox/MCP configuration is safe enough to start artifact work. It returns HTTP 503 when the agent runtime is not deployable.
- `GET /version` exposes only non-secret runtime metadata: Agents SDK version, selected runtime, sandbox provider, readiness flag, and MCP server count.

Production fails closed for agent shell execution. Unix-local is accepted for development, but production requires a hosted Cloudflare sandbox or an explicitly selected Docker sandbox unless `AGENT_SANDBOX_ALLOW_UNSAFE_UNIX=true` is deliberately set as an emergency override.

Stdio MCP servers are likewise development-friendly but execute on the application host. Production therefore prefers Streamable HTTP MCP and rejects stdio by default unless `AGENT_MCP_ALLOW_STDIO_IN_PRODUCTION=true` is deliberately enabled. `MCP_SERVERS_JSON` supports per-server `allowedTools` and `blockedTools` filters.

Every rejected build now returns model-readable diagnostic evidence. When available, the exact preserved failed artifact is attached as a function-tool file output; PPTX/DOCX failures also receive a LibreOffice-rendered diagnostic PDF when conversion succeeds. Host filesystem diagnostic paths are never relied on as the model's evidence channel.

Every V2 attempt persists its complete ArtifactPlan plus an append-only `REVISION_HISTORY.jsonl`. If the app process restarts before completion, the latest plan and revision ledger are materialized into `recovery/` in the new sandbox so the agent can resume from the last known strategy instead of blindly restarting. Repeated identical non-infrastructure failures produce a `stagnationCount` and explicit instruction to change strategy rather than dead-horse the same plan.
'''
    arch_path.write_text(arch)

print('Agent Díaz V2 finalization patch applied successfully')
