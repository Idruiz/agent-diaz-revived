import fs from "node:fs";
import OpenAI from "openai";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import {
  ArtifactPlanSchema,
  type JobKind,
  type MessageView,
  type ModelMode,
  type Voice,
} from "../shared/contracts.js";
import { buildArtifact } from "./builders.js";
import { log } from "./log.js";
import { getSkillForKind } from "./skills.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ModelProfile {
  mode: ModelMode;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  label: "Quick" | "Balanced" | "Deep";
}
export function modelProfileFor(mode: ModelMode): ModelProfile {
  if (mode === "quick")
    return {
      mode,
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      label: "Quick",
    };
  if (mode === "deep")
    return {
      mode,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      label: "Deep",
    };
  return {
    mode: "balanced",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    label: "Balanced",
  };
}

export function isImageUpload(mime: string, name = ""): boolean {
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name);
}
export function isSpreadsheetUpload(name: string, mime: string): boolean {
  return (
    /\.(csv|tsv|xls|xlsx|ods)$/i.test(name) ||
    /(csv|tab-separated|spreadsheet|excel|officedocument\.spreadsheet)/i.test(
      mime,
    )
  );
}

export function providerFailureMessage(response: any): string {
  const code =
    response?.error?.code ||
    response?.incomplete_details?.reason ||
    response?.status ||
    "unknown";
  const detail =
    response?.error?.message ||
    "The model provider did not return a completed response.";
  return `OpenAI response failed (${code}): ${detail}`;
}

function isTransientProviderFailure(response: any): boolean {
  return ["server_error", "rate_limit_exceeded"].includes(
    response?.error?.code,
  );
}

function artifactInstructions(kind: JobKind): string {
  return `Create a complete ${kind} plan. Use web search when current or factual claims benefit from verification. For analysis, use the python tool on every uploaded dataset and base all numerical claims on executed results. Return JSON only with: title, subtitle, sections[{heading,body,bullets,speakerNotes, optional imageQuery, optional table{title,headers,rows}, optional chart{title,type:bar|line|pie|donut,labels,series[{name,values}],unit,sourceNote}, optional diagram{title,nodes,caption}}], optional pages[{slug,title,description,sectionHeadings}], sources[{title,url}]. Every material factual claim must be supported. Never invent numbers. Use 7-12 sections for presentations and 5-14 otherwise. Include at least two meaningful visual elements across tables, charts, or diagrams when the evidence supports them. Do not add decorative charts without real data. Body and bullets must contain finished content, not directions or placeholders.${kind === "website" ? " A website MUST define 3-6 pages with unique lowercase slugs (use index for the home page), assign every section heading to a page, and give at least four sections concrete imageQuery values for relevant documentary photographs. Do not request logos, illustrations, AI images, text-heavy graphics, or identifiable private people." : ""}`;
}

function validateArtifactPlan(
  kind: JobKind,
  plan: any,
  minVisuals: number,
): void {
  const visualCount = plan.sections.filter(
    (s: any) => s.table || s.chart || s.diagram || s.imageQuery,
  ).length;
  if (visualCount < minVisuals)
    throw new Error(
      `Artifact plan validation failed: expected at least ${minVisuals} meaningful visuals, received ${visualCount}`,
    );
  if (kind === "website") {
    if (!plan.pages || plan.pages.length < 3)
      throw new Error(
        "Website plan validation failed: at least three pages are required",
      );
    const headings = new Set(plan.sections.map((s: any) => s.heading));
    const assigned = new Set(plan.pages.flatMap((p: any) => p.sectionHeadings));
    for (const heading of headings)
      if (!assigned.has(heading))
        throw new Error(
          `Website plan validation failed: section '${heading}' is not assigned to a page`,
        );
    if (plan.sections.filter((s: any) => s.imageQuery).length < 4)
      throw new Error(
        "Website plan validation failed: at least four documentary photo queries are required",
      );
  }
}

