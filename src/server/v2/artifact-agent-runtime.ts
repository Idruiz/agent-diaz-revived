import fs from "node:fs";
import path from "node:path";
import {
  MCPServerStreamableHttp,
  codeInterpreterTool,
  run,
  tool,
  webSearchTool,
} from "@openai/agents";
import {
  Manifest,
  SandboxAgent,
  file,
  localFile,
} from "@openai/agents/sandbox";
import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  buildArtifact,
  type ArtifactBuildProgress,
  type BuiltFile,
} from "../builders.js";
import {
  ArtifactPipelineError,
  type ArtifactFailureClass,
} from "../artifact-quality.js";
import { log } from "../log.js";
import {
  ArtifactPlanSchema,
  type ArtifactPlan,
  type JobKind,
} from "../../shared/contracts.js";

export interface V2ArtifactAttachment {
  name: string;
  mime: string;
  path: string;
  size: number;
}

export interface V2ArtifactRuntimeInput {
  config: Config;
  jobId: string;
  kind: JobKind;
  prompt: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  attachments?: V2ArtifactAttachment[];
  priorContext?: string;
  signal?: AbortSignal;
  onProgress?: (event: ArtifactBuildProgress) => void;
}

export interface V2ArtifactRuntimeResult {
  file: BuiltFile;
  attempts: number;
  finalOutput: unknown;
}

interface ClassifiedFailure {
  failureClass: ArtifactFailureClass;
  ruleOrPart: string;
  message: string;
  diagnosticPath?: string;
}

const BuildToolResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    buildId: z.string(),
    attempt: z.number().int().positive(),
    name: z.string(),
    mime: z.string(),
    size: z.number().int().nonnegative(),
    validation: z.record(z.string(), z.unknown()),
  }),
  z.object({
    ok: z.literal(false),
    attempt: z.number().int().positive(),
    failureClass: z.enum(["PLAN_CONTENT", "PLAN_NORMALIZABLE", "ASSET", "BUILD", "INFRA"]),
    ruleOrPart: z.string(),
    message: z.string(),
    diagnosticPath: z.string().optional(),
    retryAdvice: z.string(),
  }),
]);

const AcceptToolResultSchema = z.object({
  ok: z.literal(true),
  buildId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
});

function safeWorkspaceName(name: string, index: number): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || `upload_${index + 1}`;
}

export function classifyV2BuildFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ArtifactPipelineError)
    return {
      failureClass: error.failureClass,
      ruleOrPart: error.ruleOrPart,
      message: error.message,
      ...(error.diagnosticPath ? { diagnosticPath: error.diagnosticPath } : {}),
    };

  const message = error instanceof Error ? error.message : String(error);
  if (/(?:rate[_ -]?limit|5\d\d|ECONN|ETIMEDOUT|network|provider unavailable|spawn|ENOENT)/i.test(message))
    return {
      failureClass: "INFRA",
      ruleOrPart: "agent-v2-infrastructure",
      message,
    };
  if (/(?:image|photograph|asset|wikimedia|commons|license)/i.test(message))
    return {
      failureClass: "ASSET",
      ruleOrPart: "agent-v2-asset-resolution",
      message,
    };
  return {
    failureClass: "BUILD",
    ruleOrPart: "agent-v2-build",
    message,
  };
}

export function v2ArtifactAgentInstructions(kind: JobKind): string {
  return [
    `You are Agent Díaz V2, a production artifact engineer responsible for a finished ${kind}.`,
    "You are operating inside a real sandbox workspace with filesystem editing and shell access. Use the workspace actively: keep research notes, a current plan, and revision notes instead of trying to hold the entire job in chat context.",
    "You have web search and code execution. Research factual/current claims when needed; use code execution for uploaded datasets and quantitative work. Never invent evidence or numbers.",
    "If MCP tools are present, use them when they materially improve the task. Treat MCP as an external capability layer, not as a substitute for the sandbox filesystem.",
    "The build_and_validate_artifact tool is the only authority on whether an artifact is technically ready. It runs the real Agent Díaz renderer and deterministic validators.",
    "Work iteratively. Create a complete ArtifactPlan, call build_and_validate_artifact, read the exact failure, revise the plan or retry the infrastructure operation as appropriate, and call the tool again. Do not abandon a valid user requirement to make validation easier.",
    "If failureClass is INFRA, do not rewrite good content merely to dodge infrastructure; retry after doing any useful independent work. If failureClass is ASSET, improve image queries or retry. If failureClass is PLAN_CONTENT or BUILD, revise the plan/layout/content based on the reported rule.",
    "There is no arbitrary two-repair or six-call ceiling in this V2 loop. Continue until a build returns ok:true unless the user cancels or an unrecoverable external dependency makes progress impossible.",
    "A successful build is not final until you call accept_validated_artifact with the exact buildId returned by the successful build. Never claim completion before that acceptance call succeeds.",
    "Preserve explicit user requirements, requested language, audience, pedagogy, visual intent, and requested deliverable type. Finished visible copy must be audience-facing, not production notes or placeholders.",
    "For presentations specifically: avoid rigid text stuffing. Prefer reflow, pagination, shorter visible copy, speaker notes, and responsive visual layouts. Every image must be relevant to its section and every fetched image must be placed or explicitly rejected before acceptance.",
  ].join("\n\n");
}

