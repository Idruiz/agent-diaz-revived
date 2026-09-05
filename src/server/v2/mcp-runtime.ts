import {
  MCPServerStdio,
  MCPServerStreamableHttp,
} from "@openai/agents";
import { z } from "zod";
import type { Config } from "../config.js";
import { log } from "../log.js";

const HttpMcpSchema = z.object({
  transport: z.literal("http"),
  name: z.string().min(1).max(80),
  url: z.string().url(),
  authorizationEnv: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
});

const StdioMcpSchema = z.object({
  transport: z.literal("stdio"),
  name: z.string().min(1).max(80),
  fullCommand: z.string().min(1).max(2_000),
});

const McpDefinitionSchema = z.discriminatedUnion("transport", [
  HttpMcpSchema,
  StdioMcpSchema,
]);

const McpDefinitionsSchema = z.array(McpDefinitionSchema).max(12);

export type V2McpServer = MCPServerStreamableHttp | MCPServerStdio;

export interface V2McpRuntime {
  servers: V2McpServer[];
  descriptions: Array<{
    name: string;
    transport: "http" | "stdio";
  }>;
}

function uniqueDefinitions(
  definitions: z.infer<typeof McpDefinitionsSchema>,
): z.infer<typeof McpDefinitionsSchema> {
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
): z.infer<typeof McpDefinitionsSchema> {
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

export function createV2McpRuntime(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): V2McpRuntime {
  const definitions = parseV2McpDefinitions(env.MCP_SERVERS_JSON);

  // Preserve the existing single Streamable-HTTP MCP configuration. If a JSON
  // multi-server configuration is supplied, it is additive unless it repeats
  // the same server name.
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

  const servers: V2McpServer[] = [];
  const descriptions: V2McpRuntime["descriptions"] = [];
  for (const definition of definitions) {
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
