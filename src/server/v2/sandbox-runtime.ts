import crypto from "node:crypto";
import { CloudflareSandboxClient } from "@openai/agents-extensions/sandbox/cloudflare";
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

export interface V2SandboxSessionLike {
  state: Record<string, any>;
  execCommand(args: {
    cmd: string;
    workdir?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }): Promise<string>;
  close?: () => Promise<void>;
}

export const V2_WORKSPACE_ROOT = "/workspace";
export const V2_PERSIST_MOUNT = "/workspace/persist";

function enabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function validR2BindingName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
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
  if (provider === "cloudflare") {
    if (!env.CLOUDFLARE_SANDBOX_WORKER_URL?.trim())
      throw new Error(
        "AGENT_SANDBOX_PROVIDER=cloudflare requires CLOUDFLARE_SANDBOX_WORKER_URL",
      );
    const binding = env.CLOUDFLARE_SANDBOX_R2_BINDING?.trim();
    if (binding && !validR2BindingName(binding))
      throw new Error(
        "CLOUDFLARE_SANDBOX_R2_BINDING must be a valid Worker binding identifier",
      );
    if (env.NODE_ENV === "production") {
      if (!env.CLOUDFLARE_SANDBOX_API_KEY?.trim())
        throw new Error(
          "Production Cloudflare sandbox requires CLOUDFLARE_SANDBOX_API_KEY so the bridge is not exposed without authentication.",
        );
      if (!binding)
        throw new Error(
          "Production Cloudflare sandbox requires CLOUDFLARE_SANDBOX_R2_BINDING so /workspace/persist is backed by durable R2 storage.",
        );
    }
  }
  if (
    provider === "unix" &&
    env.NODE_ENV === "production" &&
    !enabled(env.AGENT_SANDBOX_ALLOW_UNSAFE_UNIX)
  )
    throw new Error(
      "Agent Díaz V2 refuses Unix-local shell execution in production. Configure CLOUDFLARE_SANDBOX_WORKER_URL, select AGENT_SANDBOX_PROVIDER=docker, or explicitly set AGENT_SANDBOX_ALLOW_UNSAFE_UNIX=true for an emergency override.",
    );
}

async function mountCloudflareR2Binding(
  session: V2SandboxSessionLike,
  jobId: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const binding = env.CLOUDFLARE_SANDBOX_R2_BINDING?.trim();
  if (!binding) return false;

  const sandboxId = String(session.state?.sandboxId ?? "").trim();
  const workerUrl = env.CLOUDFLARE_SANDBOX_WORKER_URL?.trim();
  if (!sandboxId || !workerUrl)
    throw new Error(
      "Cloudflare sandbox session is missing the bridge URL or sandbox ID required for the R2 binding mount.",
    );

  const mountUrl = new URL(
    `/v1/sandbox/${encodeURIComponent(sandboxId)}/mount`,
    workerUrl.endsWith("/") ? workerUrl : `${workerUrl}/`,
  );
  const headers = new Headers({ "Content-Type": "application/json" });
  if (env.CLOUDFLARE_SANDBOX_API_KEY?.trim())
    headers.set(
      "Authorization",
      `Bearer ${env.CLOUDFLARE_SANDBOX_API_KEY.trim()}`,
    );

  const response = await fetch(mountUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      bucket: binding,
      mountPath: V2_PERSIST_MOUNT,
      options: {
        readOnly: false,
        prefix: `agent-diaz-v2/${jobId}/`,
      },
    }),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 2_000);
    throw new Error(
      `Cloudflare R2 binding mount failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
    );
  }
  return true;
}

async function runFilesystemSentinel(
  session: V2SandboxSessionLike,
  targetDir: string,
  label: string,
): Promise<void> {
  const token = crypto.randomUUID().replaceAll("-", "");
  const marker = `__AGENT_DIAZ_POSIX_OK_${token}__`;
  const command = [
    "set -eu",
    `mkdir -p ${targetDir}`,
    `printf '%s' '${token}' > ${targetDir}/.diaz-fs-${token}.tmp`,
    `mv ${targetDir}/.diaz-fs-${token}.tmp ${targetDir}/.diaz-fs-${token}.renamed`,
    `test \"$(cat ${targetDir}/.diaz-fs-${token}.renamed)\" = '${token}'`,
    `rm ${targetDir}/.diaz-fs-${token}.renamed`,
    `printf '%s' '${marker}'`,
  ].join(" && ");
  const output = await session.execCommand({
    cmd: command,
    workdir: V2_WORKSPACE_ROOT,
    maxOutputTokens: 2_000,
  });
  if (!output.includes(marker))
    throw new Error(
      `Agent Díaz V2 ${label} filesystem sentinel did not complete create/rename/read/delete semantics.`,
    );
}

