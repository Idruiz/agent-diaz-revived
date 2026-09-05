from pathlib import Path

runtime = Path("src/server/v2/artifact-agent-runtime.ts")
text = runtime.read_text()

text = text.replace(
    'import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";\n',
    '',
    1,
)
anchor = '''import {\n  closeV2McpServers,\n  connectV2McpServers,\n  createV2McpRuntime,\n} from "./mcp-runtime.js";\n'''
addition = '''import { createV2SandboxRuntime } from "./sandbox-runtime.js";\n'''
if addition not in text:
    assert anchor in text, "sandbox import anchor missing"
    text = text.replace(anchor, anchor + addition, 1)

old_grants = '''  const grantedPaths = [\n    ...new Set(attachments.map((attachment) => path.dirname(attachment.path))),\n  ].map((grantedPath) => ({\n    path: grantedPath,\n    readOnly: true,\n    description: "Agent Díaz V2 uploaded input source",\n  }));\n\n  const manifest = new Manifest({\n    entries: manifestEntries,\n    ...(grantedPaths.length ? { extraPathGrants: grantedPaths } : {}),\n  });\n\n  const mcpRuntime = createV2McpRuntime(input.config);\n'''
new_grants = '''  // localFile() materializes only the explicitly attached file into the sandbox.\n  // Do not grant the agent its host upload directory: hosted/Docker sandboxes do\n  // not need it, and Unix-local should not receive broader host filesystem access.\n  const manifest = new Manifest({\n    root: "/workspace",\n    entries: manifestEntries,\n  });\n\n  const sandboxRuntime = createV2SandboxRuntime(input.jobId);\n  const mcpRuntime = createV2McpRuntime(input.config);\n'''
if old_grants in text:
    text = text.replace(old_grants, new_grants, 1)
elif new_grants not in text:
    raise RuntimeError("manifest/grants anchor missing")

text = text.replace(
    '      mcpServers: mcpRuntime.descriptions,\n    });',
    '      mcpServers: mcpRuntime.descriptions,\n      sandboxProvider: sandboxRuntime.provider,\n    });',
    1,
)
text = text.replace(
    '          client: new UnixLocalSandboxClient(),',
    '          client: sandboxRuntime.client,',
    1,
)
text = text.replace(
    '          concurrencyLimits: {\n            manifestEntries: 4,\n            localDirFiles: 12,\n          },',
    '          concurrencyLimits: {\n            manifestEntries: 4,\n            localDirFiles: 12,\n          },\n          archiveLimits: {},',
    1,
)
text = text.replace(
    '      sandbox: "unix-local",',
    '      sandbox: sandboxRuntime.provider,',
    1,
)
runtime.write_text(text)

# Extend the V2 contract tests without replacing their existing coverage.
test = Path("src/server/__tests__/agent-v2-runtime.test.ts")
t = test.read_text()
import_anchor = 'import { parseV2McpDefinitions } from "../v2/mcp-runtime.js";\n'
import_line = 'import { resolveV2SandboxProvider } from "../v2/sandbox-runtime.js";\n'
if import_line not in t:
    assert import_anchor in t, "sandbox test import anchor missing"
    t = t.replace(import_anchor, import_anchor + import_line, 1)

end = '\n});\n'
extra = '''\n\n  it("prefers the hosted Cloudflare sandbox whenever a bridge URL is configured", () => {\n    expect(\n      resolveV2SandboxProvider({\n        CLOUDFLARE_SANDBOX_WORKER_URL: "https://sandbox.example.workers.dev",\n      }),\n    ).toBe("cloudflare");\n  });\n\n  it("supports explicit Docker and Unix sandbox selection", () => {\n    expect(resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "docker" })).toBe(\n      "docker",\n    );\n    expect(resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "unix" })).toBe(\n      "unix",\n    );\n    expect(() =>\n      resolveV2SandboxProvider({ AGENT_SANDBOX_PROVIDER: "spaceship" }),\n    ).toThrow(/cloudflare, docker, or unix/);\n  });'''
if 'prefers the hosted Cloudflare sandbox' not in t:
    assert t.endswith(end), "test suite end anchor missing"
    t = t[:-len(end)] + extra + end

test.write_text(t)
print("hosted sandbox patch applied")
