import { describe, expect, it } from "vitest";
import {
  classifyV2BuildFailure,
  v2ArtifactAgentInstructions,
} from "../v2/artifact-agent-runtime.js";
import { parseV2McpDefinitions } from "../v2/mcp-runtime.js";
import { ArtifactPipelineError } from "../artifact-quality.js";

describe("Agent Díaz v2 artifact runtime contract", () => {
  it("requires iterative validation and explicit acceptance", () => {
    const instructions = v2ArtifactAgentInstructions("presentation");
    expect(instructions).toContain("build_and_validate_artifact");
    expect(instructions).toContain("accept_validated_artifact");
    expect(instructions).toContain("Continue until a build returns ok:true");
    expect(instructions).toContain("avoid rigid text stuffing");
    expect(instructions).toContain("There is no arbitrary two-repair or six-call ceiling");
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

  it("accepts multiple HTTP and stdio MCP servers", () => {
    const definitions = parseV2McpDefinitions(
      JSON.stringify([
        {
          transport: "http",
          name: "Research MCP",
          url: "https://example.com/mcp",
          authorizationEnv: "RESEARCH_MCP_AUTH",
        },
        {
          transport: "stdio",
          name: "Filesystem MCP",
          fullCommand: "npx -y @modelcontextprotocol/server-filesystem /workspace",
        },
        {
          transport: "stdio",
          name: "Playwright MCP",
          fullCommand: "npx -y @playwright/mcp@latest --headless",
        },
      ]),
    );
    expect(definitions).toHaveLength(3);
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
});