async function runCloudflareToolchainSentinel(
  session: V2SandboxSessionLike,
): Promise<void> {
  const marker = "__AGENT_DIAZ_BROWSER_TOOLCHAIN_OK__";
  const command = [
    "set -eu",
    "command -v node >/dev/null",
    "command -v chromium >/dev/null || command -v chromium-browser >/dev/null",
    "command -v playwright-mcp >/dev/null",
    "command -v chrome-devtools-mcp >/dev/null",
    "command -v mcp-server-filesystem >/dev/null",
    "test -f /opt/agent-diaz-tools/node_modules/puppeteer-core/package.json",
    `printf '%s' '${marker}'`,
  ].join(" && ");
  const output = await session.execCommand({
    cmd: command,
    workdir: V2_WORKSPACE_ROOT,
    maxOutputTokens: 2_000,
  });
  if (!output.includes(marker))
    throw new Error(
      "Cloudflare sandbox image is missing the Agent Díaz browser/MCP toolchain (Chromium, Playwright MCP, Chrome DevTools MCP, filesystem MCP, or Puppeteer).",
    );
}

export async function preflightV2CloudflareSession(args: {
  session: V2SandboxSessionLike;
  jobId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = args.env ?? process.env;
  const mounted = await mountCloudflareR2Binding(args.session, args.jobId, env);
  await runFilesystemSentinel(args.session, V2_WORKSPACE_ROOT, "workspace");
  if (mounted)
    await runFilesystemSentinel(
      args.session,
      V2_PERSIST_MOUNT,
      "persistent R2 mount",
    );
  await runCloudflareToolchainSentinel(args.session);

  log("info", "agent_v2.sandbox_preflight_passed", {
    jobId: args.jobId,
    provider: "cloudflare",
    workspace: V2_WORKSPACE_ROOT,
    persistentMount: mounted ? V2_PERSIST_MOUNT : null,
    browserToolchain: "verified",
  });
}

function attachAgentDiazCloudflarePreflight(
  client: CloudflareSandboxClient,
  jobId: string,
  env: NodeJS.ProcessEnv,
): CloudflareSandboxClient {
  // CloudflareSandboxClient.create has overloads. Wrapping the instance method
  // and casting the replacement back to the exact overloaded member type keeps
  // the SDK contract intact while ensuring every session is preflighted.
  const originalCreate = client.create.bind(client) as (
    ...args: unknown[]
  ) => Promise<V2SandboxSessionLike>;

  client.create = (async (...args: unknown[]) => {
    const session = await originalCreate(...args);
    try {
      await preflightV2CloudflareSession({ session, jobId, env });
      return session;
    } catch (error) {
      await session.close?.().catch(() => {});
      throw error;
    }
  }) as CloudflareSandboxClient["create"];

  return client;
}

export function createV2SandboxRuntime(
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): V2SandboxRuntime {
  const provider = resolveV2SandboxProvider(env);
  assertV2SandboxProviderReady(provider, env);

  if (provider === "cloudflare") {
    const workerUrl = env.CLOUDFLARE_SANDBOX_WORKER_URL!.trim();
    const client = attachAgentDiazCloudflarePreflight(
      new CloudflareSandboxClient({
        workerUrl,
        ...(env.CLOUDFLARE_SANDBOX_API_KEY
          ? { apiKey: env.CLOUDFLARE_SANDBOX_API_KEY }
          : {}),
        timeoutMs: 120_000,
        createTimeoutMs: 120_000,
        requestTimeoutMs: 120_000,
        archiveLimits: {},
      }),
      jobId,
      env,
    );
    log("info", "agent_v2.sandbox_selected", {
      jobId,
      provider,
      hosted: true,
      canonicalWorkspace: V2_WORKSPACE_ROOT,
      persistentMount: env.CLOUDFLARE_SANDBOX_R2_BINDING
        ? V2_PERSIST_MOUNT
        : null,
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