export class AgentRunner {
  private client: OpenAI;
  private active = new Set<string>();
  private activeStreams = new Map<string, AbortController>();
  constructor(
    private config: Config,
    private db: Db,
  ) {
    this.client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  async upload(file: { path: string; name: string }): Promise<string> {
    const out = await this.client.files.create({
      file: fs.createReadStream(file.path),
      purpose: "user_data",
    });
    return out.id;
  }

  private usableMessages(
    conversationId: string,
    excludeAssistantJobId?: string,
  ): MessageView[] {
    return this.db.listMessages(conversationId).filter((message) => {
      if (
        message.role === "assistant" &&
        message.jobId === excludeAssistantJobId
      )
        return false;
      return (
        ["complete", "stopped"].includes(message.status) &&
        Boolean(message.content.trim())
      );
    });
  }

  private messageInput(message: MessageView): any {
    if (message.role === "assistant")
      return { role: "assistant", content: message.content };
    const uploads = this.db.getUploads(message.attachments.map((a) => a.id));
    const content: any[] = [{ type: "input_text", text: message.content }];
    for (const upload of uploads)
      content.push(
        isImageUpload(upload.mime, upload.name)
          ? {
              type: "input_image",
              file_id: upload.openaiFileId,
              detail: "auto",
            }
          : { type: "input_file", file_id: upload.openaiFileId },
      );
    return { role: "user", content };
  }

  private contextInstructions(conversationId: string): string {
    const archives = this.db.listArchiveSummaries(20);
    const archiveContext = archives.length
      ? `ARCHIVAL MEMORY FROM OLDER CONVERSATIONS (use only when relevant; never claim it was said in this conversation):\n${archives.map((a) => `[${a.title}] ${a.summary}`).join("\n\n")}`
      : "";
    return `Maintain continuity with every prior turn in this conversation. Answer the newest request, build on established decisions, and do not repeat an answer already given unless the user asks for repetition. If correcting an earlier answer, identify the change. Every attached file listed in the input is genuinely available to you. If a file cannot be read or interpreted, say so explicitly and name it; never pretend you inspected a file you did not receive. ${archiveContext}`;
  }

  private toolset(messages: MessageView[], skillTools: string[]): any[] {
    const attachmentIds = messages.flatMap((message) =>
      message.attachments.map((a) => a.id),
    );
    const uploads = this.db.getUploads([...new Set(attachmentIds)]);
    const tools: any[] = [];
    if (skillTools.includes("web_search")) tools.push({ type: "web_search" });
    if (
      skillTools.includes("python") ||
      uploads.some((upload) => isSpreadsheetUpload(upload.name, upload.mime))
    )
      tools.push({
        type: "code_interpreter",
        container: {
          type: "auto",
          file_ids: uploads.map((upload) => upload.openaiFileId),
        },
      });
    if (skillTools.includes("mcp") && this.config.MCP_SERVER_URL)
      tools.push(this.mcpTool());
    return tools;
  }

  async createRealtimeToken(
    conversationId: string,
    voice: Voice,
  ): Promise<{
    value: string;
    expiresAt: number;
    model: string;
    voice: Voice;
  }> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.status !== "active")
      throw new Error("Conversation not found");
    const transcript = this.usableMessages(conversationId)
      .slice(-60)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n")
      .slice(-100_000);
    const memory = this.db
      .listArchiveSummaries(10)
      .map((item) => `[${item.title}] ${item.summary}`)
      .join("\n\n")
      .slice(-30_000);
    const token = await this.client.realtime.clientSecrets.create(
      {
        expires_after: { anchor: "created_at", seconds: 120 },
        session: {
          type: "realtime",
          model: this.config.OPENAI_REALTIME_MODEL,
          output_modalities: ["audio"],
          max_output_tokens: 2048,
          instructions: `You are Agent Díaz, the user's careful private work agent. Speak naturally, concisely, and warmly. Maintain continuity with the supplied transcript. Never claim an external action occurred without a tool result. This is a voice conversation, so avoid markdown-heavy formatting.\n\nCURRENT CONVERSATION:\n${transcript || "No prior turns."}\n\nOLDER DURABLE MEMORY (use only when relevant):\n${memory || "None."}`,
          audio: {
            input: {
              transcription: { model: "gpt-4o-mini-transcribe" },
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "semantic_vad",
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { voice },
          },
        },
      },
      { headers: { "OpenAI-Safety-Identifier": "agent-diaz-owner" } },
    );
    log("info", "voice.token_created", {
      conversationId,
      model: this.config.OPENAI_REALTIME_MODEL,
      voice,
      expiresAt: token.expires_at,
    });
    return {
      value: token.value,
      expiresAt: token.expires_at,
      model: this.config.OPENAI_REALTIME_MODEL,
      voice,
    };
  }

