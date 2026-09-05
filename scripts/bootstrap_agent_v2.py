from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"Missing bootstrap anchor: {label}")
    return text.replace(old, new, 1)


# Keep AGENT_RUNTIME out of Config so the existing production/test Config contract
# remains source-compatible. V2 is branch-default; AGENT_RUNTIME=legacy is an
# emergency environment override read at runtime.
config = Path("src/server/config.ts")
text = config.read_text()
text = text.replace(
    '  AGENT_RUNTIME: z.enum(["legacy", "v2"]).default("v2"),\n',
    "",
)
config.write_text(text)

runtime = Path("src/server/v2/artifact-agent-runtime.ts")
text = runtime.read_text()
text = text.replace(
    'z.enum(["PLAN_CONTENT", "ASSET", "BUILD", "INFRA"]),',
    'z.enum(["PLAN_CONTENT", "PLAN_NORMALIZABLE", "ASSET", "BUILD", "INFRA"]),',
)
text = text.replace(
    "const manifestEntries: Record<string, ReturnType<typeof file> | ReturnType<typeof localFile>> = {",
    "const manifestEntries: Record<string, any> = {",
)
# @openai/agents 0.17 accepts object-shaped Zod output schemas for function tools;
# this tool intentionally returns either success or failure, so let the SDK encode
# the returned object rather than forcing a discriminated-union output schema.
text = text.replace(
    "    outputSchema: BuildToolResultSchema,\n",
    "",
    1,
)
runtime.write_text(text)

agent = Path("src/server/openai-agent.ts")
text = agent.read_text()
import_anchor = 'import { personaInstructions } from "./personas.js";\n'
import_line = 'import { runV2ArtifactRuntime } from "./v2/artifact-agent-runtime.js";\n'
if import_line not in text:
    text = replace_once(
        text,
        import_anchor,
        import_anchor + import_line,
        "openai-agent V2 import",
    )

insertion_anchor = "      let artifactRunState = isArtifact\n"
if "agent_v2.integration_started" not in text:
    block = r'''      if (isArtifact && process.env.AGENT_RUNTIME !== "legacy") {
        const existingArtifacts = this.db.listArtifacts(jobId);
        if (existingArtifacts.length) {
          const userOutput = `Completed ${job.kind} artifact: ${existingArtifacts.map((a) => a.name).join(", ")}. The finished file is ready to download.`;
          this.db.updateJob(jobId, {
            status: "completed",
            progress: 100,
            message: "Completed",
            outputText: userOutput,
            error: null,
          });
          const existingMessage = this.db.raw
            .prepare("SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1")
            .get(jobId) as { id: string } | undefined;
          if (existingMessage)
            this.db.updateMessage(existingMessage.id, {
              content: userOutput,
              status: "complete",
              error: null,
            });
          else
            this.db.addMessage({
              id: crypto.randomUUID(),
              conversationId: job.conversationId,
              role: "assistant",
              content: userOutput,
              jobId,
            });
          log("info", "agent_v2.resume_reused_artifact", {
            jobId,
            kind: job.kind,
            artifactCount: existingArtifacts.length,
          });
          return;
        }

        const controller = new AbortController();
        this.activeStreams.set(jobId, controller);
        try {
          this.db.updateJob(jobId, {
            status: "running",
            progress: 12,
            message: "Agent V2 workspace starting",
            error: null,
          });
          log("info", "agent_v2.integration_started", {
            jobId,
            kind: job.kind,
            model: job.model,
            runtimeOverride: process.env.AGENT_RUNTIME ?? "v2-default",
          });
          const attachments = this.db.getUploads(this.db.getJobFileIds(jobId));
          this.db.updateJob(jobId, {
            status: "running",
            progress: 20,
            message: "Agent V2 researching, planning, and revising in workspace",
            error: null,
          });
          const result = await runV2ArtifactRuntime({
            config: this.config,
            jobId,
            kind: job.kind,
            prompt: job.prompt,
            model: job.model,
            reasoningEffort: job.reasoningEffort,
            attachments,
            priorContext: priorArtifactContext,
            signal: controller.signal,
            onProgress: (event) => {
              const currentProgress = this.db.getJob(jobId)?.progress ?? 20;
              this.db.updateJob(jobId, {
                status: "building",
                progress: Math.max(currentProgress, Math.min(99, event.progress)),
                error: null,
                message: event.message,
              });
              log("info", "agent_v2.build_progress", {
                jobId,
                kind: job.kind,
                ...event,
              });
            },
          });

          const file = result.file;
          const id = crypto.randomUUID();
          const extension = path.extname(file.name);
          const durableName = `${path.basename(file.name, extension)}-${id.slice(0, 12)}${extension}`;
          const durablePath = path.join(this.config.artifactDir, durableName);
          fs.mkdirSync(this.config.artifactDir, { recursive: true });
          fs.renameSync(file.path, durablePath);
          file.name = durableName;
          file.path = durablePath;
          fs.rmSync(path.join(this.config.artifactDir, ".agent-v2", jobId), {
            recursive: true,
            force: true,
          });
          this.db.addArtifact({
            id,
            jobId,
            name: file.name,
            mime: file.mime,
            size: file.size,
            path: file.path,
            receipt: file.validationReceipt,
          });

          const userOutput = `Completed ${job.kind} artifact: ${file.name}. Agent Díaz V2 iterated through ${result.attempts} build attempt${result.attempts === 1 ? "" : "s"}; the accepted file passed production validation and is ready to download.`;
          this.db.updateJob(jobId, {
            status: "completed",
            progress: 100,
            message: "Completed",
            outputText: userOutput,
            error: null,
          });
          const existingMessage = this.db.raw
            .prepare("SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1")
            .get(jobId) as { id: string } | undefined;
          if (existingMessage)
            this.db.updateMessage(existingMessage.id, {
              content: userOutput,
              status: "complete",
              error: null,
            });
          else
            this.db.addMessage({
              id: crypto.randomUUID(),
              conversationId: job.conversationId,
              role: "assistant",
              content: userOutput,
              jobId,
            });
          log("info", "agent_v2.integration_completed", {
            jobId,
            kind: job.kind,
            attempts: result.attempts,
            name: file.name,
            size: file.size,
          });
          return;
        } finally {
          this.activeStreams.delete(jobId);
        }
      }

'''
    text = replace_once(
        text,
        insertion_anchor,
        block + insertion_anchor,
        "openai-agent V2 run integration",
    )
else:
    text = text.replace(
        'if (isArtifact && this.config.AGENT_RUNTIME === "v2") {',
        'if (isArtifact && process.env.AGENT_RUNTIME !== "legacy") {',
    )
agent.write_text(text)

print("Agent Díaz V2 bootstrap patch applied")
