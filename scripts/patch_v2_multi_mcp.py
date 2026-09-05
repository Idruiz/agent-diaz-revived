from pathlib import Path

p = Path("src/server/v2/artifact-agent-runtime.ts")
text = p.read_text()

text = text.replace(
    'import {\n  MCPServerStreamableHttp,\n  codeInterpreterTool,',
    'import {\n  codeInterpreterTool,',
    1,
)

anchor = 'import { log } from "../log.js";\n'
addition = '''import {\n  closeV2McpServers,\n  connectV2McpServers,\n  createV2McpRuntime,\n} from "./mcp-runtime.js";\n'''
if addition not in text:
    assert anchor in text, "mcp import anchor missing"
    text = text.replace(anchor, anchor + addition, 1)

old = '''  const mcpServers: MCPServerStreamableHttp[] = [];\n  let configuredMcp: MCPServerStreamableHttp | null = null;\n  if (input.config.MCP_SERVER_URL) {\n    configuredMcp = new MCPServerStreamableHttp({\n      url: input.config.MCP_SERVER_URL,\n      name: input.config.MCP_SERVER_LABEL,\n      cacheToolsList: true,\n      timeout: 60_000,\n      ...(input.config.MCP_AUTHORIZATION\n        ? {\n            requestInit: {\n              headers: { Authorization: input.config.MCP_AUTHORIZATION },\n            },\n          }\n        : {}),\n    });\n    mcpServers.push(configuredMcp);\n  }\n'''
new = '''  const mcpRuntime = createV2McpRuntime(input.config);\n  const mcpServers = mcpRuntime.servers;\n'''
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise RuntimeError("MCP server block anchor missing")

text = text.replace(
    '    if (configuredMcp) await configuredMcp.connect();',
    '    await connectV2McpServers(mcpRuntime, input.jobId);',
    1,
)
text = text.replace(
    '      mcpEnabled: Boolean(configuredMcp),',
    '      mcpEnabled: mcpServers.length > 0,\n      mcpServers: mcpRuntime.descriptions,',
    1,
)
text = text.replace(
    '      mcp: configuredMcp ? "streamable-http" : "disabled",',
    '      mcp: mcpRuntime.descriptions,',
    1,
)
old_finally = '''  } finally {\n    if (configuredMcp) {\n      try {\n        await configuredMcp.close();\n      } catch (error) {\n        log("warn", "agent_v2.mcp_close_failed", {\n          jobId: input.jobId,\n          error: error instanceof Error ? error.message : String(error),\n        });\n      }\n    }\n  }\n}'''
new_finally = '''  } finally {\n    await closeV2McpServers(mcpRuntime, input.jobId);\n  }\n}'''
if old_finally in text:
    text = text.replace(old_finally, new_finally, 1)
elif new_finally not in text:
    raise RuntimeError("MCP cleanup block anchor missing")

p.write_text(text)
print("multi-MCP patch applied")