  async compactConversation(conversationId: string): Promise<void> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.summary) return;
    const messages = this.db.listMessages(conversationId);
    if (!messages.length) {
      this.db.setConversationSummary(
        conversationId,
        "No conversation content was recorded.",
      );
      return;
    }
    const transcript = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n")
      .slice(0, 120_000);
    try {
      const response = await this.client.responses.create({
        model: this.config.OPENAI_FAST_MODEL,
        store: false,
        instructions:
          "Compact this completed conversation into durable archival memory. Preserve decisions, user preferences, facts, named entities, constraints, unfinished work, artifact names, and outcomes. Remove greetings, repetition, and incidental wording. Do not invent anything. Return concise plain text with a maximum of 900 words.",
        input: transcript,
      } as any);
      const summary = response.output_text?.trim();
      if (!summary) throw new Error("Empty archive summary");
      this.db.setConversationSummary(conversationId, summary);
    } catch (e) {
      const fallback = messages
        .slice(-12)
        .map(
          (m) => `${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 500)}`,
        )
        .join("\n");
      this.db.setConversationSummary(
        conversationId,
        `Automatic semantic compaction was unavailable. Durable extract:\n${fallback}`,
      );
      log("warn", "conversation.compaction_fallback", {
        conversationId,
        error: e instanceof Error ? e.message : "unknown",
      });
    }
  }

  start(jobId: string): void {
    if (this.active.has(jobId)) return;
    this.active.add(jobId);
    void this.run(jobId).finally(() => this.active.delete(jobId));
  }

  resume(): void {
    for (const j of this.db
      .listJobs(100)
      .filter(
        (j) =>
          j.kind !== "chat" &&
          ["queued", "running", "building"].includes(j.status),
      ))
      this.start(j.id);
  }

  async cancel(jobId: string): Promise<void> {
    this.activeStreams.get(jobId)?.abort();
    const id = this.db.getProviderResponseId(jobId);
    if (id) {
      try {
        await this.client.responses.cancel(id);
      } catch {}
    }
    this.db.updateJob(jobId, {
      status: "cancelled",
      message: "Cancelled by user",
    });
  }

  async streamChat(
    jobId: string,
    assistantMessageId: string,
    handlers: {
      onReady?: (data: { jobId: string; assistantMessageId: string }) => void;
      onDelta?: (delta: string) => void;
      onDone?: (content: string) => void;
      onApproval?: (count: number) => void;
      onError?: (message: string) => void;
    },
    externalSignal?: AbortSignal,
    excludeAssistantJobId?: string,
  ): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job) throw new Error("Chat job not found");
    const controller = new AbortController();
    this.activeStreams.set(jobId, controller);
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    let output = "",
      lastPersist = 0,
      responseId = "";
    const approvalItems: any[] = [];
    try {
      this.db.updateJob(jobId, {
        status: "running",
        progress: 10,
        message: "Thinking",
      });
      handlers.onReady?.({ jobId, assistantMessageId });
      const skill = getSkillForKind("chat"),
        messages = this.usableMessages(
          job.conversationId,
          excludeAssistantJobId,
        );
      const stream = await this.client.responses.create(
        {
          model: job.model,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions: `You are Agent Díaz, a careful autonomous work agent. Complete read-only work autonomously. Never claim an action succeeded without a tool result. External writes require explicit approval. State uncertainty and never fabricate evidence.\n\nACTIVE SKILL: ${skill.name}\n${skill.instructions}\n\n${this.contextInstructions(job.conversationId)}`,
          input: messages.map((message) => this.messageInput(message)),
          tools: this.toolset(messages, skill.tools),
          stream: true,
          store: true,
          safety_identifier: "agent-diaz-owner",
        } as any,
        { signal: controller.signal },
      );
      for await (const event of stream as any) {
        if (event.type === "response.created") {
          responseId = event.response.id;
          this.db.updateJob(jobId, {
            providerResponseId: responseId,
            progress: 20,
            message: "Responding",
          });
          continue;
        }
        if (event.type === "response.output_text.delta") {
          output += event.delta;
          handlers.onDelta?.(event.delta);
          const now = Date.now();
          if (now - lastPersist > 300) {
            this.db.updateMessage(assistantMessageId, { content: output });
            lastPersist = now;
          }
          continue;
        }
        if (
          event.type === "response.failed" ||
          event.type === "response.incomplete"
        )
          throw new Error(providerFailureMessage(event.response));
        if (
          event.type === "response.output_item.done" &&
          event.item?.type === "mcp_approval_request"
        ) {
          approvalItems.push(event.item);
          continue;
        }
        if (event.type === "error")
          throw new Error(
            `OpenAI stream failed (${event.code ?? "stream_error"}): ${event.message ?? "Unknown stream error"}`,
          );
      }
      if (approvalItems.length) {
        for (const item of approvalItems)
          this.db.createApproval({
            id: crypto.randomUUID(),
            jobId,
            tool: `${item.server_label ?? "MCP"}: ${item.name ?? "external action"}`,
            summary:
              "An external tool wants to perform this action. Review the exact arguments before approving once.",
            argumentsJson:
              typeof item.arguments === "string"
                ? item.arguments
                : JSON.stringify(item.arguments ?? {}),
            providerItemId: item.id,
            providerResponseId: responseId,
          });
        const content =
          "Díaz needs your approval before continuing this external action.";
        this.db.updateMessage(assistantMessageId, {
          content,
          status: "streaming",
          error: null,
        });
        this.db.updateJob(jobId, {
          status: "waiting_approval",
          progress: 40,
          message: "Waiting for your approval",
          outputText: output || null,
          error: null,
        });
        handlers.onApproval?.(approvalItems.length);
        log("info", "chat.waiting_approval", {
          jobId,
          count: approvalItems.length,
        });
        return;
      }
      if (!output.trim())
        throw new Error("OpenAI completed without returning text");
      this.db.updateMessage(assistantMessageId, {
        content: output,
        status: "complete",
        error: null,
      });
      this.db.updateJob(jobId, {
        status: "completed",
        progress: 100,
        message: "Completed",
        outputText: output,
        error: null,
      });
      handlers.onDone?.(output);
      log("info", "chat.completed", {
        jobId,
        model: job.model,
        reasoningEffort: job.reasoningEffort,
      });
    } catch (error: any) {
      const aborted = controller.signal.aborted || error?.name === "AbortError";
      if (aborted) {
        this.db.updateMessage(assistantMessageId, {
          content: output,
          status: "stopped",
          error: null,
        });
        this.db.updateJob(jobId, {
          status: "cancelled",
          message: "Stopped",
          outputText: output || null,
          error: null,
        });
        handlers.onDone?.(output);
        log("info", "chat.stopped", { jobId });
      } else {
        const message =
          error instanceof Error ? error.message : "Unknown chat failure";
        this.db.updateMessage(assistantMessageId, {
          content: output,
          status: "failed",
          error: message,
        });
        this.db.updateJob(jobId, {
          status: "failed",
          message: "Failed",
          outputText: output || null,
          error: message,
        });
        handlers.onError?.(message);
        log("error", "chat.failed", { jobId, error: message });
      }
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      this.activeStreams.delete(jobId);
    }
  }

  private mcpTool(): any {
    if (!this.config.MCP_SERVER_URL) throw new Error("MCP is not configured");
    return {
      type: "mcp",
      server_label: this.config.MCP_SERVER_LABEL,
      server_url: this.config.MCP_SERVER_URL,
      server_description:
        "User-authorized workspace tools. External writes require approval.",
      ...(this.config.MCP_AUTHORIZATION
        ? { authorization: this.config.MCP_AUTHORIZATION }
        : {}),
      require_approval: "always",
    };
  }

  async continueApproval(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<void> {
    const approval = this.db.getApproval(approvalId);
    if (!approval) throw new Error("Approval not found");
    if (approval.status !== "pending")
      throw new Error("Approval was already decided");
    this.db.decideApproval(approvalId, decision);
    const decisions = this.db.raw
      .prepare(
        "SELECT status,provider_item_id providerItemId,provider_response_id providerResponseId FROM approvals WHERE job_id=? ORDER BY created_at",
      )
      .all(approval.jobId) as Array<{
      status: string;
      providerItemId: string;
      providerResponseId: string;
    }>;
    if (decisions.some((d) => d.status === "pending")) {
      this.db.updateJob(approval.jobId, {
        status: "waiting_approval",
        message: "Waiting for the remaining approval decisions",
      });
      return;
    }
    const response = await this.client.responses.create({
      model: this.db.getJob(approval.jobId)?.model ?? this.config.OPENAI_MODEL,
      previous_response_id: approval.providerResponseId,
      tools: [this.mcpTool()],
      input: decisions.map((d) => ({
        type: "mcp_approval_response",
        approval_request_id: d.providerItemId,
        approve: d.status === "approved",
      })),
      background: true,
      store: true,
      reasoning: {
        effort: this.db.getJob(approval.jobId)?.reasoningEffort ?? "medium",
      },
    } as any);
    this.db.updateJob(approval.jobId, {
      providerResponseId: response.id,
      status: "running",
      progress: 45,
      message:
        decision === "approved"
          ? "Approved action is continuing"
          : "Rejection recorded; Díaz is continuing safely",
    });
    this.start(approval.jobId);
  }

  private captureApproval(jobId: string, response: any): boolean {
    const requests = (response.output ?? []).filter(
      (item: any) => item?.type === "mcp_approval_request",
    );
    if (!requests.length) return false;
    if (this.db.listApprovals(jobId).some((a) => a.status === "pending"))
      return true;
    for (const item of requests) {
      this.db.createApproval({
        id: crypto.randomUUID(),
        jobId,
        tool: `${item.server_label ?? "MCP"}: ${item.name ?? "external action"}`,
        summary:
          "An external tool wants to perform this action. Review the exact arguments before approving once.",
        argumentsJson:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
        providerItemId: item.id,
        providerResponseId: response.id,
      });
    }
    this.db.updateJob(jobId, {
      status: "waiting_approval",
      progress: 40,
      message: "Waiting for your approval",
    });
    return true;
  }

  private async run(jobId: string): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job || ["completed", "cancelled"].includes(job.status)) return;
    try {
      this.db.updateJob(jobId, {
        status: "running",
        progress: 10,
        message: "Agent is working",
      });
      const skill = getSkillForKind(job.kind);
      const artifactKinds = [
        "research",
        "analysis",
        "presentation",
        "document",
        "website",
      ];
      const createFreshResponse = async () => {
        const instructions = [
          "You are Agent Díaz, a careful autonomous work agent. Complete read-only work autonomously. Never claim an action succeeded without a tool result. External writes require explicit approval. State uncertainty and never fabricate evidence.",
          `ACTIVE SKILL: ${skill.name}\n${skill.instructions}\nValidation: ${skill.validation.join("; ")}`,
          ...(artifactKinds.includes(job.kind)
            ? [artifactInstructions(job.kind)]
            : []),
        ].join("\n\n");
        const messages = this.usableMessages(job.conversationId);
        return this.client.responses.create({
          model: job.model,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions: `${instructions}\n\n${this.contextInstructions(job.conversationId)}`,
          input: messages.map((message) => this.messageInput(message)),
          tools: this.toolset(messages, skill.tools),
          background: true,
          store: true,
          safety_identifier: "agent-diaz-owner",
          ...(artifactKinds.includes(job.kind)
            ? { text: { format: { type: "json_object" } } }
            : {}),
        } as any);
      };
      let rid = this.db.getProviderResponseId(jobId);
      let response: any;
      if (rid) {
        response = await this.client.responses.retrieve(rid);
      } else {
        response = await createFreshResponse();
        rid = response.id;
        this.db.updateJob(jobId, {
          providerResponseId: rid,
          progress: 25,
          message: "Background response started",
        });
      }
      let automaticRetries = 0;
      for (;;) {
        while (["queued", "in_progress"].includes(response.status)) {
          await sleep(1800);
          if (this.db.getJob(jobId)?.status === "cancelled") return;
          response = await this.client.responses.retrieve(rid!);
          this.db.updateJob(jobId, {
            progress: Math.min(75, (this.db.getJob(jobId)?.progress ?? 25) + 3),
            message: `Agent status: ${response.status}`,
          });
        }
        if (this.captureApproval(jobId, response)) return;
        if (response.status === "completed") break;
        const providerError = providerFailureMessage(response);
        log("error", "provider.response_failed", {
          jobId,
          responseId: response.id,
          status: response.status,
          code: response?.error?.code,
          error: response?.error?.message,
        });
        if (
          automaticRetries === 0 &&
          !this.config.MCP_SERVER_URL &&
          isTransientProviderFailure(response)
        ) {
          automaticRetries++;
          this.db.updateJob(jobId, {
            progress: 25,
            message: "Provider failed transiently; retrying once",
          });
          await sleep(
            response?.error?.code === "rate_limit_exceeded" ? 5000 : 1200,
          );
          response = await createFreshResponse();
          rid = response.id;
          this.db.updateJob(jobId, {
            providerResponseId: rid,
            message: "Background response restarted",
          });
          continue;
        }
        throw new Error(providerError);
      }
      const output = response.output_text?.trim() || "";
      if (
        [
          "research",
          "analysis",
          "presentation",
          "document",
          "website",
        ].includes(job.kind)
      ) {
        this.db.updateJob(jobId, {
          status: "building",
          progress: 82,
          message: "Building and validating artifact",
        });
        const raw = JSON.parse(output.replace(/^```json\s*|```$/g, ""));
        const plan = ArtifactPlanSchema.parse(raw);
        validateArtifactPlan(
          job.kind,
          plan,
          getSkillForKind(job.kind).minVisuals,
        );
        const file = await buildArtifact(this.config, job.kind, plan);
        const id = crypto.randomUUID();
        this.db.addArtifact({
          id,
          jobId,
          name: file.name,
          mime: file.mime,
          size: file.size,
          path: file.path,
        });
      }
      const userOutput = [
        "research",
        "analysis",
        "presentation",
        "document",
        "website",
      ].includes(job.kind)
        ? `Completed ${job.kind} artifact: ${this.db
            .listArtifacts(jobId)
            .map((a) => a.name)
            .join(", ")}. The finished file is ready to download.`
        : output;
      this.db.updateJob(jobId, {
        status: "completed",
        progress: 100,
        message: "Completed",
        outputText: userOutput,
        error: null,
      });
      log("info", "job.completed", { jobId, kind: job.kind });
      const existing = this.db.raw
        .prepare(
          "SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1",
        )
        .get(jobId) as { id: string } | undefined;
      if (existing)
        this.db.updateMessage(existing.id, {
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
    } catch (e: any) {
      const message = e instanceof Error ? e.message : "Unknown job failure";
      this.db.updateJob(jobId, {
        status: "failed",
        message: "Failed",
        error: message,
      });
      const existing = this.db.raw
        .prepare(
          "SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1",
        )
        .get(jobId) as { id: string } | undefined;
      if (existing)
        this.db.updateMessage(existing.id, {
          status: "failed",
          error: message,
        });
      log("error", "job.failed", { jobId, error: message });
    }
  }
}