function validationSummary(file: BuiltFile): Record<string, unknown> {
  const receipt = file.validationReceipt as unknown as Record<string, unknown>;
  return {
    buildSha: receipt.buildSha ?? null,
    artifactSha256: receipt.artifactSha256 ?? null,
    scores: receipt.scores ?? null,
    images: receipt.images ?? null,
    knownBenignFindings: receipt.knownBenignFindings ?? [],
    normalizations: receipt.normalizations ?? [],
  };
}

function retryAdvice(failure: ClassifiedFailure): string {
  switch (failure.failureClass) {
    case "INFRA":
      return "Keep the current good plan. Retry the build/tool operation; do not degrade content to work around infrastructure.";
    case "ASSET":
      return "Revise weak or overly narrow image queries, or retry if the provider failure is transient. Preserve the requested visual coverage.";
    case "PLAN_CONTENT":
      return "Repair the ArtifactPlan so every explicit requirement is represented and structurally valid, then rebuild.";
    default:
      return "Use the reported rule/diagnostic to revise layout or content, then rebuild the complete artifact.";
  }
}

export async function runV2ArtifactRuntime(
  input: V2ArtifactRuntimeInput,
): Promise<V2ArtifactRuntimeResult> {
  const attachments = input.attachments ?? [];
  const workRoot = path.join(
    input.config.artifactDir,
    ".agent-v2",
    input.jobId,
  );
  fs.mkdirSync(workRoot, { recursive: true });

  let attempt = 0;
  let acceptedBuildId: string | null = null;
  const successfulBuilds = new Map<string, BuiltFile>();

  const buildTool = tool({
    name: "build_and_validate_artifact",
    description:
      "Render a complete Agent Díaz artifact candidate and run the real deterministic production validators. On failure, returns the exact failure class/rule so you can revise and try again. On success, returns a buildId that can be accepted.",
    parameters: z.object({
      plan: ArtifactPlanSchema,
    }),
    async execute({ plan }: { plan: ArtifactPlan }) {
      if (input.signal?.aborted) throw new Error("Agent Díaz V2 run cancelled");
      attempt += 1;
      const attemptDir = path.join(workRoot, `attempt-${attempt}`);
      fs.mkdirSync(attemptDir, { recursive: true });
      log("info", "agent_v2.artifact_build_started", {
        jobId: input.jobId,
        kind: input.kind,
        attempt,
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
        log("info", "agent_v2.artifact_build_validated", {
          jobId: input.jobId,
          kind: input.kind,
          attempt,
          buildId,
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
        log("warn", "agent_v2.artifact_build_rejected", {
          jobId: input.jobId,
          kind: input.kind,
          attempt,
          ...failure,
        });
        return {
          ok: false as const,
          attempt,
          failureClass: failure.failureClass,
          ruleOrPart: failure.ruleOrPart,
          message: failure.message,
          ...(failure.diagnosticPath
            ? { diagnosticPath: failure.diagnosticPath }
            : {}),
          retryAdvice: retryAdvice(failure),
        };
      }
    },
  });

  const acceptTool = tool({
    name: "accept_validated_artifact",
    description:
      "Accept one build that already passed build_and_validate_artifact. Call this only with an exact successful buildId. This is the terminal production-readiness gate.",
    parameters: z.object({ buildId: z.string().uuid() }),
    outputSchema: AcceptToolResultSchema,
    async execute({ buildId }) {
      const built = successfulBuilds.get(buildId);
      if (!built)
        throw new Error(
          "That buildId is not a validated build from this run. Build and validate a candidate first.",
        );
      acceptedBuildId = buildId;
      log("info", "agent_v2.artifact_accepted", {
        jobId: input.jobId,
        kind: input.kind,
        attempt,
        buildId,
        name: built.name,
      });
      return {
        ok: true as const,
        buildId,
        name: built.name,
        mime: built.mime,
        size: built.size,
      };
    },
  });

  const manifestEntries: Record<string, any> = {
    "REQUEST.md": file({
      content: [
        `# Agent Díaz V2 task`,
        ``,
        `Artifact kind: ${input.kind}`,
        ``,
        `## Current request`,
        input.prompt,
        input.priorContext
          ? `\n## Prior conversation context (reference only)\n${input.priorContext}`
          : "",
      ].join("\n"),
    }),
  };
  attachments.forEach((attachment, index) => {
    manifestEntries[`inputs/${safeWorkspaceName(attachment.name, index)}`] = localFile({
      src: attachment.path,
    });
  });

  const grantedPaths = [
    ...new Set(attachments.map((attachment) => path.dirname(attachment.path))),
  ].map((grantedPath) => ({
    path: grantedPath,
    readOnly: true,
    description: "Agent Díaz V2 uploaded input source",
  }));

  const manifest = new Manifest({
    entries: manifestEntries,
    ...(grantedPaths.length ? { extraPathGrants: grantedPaths } : {}),
  });

  const mcpServers: MCPServerStreamableHttp[] = [];
  let configuredMcp: MCPServerStreamableHttp | null = null;
  if (input.config.MCP_SERVER_URL) {
    configuredMcp = new MCPServerStreamableHttp({
      url: input.config.MCP_SERVER_URL,
      name: input.config.MCP_SERVER_LABEL,
      cacheToolsList: true,
      timeout: 60_000,
      ...(input.config.MCP_AUTHORIZATION
        ? {
            requestInit: {
              headers: { Authorization: input.config.MCP_AUTHORIZATION },
            },
          }
        : {}),
    });
    mcpServers.push(configuredMcp);
  }

  const agent = new SandboxAgent({
    name: "Agent Díaz V2 Artifact Engineer",
    model: input.model,
    instructions: v2ArtifactAgentInstructions(input.kind),
    defaultManifest: manifest,
    tools: [
      webSearchTool({ searchContextSize: "medium" }),
      codeInterpreterTool(),
      buildTool,
      acceptTool,
    ],
    mcpServers,
    mcpConfig: {
      convertSchemasToStrict: true,
      errorFunction: null,
      includeServerInToolNames: true,
    },
    modelSettings: {
      reasoning: { effort: input.reasoningEffort },
      toolChoice: "required",
    },
    resetToolChoice: false,
    toolUseBehavior: { stopAtToolNames: ["accept_validated_artifact"] },
  });

  try {
    if (configuredMcp) await configuredMcp.connect();
    log("info", "agent_v2.run_started", {
      jobId: input.jobId,
      kind: input.kind,
      model: input.model,
      attachments: attachments.length,
      mcpEnabled: Boolean(configuredMcp),
    });
    const result = await run(
      agent,
      `Open REQUEST.md and complete the ${input.kind} request. Use the workspace, research/code tools as needed, and iterate build_and_validate_artifact until it passes. Finish only by calling accept_validated_artifact.`,
      {
        maxTurns: null,
        signal: input.signal,
        sandbox: {
          client: new UnixLocalSandboxClient(),
          concurrencyLimits: {
            manifestEntries: 4,
            localDirFiles: 12,
          },
        },
      },
    );

    if (!acceptedBuildId)
      throw new ArtifactPipelineError(
        "BUILD",
        "Agent Díaz V2 ended without accepting a validated artifact.",
        { ruleOrPart: "agent-v2-acceptance" },
      );
    const accepted = successfulBuilds.get(acceptedBuildId);
    if (!accepted)
      throw new ArtifactPipelineError(
        "BUILD",
        "Agent Díaz V2 acceptance referenced a missing validated build.",
        { ruleOrPart: "agent-v2-accepted-build" },
      );

    const receipt = accepted.validationReceipt as unknown as Record<string, unknown>;
    receipt.agentRuntime = {
      version: "v2",
      harness: "@openai/agents",
      sandbox: "unix-local",
      mcp: configuredMcp ? "streamable-http" : "disabled",
      attempts: attempt,
      acceptance: "explicit-validated-build",
    };

    log("info", "agent_v2.run_completed", {
      jobId: input.jobId,
      kind: input.kind,
      attempts: attempt,
      acceptedBuildId,
      name: accepted.name,
    });
    return {
      file: accepted,
      attempts: attempt,
      finalOutput: result.finalOutput,
    };
  } finally {
    if (configuredMcp) {
      try {
        await configuredMcp.close();
      } catch (error) {
        log("warn", "agent_v2.mcp_close_failed", {
          jobId: input.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
