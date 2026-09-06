import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function withStdio(command, args, fn) {
  const client = new Client({ name: "agent-diaz-sandbox-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({ command, args });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

fs.mkdirSync("/workspace/mcp-smoke", { recursive: true });
const marker = `mcp-shared-workspace-${Date.now()}`;
const textPath = "/workspace/mcp-smoke/shared.txt";
const htmlPath = "/workspace/mcp-smoke/shared.html";
fs.writeFileSync(textPath, marker, "utf8");
fs.writeFileSync(
  htmlPath,
  `<!doctype html><meta charset="utf-8"><title>${marker}</title><h1>${marker}</h1>`,
  "utf8",
);

await withStdio(
  "/bin/sh",
  ["-lc", "cd /workspace && exec mcp-server-filesystem /workspace"],
  async (client) => {
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "read_text_file"))
      throw new Error("Filesystem MCP did not expose read_text_file");
    const result = await client.callTool({
      name: "read_text_file",
      arguments: { path: textPath },
    });
    if (!JSON.stringify(result).includes(marker))
      throw new Error("Filesystem MCP could not read the canonical /workspace file");
  },
);

await withStdio(
  "/bin/sh",
  [
    "-lc",
    "cd /workspace && exec playwright-mcp --headless --browser chromium --executable-path /usr/bin/chromium --no-sandbox --allow-unrestricted-file-access --image-responses omit",
  ],
  async (client) => {
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "browser_navigate"))
      throw new Error("Playwright MCP did not expose browser_navigate");
    const result = await client.callTool({
      name: "browser_navigate",
      arguments: { url: `file://${htmlPath}` },
    });
    if (!JSON.stringify(result).includes(marker))
      throw new Error("Playwright MCP could not render the canonical /workspace file");
  },
);

console.log("AGENT_DIAZ_MCP_SHARED_WORKSPACE_OK");
