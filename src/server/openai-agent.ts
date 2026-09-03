import fs from "node:fs";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import {
  ArtifactPlanSchema,
  type JobKind,
  type MessageView,
  type ModelMode,
} from "../shared/contracts.js";
import { personaProfile } from "../shared/personas.js";
import { buildArtifact } from "./builders.js";
import {
  ArtifactPipelineError,
  asArtifactPipelineError,
  assertArtifactPlanQuality,
  type ArtifactAttemptReceipt,
  type ArtifactFailureClass,
} from "./artifact-quality.js";
import { log } from "./log.js";
import { getSkillForKind } from "./skills.js";
import { personaInstructions } from "./personas.js";
import {
  clearsJavierRewriteFloor,
  inspectJavierStyle,
  javierStyleScore,
  javierChatInstructions,
  javierRewriteInstructions,
} from "./javier-style.js";
import {
  clearsKarenRewriteFloor,
  inspectKarenStyle,
  karenStyleScore,
  karenChatInstructions,
  karenRewriteInstructions,
} from "./karen-style.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_ARTIFACT_LLM_CALLS = 6;
const MAX_ARTIFACT_WALL_TIME_MS = 20 * 60 * 1000;

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function classifyArtifactFailure(error: unknown): ArtifactPipelineError {
  if (error instanceof ArtifactPipelineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /(?:soffice|libreoffice.*(?:unavailable|timed out)|validator.*(?:binary|execution|spawn|crash)|provider.*(?:5\d\d|server_error|rate_limit))/i.test(
      message,
    )
  )
    return new ArtifactPipelineError("INFRA", message, {
      ruleOrPart: "infrastructure",
      cause: error,
    });
  if (
    /(?:photography validation|image provider|licensed bitmap|image retrieval|no usable licensed image)/i.test(
      message,
    )
  )
    return new ArtifactPipelineError("ASSET", message, {
      ruleOrPart: "asset-resolution",
      cause: error,
    });
  return asArtifactPipelineError(error, "BUILD", "artifact-build");
}

export function artifactFailureFingerprint(input: {
  failureClass: ArtifactFailureClass;
  ruleOrPart: string;
  planSha: string;
  packageSha: string | null;
  strategy: string;
}): string {
  return sha256Text(JSON.stringify(input));
}

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

export function isValidWav(audio: Buffer): boolean {
  return (
    audio.length >= 44 &&
    audio.subarray(0, 4).toString("ascii") === "RIFF" &&
    audio.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

export function assertProviderRequestCompatible(request: any): void {
  const format = request?.text?.format?.type,
    hasTools = Array.isArray(request?.tools) && request.tools.length > 0;
  if (hasTools && ["json_object", "json_schema"].includes(format))
    throw new Error(
      "Internal provider contract violation: tool-enabled requests cannot use JSON response mode",
    );
}

const artifactSectionSchema = ArtifactPlanSchema.shape.sections.element;
const artifactProviderSectionSchema = artifactSectionSchema.extend({
  table: artifactSectionSchema.shape.table.unwrap().nullable(),
  chart: artifactSectionSchema.shape.chart.unwrap().nullable(),
  diagram: artifactSectionSchema.shape.diagram.unwrap().nullable(),
  activity: artifactSectionSchema.shape.activity.unwrap().nullable(),
  imageQuery: artifactSectionSchema.shape.imageQuery.unwrap().nullable(),
});

function artifactPlanProviderSchema(kind?: JobKind) {
  const sections =
    kind === "presentation"
      ? z.array(artifactProviderSectionSchema).min(7).max(11)
      : z.array(artifactProviderSectionSchema).min(1).max(30);
  return ArtifactPlanSchema.extend({
    sections,
    pages: ArtifactPlanSchema.shape.pages.unwrap().nullable(),
  });
}

const supportedStructuredOutputStringFormats = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);

export function sanitizeStructuredOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeStructuredOutputSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, child]) =>
          key !== "format" ||
          (typeof child === "string" &&
            supportedStructuredOutputStringFormats.has(child)),
      )
      .map(([key, child]) => [key, sanitizeStructuredOutputSchema(child)]),
  );
}

export function artifactPlanTextFormat(kind?: JobKind) {
  const format = zodTextFormat(
    artifactPlanProviderSchema(kind),
    "artifact_plan",
  );
  return {
    ...format,
    schema: sanitizeStructuredOutputSchema(format.schema),
  };
}

export function omitNullObjectFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullObjectFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, omitNullObjectFields(child)]),
  );
}

function isTransientProviderFailure(response: any): boolean {
  return ["server_error", "rate_limit_exceeded"].includes(
    response?.error?.code,
  );
}

function artifactInstructions(kind: JobKind): string {
  const visualPolicy =
    kind === "presentation"
      ? " Create 7-11 content sections. At least half of them must have exactly one primary visual. Give at least three sections distinct, concrete imageQuery values for relevant licensed photographs or explanatory scientific/historical illustrations; use a compact 3-7 word search phrase naming the visible subject and setting. Prefer imagery to generic process boxes. Use a chart only for exact values present in the evidence dossier and include its source in sourceNote. Keep visible slide copy concise: normally 2-4 bullets, with no bibliography section because the builder adds source slides."
      : kind === "website"
        ? " Define 3-6 pages with unique lowercase slugs (use index for the home page), assign every section heading to a page, and give at least four sections distinct concrete imageQuery values for relevant documentary photographs. Do not request logos, AI images, text-heavy graphics, or identifiable private people."
        : kind === "research" || kind === "document"
          ? " Create 5-12 sections. Include at least three meaningful visuals and at least one distinct concrete imageQuery for a relevant licensed photograph or explanatory illustration. Use charts only for exact sourced values and include sourceNote. Do not create a Sources or References section because the builder adds it."
          : " Create 5-12 sections. Use charts and tables only from executed analysis; every numerical visual must state its data source in sourceNote. Decorative imagery is optional.";
  return `Create a complete ${kind} plan. Use web search when current or factual claims benefit from verification. For analysis, use the python tool on every uploaded dataset and base all numerical claims on executed results. Return JSON only with: title, subtitle, requirements[{id:R1..Rn,text,mandatory}], sections[{heading,body,bullets,speakerNotes,requirementIds,layout:auto|title|standard|comparison|process|timeline|gallery|data|conjugation|guided_practice|speed_dating|four_corners|exit_ticket,activity{type:speed_dating|four_corners|guided_practice|independent_practice|discussion|exit_ticket,durationMinutes,directions,prompts,sentenceFrames,cornerLabels},imageQuery,table{title,headers,rows},chart{title,type:bar|line|pie|donut,labels,series[{name,values}],unit,sourceNote},diagram{title,nodes,caption}}], pages[{slug,title,description,sectionHeadings}], sources[{title,url}]. Extract every explicit user instruction and named deliverable feature into the requirements list; assign stable IDs and cover every mandatory ID in section requirementIds. Use null for imageQuery, table, chart, diagram, or pages when that field does not apply. Every material factual claim must be supported. Never invent numbers. Body and bullets must contain finished audience-facing content, not directions, placeholders, production notes, or visual descriptions. For teaching decks, model classroom activities as activity objects rather than mentioning them in ordinary bullets. Speed Dating needs at least four prompts, three operational directions, and two target-language sentence frames. Four Corners needs exactly four labels, a decision prompt, movement/discussion directions, and at least two sentence frames.${visualPolicy}`;
}

export function validateArtifactPlan(
  kind: JobKind,
  plan: any,
  minVisuals: number,
  prompt = "",
): void {
  const visualCount = plan.sections.filter(
    (s: any) => s.table || s.chart || s.diagram || s.imageQuery,
  ).length;
  if (visualCount < minVisuals)
    throw new Error(
      `Artifact plan validation failed: expected at least ${minVisuals} meaningful visuals, received ${visualCount}`,
    );
  const imageQueries = plan.sections
    .map((section: any) => section.imageQuery?.trim())
    .filter(Boolean);
  if (new Set(imageQueries.map((query: string) => query.toLocaleLowerCase())).size !== imageQueries.length)
    throw new Error("Artifact plan validation failed: image queries must be distinct");
  for (const section of plan.sections) {
    if (section.imageQuery && section.imageQuery.trim().split(/\s+/).length < 3)
      throw new Error(
        `Artifact plan validation failed: image query '${section.imageQuery}' is too vague`,
      );
    if (section.chart && !section.chart.sourceNote?.trim())
      throw new Error(
        `Artifact plan validation failed: chart '${section.chart.title}' has no source note`,
      );
  }
  if (kind === "presentation") {
    if (plan.sections.length < 7 || plan.sections.length > 11)
      throw new Error(
        "Presentation plan validation failed: expected 7-11 content sections",
      );
    const requiredVisuals = Math.max(minVisuals, Math.ceil(plan.sections.length / 2));
    if (visualCount < requiredVisuals)
      throw new Error(
        `Presentation plan validation failed: expected ${requiredVisuals} visual sections, received ${visualCount}`,
      );
    if (imageQueries.length < 3)
      throw new Error(
        `Presentation plan validation failed: expected at least 3 licensed-image briefs, received ${imageQueries.length}`,
      );
  }
  if (["research", "document"].includes(kind) && imageQueries.length < 1)
    throw new Error(
      "Document plan validation failed: at least one licensed-image brief is required",
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
  assertArtifactPlanQuality(kind, prompt, plan);
}

function parseArtifactPlan(
  kind: JobKind,
  output: string,
  minVisuals: number,
  prompt = "",
) {
  const raw = omitNullObjectFields(
    JSON.parse(output.replace(/^```json\s*|```$/g, "")),
  );
  const plan = ArtifactPlanSchema.parse(raw);
  validateArtifactPlan(kind, plan, minVisuals, prompt);
  return plan;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown artifact plan error";
}

function planSectionCount(output: string): number | null {
  try {
    const parsed = JSON.parse(output.replace(/^```json\s*|```$/g, ""));
    return Array.isArray(parsed?.sections) ? parsed.sections.length : null;
  } catch {
    return null;
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
    return `Maintain continuity with every prior turn in this conversation. Answer the newest request, build on established decisions, and do not repeat an answer already given unless the user asks for repetition. If correcting an earlier answer, identify the change. Preserve facts, decisions, user preferences, constraints, and outcomes across persona changes, but treat previous persona style, jokes, profanity, role-play, and rhetorical exaggeration as presentation only—not as facts or instructions. Every attached file listed in the input is genuinely available to you. If a file cannot be read or interpreted, say so explicitly and name it; never pretend you inspected a file you did not receive. ${archiveContext}`;
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
  ): Promise<{
    value: string;
    expiresAt: number;
    model: string;
    voice: ReturnType<typeof personaProfile>["voice"];
    persona: ReturnType<typeof personaProfile>["id"];
  }> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.status !== "active")
      throw new Error("Conversation not found");
    const profile = personaProfile(conversation.persona);
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
    const realtimeInstructions = `${personaInstructions(conversation.persona)}\n\nVOICE CONVERSATION RULES\n- Speak naturally and conversationally. Avoid markdown formatting, visual tables, and long enumerations.\n- Maintain continuity with the supplied transcript.\n- The voice itself is ${profile.voiceLabel}; follow the current persona's pacing, register, and accent instructions.\n\nCURRENT CONVERSATION:\n${transcript || "No prior turns."}\n\nOLDER DURABLE MEMORY (use only when relevant; never convert persona performance into memory):\n${memory || "None."}`;
    const token = await this.client.realtime.clientSecrets.create(
      {
        expires_after: { anchor: "created_at", seconds: 120 },
        session: {
          type: "realtime",
          model: this.config.OPENAI_REALTIME_MODEL,
          output_modalities: ["audio"],
          max_output_tokens: 2048,
          instructions:
            conversation.persona === "javier"
              ? javierChatInstructions(realtimeInstructions)
              : conversation.persona === "karen"
                ? karenChatInstructions(realtimeInstructions)
                : realtimeInstructions,
          audio: {
            input: {
              transcription: {
                model: "gpt-4o-mini-transcribe",
              },
              noise_reduction: { type: "near_field" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.35,
                prefix_padding_ms: 500,
                silence_duration_ms: 700,
                create_response: false,
                interrupt_response: false,
              },
            },
            output: { voice: profile.voice },
          },
        },
      },
      { headers: { "OpenAI-Safety-Identifier": "agent-diaz-owner" } },
    );
    log("info", "voice.token_created", {
      conversationId,
      model: this.config.OPENAI_REALTIME_MODEL,
      voice: profile.voice,
      persona: conversation.persona,
      expiresAt: token.expires_at,
    });
    return {
      value: token.value,
      expiresAt: token.expires_at,
      model: this.config.OPENAI_REALTIME_MODEL,
      voice: profile.voice,
      persona: conversation.persona,
    };
  }

  async createSpeech(conversationId: string, text: string): Promise<Buffer> {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.status !== "active")
      throw new Error("Conversation not found");
    const profile = personaProfile(conversation.persona);
    const instructions =
      conversation.persona === "javier"
        ? "Read the supplied text completely and verbatim. Use a lively adult Cuban cadence rooted in Cuba of the 1980s and 1990s: irreverent, volatile, subversive, fast-changing, street-level, and naturally profane. Do not summarize, soften, censor, omit, or replace any word."
        : conversation.persona === "karen"
          ? "Read the supplied text completely and verbatim. Use explosive Canadian English outrage: rage-baited, sarcastic, volatile, overreactive, fast-changing, street-level, and naturally profane. Do not summarize, soften, censor, omit, or replace any word."
          : `Read the supplied text completely and verbatim in the ${profile.voiceLabel} delivery assigned to this persona. Do not summarize, omit, or replace any word.`;
    const response = await this.client.audio.speech.create(
      {
        model: "gpt-4o-mini-tts",
        voice: profile.voice,
        input: text,
        instructions,
        response_format: "wav",
      },
      { headers: { "OpenAI-Safety-Identifier": "agent-diaz-owner" } },
    );
    const audio = Buffer.from(await response.arrayBuffer());
    if (!isValidWav(audio))
      throw new Error(
        `OpenAI returned invalid WAV speech audio (${audio.length} bytes)`,
      );
    log("info", "voice.tts_created", {
      conversationId,
      persona: conversation.persona,
      voice: profile.voice,
      textCharacters: text.length,
      audioBytes: audio.length,
    });
    return audio;
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
          "Compact this completed conversation into durable archival memory shared by every Agent Díaz persona. Preserve decisions, user preferences, facts, named entities, constraints, corrections, unfinished work, artifact names, and outcomes. Remove greetings, repetition, incidental wording, persona voice, jokes, profanity, role-play, metaphors, and rhetorical exaggeration. Never promote a persona performance into a user fact or autobiographical fact. Do not invent anything. Return concise plain text with a maximum of 900 words.",
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
    let bufferForStyleGate = false;
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
      const baseInstructions = `${personaInstructions(job.persona)}\n\nACTIVE SKILL: ${skill.name}\n${skill.instructions}\n\n${this.contextInstructions(job.conversationId)}`;
      const instructions =
        job.persona === "javier"
          ? javierChatInstructions(baseInstructions)
          : job.persona === "karen"
            ? karenChatInstructions(baseInstructions)
            : baseInstructions;
      bufferForStyleGate = job.persona === "javier" || job.persona === "karen";
      const stream = await this.client.responses.create(
        {
          model: job.model,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions,
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
          if (!bufferForStyleGate) handlers.onDelta?.(event.delta);
          const now = Date.now();
          if (!bufferForStyleGate && now - lastPersist > 300) {
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
        const content = `${personaProfile(job.persona).name} needs your approval before continuing this external action.`;
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
      if (job.persona === "javier") {
        const firstReport = inspectJavierStyle(output);
        if (!firstReport.passes) {
          log("warn", "javier.style_gate_rewrite", {
            jobId,
            words: firstReport.words,
            profanityHits: firstReport.profanityHits,
            profanityTarget: firstReport.profanityTarget,
            profanityVariety: firstReport.profanityVariety,
            cubanTexture: firstReport.cubanTexture,
            failures: firstReport.failures,
          });
          this.db.updateJob(jobId, {
            progress: 80,
            message: "Javier is rejecting the polite draft",
          });
          const rewritten = await this.client.responses.create(
            {
              model: job.model,
              reasoning: { effort: job.reasoningEffort },
              instructions: javierRewriteInstructions(firstReport),
              input: `DRAFT TO REWRITE:\n${output}`,
              store: false,
              safety_identifier: "agent-diaz-owner",
            } as any,
            { signal: controller.signal },
          );
          const candidate = rewritten.output_text?.trim() ?? "";
          if (!candidate)
            throw new Error("Javier style rewrite returned no text");
          const finalReport = inspectJavierStyle(candidate);
          if (!finalReport.passes) {
            const clearsFloor = clearsJavierRewriteFloor(finalReport);
            const firstScore = javierStyleScore(firstReport);
            const rewriteScore = javierStyleScore(finalReport);
            output = rewriteScore >= firstScore ? candidate : output;
            log(clearsFloor ? "warn" : "error", "javier.style_gate_degraded", {
              jobId,
              words: finalReport.words,
              profanityHits: finalReport.profanityHits,
              profanityTarget: finalReport.profanityTarget,
              profanityVariety: finalReport.profanityVariety,
              cubanTexture: finalReport.cubanTexture,
              clearsFloor,
              selected: rewriteScore >= firstScore ? "rewrite" : "original",
              firstScore,
              rewriteScore,
              failures: finalReport.failures,
            });
            // Style is not a safety boundary. A model may miss a quantitative
            // target, but the app must still return the best available answer.
            // Keeping this observable lets us tune Javier without breaking chat.
          } else {
            output = candidate;
            log("info", "javier.style_gate_passed_after_rewrite", {
              jobId,
              words: finalReport.words,
              profanityHits: finalReport.profanityHits,
              profanityVariety: finalReport.profanityVariety,
              cubanTexture: finalReport.cubanTexture,
            });
          }
        } else {
          log("info", "javier.style_gate_passed", {
            jobId,
            words: firstReport.words,
            profanityHits: firstReport.profanityHits,
            profanityVariety: firstReport.profanityVariety,
            cubanTexture: firstReport.cubanTexture,
          });
        }
        handlers.onDelta?.(output);
      }
      if (job.persona === "karen") {
        const firstReport = inspectKarenStyle(output);
        if (!firstReport.passes) {
          log("warn", "karen.style_gate_rewrite", { jobId, failures: firstReport.failures });
          this.db.updateJob(jobId, { progress: 80, message: "Karen is rejecting the polite draft" });
          const rewritten = await this.client.responses.create({
            model: job.model,
            reasoning: { effort: job.reasoningEffort },
            instructions: karenRewriteInstructions(firstReport),
            input: `DRAFT TO REWRITE:\n${output}`,
            store: false,
            safety_identifier: "agent-diaz-owner",
          } as any, { signal: controller.signal });
          const candidate = rewritten.output_text?.trim() ?? "";
          if (!candidate) throw new Error("Karen style rewrite returned no text");
          const finalReport = inspectKarenStyle(candidate);
          if (!finalReport.passes) {
            const clearsFloor = clearsKarenRewriteFloor(finalReport);
            const firstScore = karenStyleScore(firstReport);
            const rewriteScore = karenStyleScore(finalReport);
            output = rewriteScore >= firstScore ? candidate : output;
            log(clearsFloor ? "warn" : "error", "karen.style_gate_degraded", { jobId, clearsFloor, selected: rewriteScore >= firstScore ? "rewrite" : "original", failures: finalReport.failures });
          } else {
            output = candidate;
            log("info", "karen.style_gate_passed_after_rewrite", { jobId, words: finalReport.words, profanityHits: finalReport.profanityHits, profanityVariety: finalReport.profanityVariety, canadianTexture: finalReport.canadianTexture });
          }
        } else {
          log("info", "karen.style_gate_passed", { jobId, words: firstReport.words, profanityHits: firstReport.profanityHits, profanityVariety: firstReport.profanityVariety, canadianTexture: firstReport.canadianTexture });
        }
        handlers.onDelta?.(output);
      }
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
        persona: job.persona,
      });
    } catch (error: any) {
      const aborted = controller.signal.aborted || error?.name === "AbortError";
      if (aborted) {
        this.db.updateMessage(assistantMessageId, {
          content: bufferForStyleGate ? "" : output,
          status: "stopped",
          error: null,
        });
        this.db.updateJob(jobId, {
          status: "cancelled",
          message: "Stopped",
          outputText: bufferForStyleGate ? null : output || null,
          error: null,
        });
        handlers.onDone?.(bufferForStyleGate ? "" : output);
        log("info", "chat.stopped", { jobId });
      } else {
        const message =
          error instanceof Error ? error.message : "Unknown chat failure";
        this.db.updateMessage(assistantMessageId, {
          content: bufferForStyleGate ? "" : output,
          status: "failed",
          error: message,
        });
        this.db.updateJob(jobId, {
          status: "failed",
          message: "Failed",
          outputText: bufferForStyleGate ? null : output || null,
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

  private async awaitBackgroundResponse(
    jobId: string,
    initialResponse: any,
    createFreshResponse: () => Promise<any>,
    progressCap: number,
    progressLabel: string,
    persistentRetry = false,
  ): Promise<any | null> {
    let response = initialResponse,
      responseId = response.id as string,
      automaticRetries = 0;
    for (;;) {
      while (["queued", "in_progress"].includes(response.status)) {
        await sleep(1800);
        if (this.db.getJob(jobId)?.status === "cancelled") return null;
        response = await this.client.responses.retrieve(responseId);
        this.db.updateJob(jobId, {
          progress: Math.min(
            progressCap,
            (this.db.getJob(jobId)?.progress ?? 25) + 3,
          ),
          message: `${progressLabel}: ${response.status}`,
        });
      }
      if (this.captureApproval(jobId, response)) return null;
      if (response.status === "completed") return response;
      const providerError = providerFailureMessage(response);
      automaticRetries++;
      log("error", "provider.response_failed", {
        jobId,
        responseId: response.id,
        status: response.status,
        code: response?.error?.code,
        error: response?.error?.message,
        phase: progressLabel,
        automaticRetries,
        persistentRetry,
      });
      const mayRetry =
        persistentRetry ||
        (!this.config.MCP_SERVER_URL &&
          automaticRetries === 1 &&
          isTransientProviderFailure(response));
      if (!mayRetry) throw new Error(providerError);
      const delayMs = persistentRetry
        ? Math.min(30_000, 1200 * 2 ** Math.min(automaticRetries - 1, 5))
        : response?.error?.code === "rate_limit_exceeded"
          ? 5000
          : 1200;
      this.db.updateJob(jobId, {
        status: "running",
        error: null,
        message: persistentRetry
          ? `${progressLabel} hit an error; retrying automatically (attempt ${automaticRetries + 1})`
          : `${progressLabel} failed transiently; retrying once`,
      });
      await sleep(delayMs);
      if (this.db.getJob(jobId)?.status === "cancelled") return null;
      response = await createFreshResponse();
      responseId = response.id;
      this.db.updateJob(jobId, {
        providerResponseId: responseId,
        error: null,
        message: `${progressLabel} restarted`,
      });
    }
  }

  private async run(jobId: string): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job || ["completed", "cancelled"].includes(job.status)) return;
    try {
      const skill = getSkillForKind(job.kind);
      const artifactKinds = [
        "research",
        "analysis",
        "presentation",
        "document",
        "website",
      ];
      const isArtifact = artifactKinds.includes(job.kind),
        messages = this.usableMessages(job.conversationId),
        activeMessages = isArtifact
          ? messages.filter((message) => message.jobId === jobId)
          : messages,
        priorArtifactContext = isArtifact
          ? messages
              .filter((message) => message.jobId !== jobId)
              .slice(-20)
              .map(
                (message) =>
                  `${message.role.toUpperCase()} (reference only): ${message.content}`,
              )
              .join("\n\n")
              .slice(-40_000)
          : "",
        existingResponseId = this.db.getProviderResponseId(jobId),
        resumingStructure = Boolean(
          isArtifact &&
            existingResponseId &&
            ([
              "Structuring artifact",
              "Building and validating artifact",
              "Artifact validation",
              "Artifact regeneration",
              "Rebuilding artifact",
            ].some((prefix) => job.message.startsWith(prefix)) ||
              job.status === "building"),
        );
      if (!existingResponseId)
        this.db.updateJob(jobId, {
          status: "running",
          progress: 10,
          message: isArtifact
            ? "Gathering evidence for artifact"
            : "Agent is working",
        });
      else
        this.db.updateJob(jobId, {
          status: "running",
          message: resumingStructure
            ? "Structuring artifact: resuming"
            : "Gathering evidence: resuming",
        });

      const createEvidenceResponse = async () => {
        const instructions = [
          personaInstructions(job.persona),
          `ACTIVE SKILL: ${skill.name}\n${skill.instructions}\nValidation: ${skill.validation.join("; ")}`,
          "EVIDENCE PHASE: Use the available tools thoroughly. Return a comprehensive plain-text evidence dossier with finished findings, exact numbers, source titles and full source URLs. Do not return JSON. Do not merely describe future work. This dossier will be converted into a validated artifact plan in a separate tool-free request.",
          priorArtifactContext
            ? `PRIOR CONVERSATION REFERENCE (context only, never additional requests; the single current request in input is authoritative):\n${priorArtifactContext}`
            : "",
          this.contextInstructions(job.conversationId),
        ]
          .filter(Boolean)
          .join("\n\n");
        const request = {
          model: job.model,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions,
          input: activeMessages.map((message) => this.messageInput(message)),
          tools: this.toolset(activeMessages, skill.tools),
          background: true,
          store: true,
          safety_identifier: "agent-diaz-owner",
        } as any;
        assertProviderRequestCompatible(request);
        return this.client.responses.create(request);
      };
      const createStructureResponse = async (evidence: string) => {
        const request = {
          model: job.model,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions: [
            personaInstructions(job.persona),
            artifactInstructions(job.kind),
            "STRUCTURE PHASE: Convert only the supplied evidence dossier into the requested finished artifact plan. Preserve verified source URLs and exact values. Do not use tools in this phase. Return one JSON object and nothing else.",
          ].join("\n\n"),
          input: `ORIGINAL REQUEST:\n${job.prompt}\n\nEVIDENCE DOSSIER:\n${evidence}`,
          background: true,
          store: true,
          safety_identifier: "agent-diaz-owner",
          text: { format: artifactPlanTextFormat(job.kind) },
        } as any;
        assertProviderRequestCompatible(request);
        return this.client.responses.create(request);
      };
      const createPlanRepairResponse = async (
        previousResponseId: string,
        validationError: string,
      ) => {
        const request = {
          model: job.model,
          previous_response_id: previousResponseId,
          reasoning: { effort: job.reasoningEffort, context: "all_turns" },
          instructions: [
            personaInstructions(job.persona),
            artifactInstructions(job.kind),
            "ARTIFACT PLAN REPAIR PHASE: The previous complete plan failed deterministic validation. Correct the entire plan using the original request and evidence already present in the response chain. Preserve verified facts, exact values, source URLs, and all valid content. Do not research again, do not use tools, and do not explain the correction. Return one corrected complete JSON artifact plan and nothing else.",
          ].join("\n\n"),
          input: `DETERMINISTIC VALIDATION ERROR:\n${validationError}\n\nReturn a corrected complete plan that satisfies every stated structural and visual requirement.`,
          background: true,
          store: true,
          safety_identifier: "agent-diaz-owner",
          text: { format: artifactPlanTextFormat(job.kind) },
        } as any;
        assertProviderRequestCompatible(request);
        return this.client.responses.create(request);
      };

      let response: any,
        output = "";
      if (isArtifact) {
        let structureResponse: any;
        if (resumingStructure) {
          structureResponse = await this.client.responses.retrieve(
            existingResponseId!,
          );
        } else {
          let evidenceResponse: any;
          if (existingResponseId)
            evidenceResponse = await this.client.responses.retrieve(
              existingResponseId,
            );
          else {
            evidenceResponse = await createEvidenceResponse();
            this.db.updateJob(jobId, {
              providerResponseId: evidenceResponse.id,
              progress: 20,
              message: "Gathering evidence: started",
            });
          }
          evidenceResponse = await this.awaitBackgroundResponse(
            jobId,
            evidenceResponse,
            createEvidenceResponse,
            58,
            "Gathering evidence",
            true,
          );
          if (!evidenceResponse) return;
          const evidence = evidenceResponse.output_text?.trim() || "";
          if (!evidence)
            throw new Error("Evidence phase returned no usable content");
          structureResponse = await createStructureResponse(evidence);
          this.db.updateJob(jobId, {
            providerResponseId: structureResponse.id,
            progress: 62,
            message: "Structuring artifact: started",
          });
        }
        structureResponse = await this.awaitBackgroundResponse(
          jobId,
          structureResponse,
          () =>
            this.client.responses.create({
              model: job.model,
              previous_response_id: structureResponse.id,
              reasoning: {
                effort: job.reasoningEffort,
                context: "all_turns",
              },
              instructions:
                "Retry the artifact structure phase from the original request and evidence in the previous response. Return one complete JSON artifact plan only. Do not use tools.",
              input:
                "Reconstruct the complete artifact plan; the previous structure attempt failed transiently.",
              background: true,
              store: true,
              safety_identifier: "agent-diaz-owner",
              text: { format: artifactPlanTextFormat(job.kind) },
            } as any),
          79,
          "Structuring artifact",
          true,
        );
        if (!structureResponse) return;
        response = structureResponse;
        output = response.output_text?.trim() || "";
        if (!output)
          throw new Error("Structure phase returned no artifact plan");
        this.db.updateJob(jobId, {
          status: "building",
          progress: 82,
          message: "Building and validating artifact",
        });
        if (!this.db.listArtifacts(jobId).length) {
          const minVisuals = getSkillForKind(job.kind).minVisuals;
          let plan: any;
          let repairAttempt = 0;
          let buildAttempt = 0;

          for (;;) {
            if (this.db.getJob(jobId)?.status === "cancelled") return;

            for (;;) {
              try {
                plan = parseArtifactPlan(
                  job.kind,
                  output,
                  minVisuals,
                  job.prompt,
                );
                if (repairAttempt > 0)
                  log("info", "artifact.plan_repaired", {
                    jobId,
                    kind: job.kind,
                    attempt: repairAttempt,
                    sectionCount: plan.sections.length,
                  });
                break;
              } catch (planError) {
                repairAttempt++;
                const validationError = errorMessage(planError);
                log("warn", "artifact.plan_validation_failed", {
                  jobId,
                  kind: job.kind,
                  attempt: repairAttempt,
                  sectionCount: planSectionCount(output),
                  error: validationError,
                });
                this.db.updateJob(jobId, {
                  status: "running",
                  progress: Math.min(91, 83 + repairAttempt),
                  error: null,
                  message: `Structuring artifact: validation found an issue; repairing automatically (attempt ${repairAttempt})`,
                });
                const parentResponseId = response.id as string;
                if (repairAttempt > 1)
                  await sleep(Math.min(12_000, 800 * 2 ** Math.min(repairAttempt - 2, 4)));
                if (this.db.getJob(jobId)?.status === "cancelled") return;
                let repairResponse = await createPlanRepairResponse(
                  parentResponseId,
                  validationError,
                );
                this.db.updateJob(jobId, {
                  providerResponseId: repairResponse.id,
                  error: null,
                  message: `Structuring artifact: repair attempt ${repairAttempt} started`,
                });
                repairResponse = await this.awaitBackgroundResponse(
                  jobId,
                  repairResponse,
                  () =>
                    createPlanRepairResponse(
                      parentResponseId,
                      validationError,
                    ),
                  91,
                  "Structuring artifact: repair",
                  true,
                );
                if (!repairResponse) return;
                response = repairResponse;
                output = repairResponse.output_text?.trim() || "";
                if (!output) {
                  log("warn", "artifact.plan_repair_empty", {
                    jobId,
                    kind: job.kind,
                    attempt: repairAttempt,
                  });
                  output = "{}";
                }
              }
            }

            this.db.updateJob(jobId, {
              status: "building",
              progress: Math.min(96, 90 + Math.min(buildAttempt, 6)),
              error: null,
              message:
                buildAttempt === 0
                  ? "Building and validating artifact"
                  : `Rebuilding artifact after validation repair (attempt ${buildAttempt + 1})`,
            });

            try {
              const file = await buildArtifact(
                this.config,
                job.kind,
                plan,
                job.prompt,
              );
              const id = crypto.randomUUID();
              this.db.addArtifact({
                id,
                jobId,
                name: file.name,
                mime: file.mime,
                size: file.size,
                path: file.path,
                receipt: file.validationReceipt,
              });
              log("info", "artifact.build_validated", {
                jobId,
                kind: job.kind,
                buildAttempt: buildAttempt + 1,
                repairAttempt,
                name: file.name,
                size: file.size,
                buildSha: file.validationReceipt.buildSha,
                artifactSha256: file.validationReceipt.artifactSha256,
                knownBenignFindings:
                  file.validationReceipt.knownBenignFindings.length,
              });
              break;
            } catch (buildError) {
              buildAttempt++;
              const validationError = errorMessage(buildError);
              log("warn", "artifact.build_validation_failed_retriable", {
                jobId,
                kind: job.kind,
                buildAttempt,
                repairAttempt,
                error: validationError,
              });
              this.db.updateJob(jobId, {
                status: "running",
                progress: Math.min(96, 91 + Math.min(buildAttempt, 5)),
                error: null,
                message: `Artifact validation found an issue; regenerating automatically (attempt ${buildAttempt + 1})`,
              });
              const parentResponseId = response.id as string;
              await sleep(Math.min(15_000, 1000 * 2 ** Math.min(buildAttempt - 1, 4)));
              if (this.db.getJob(jobId)?.status === "cancelled") return;
              let repairResponse = await createPlanRepairResponse(
                parentResponseId,
                `BUILT ARTIFACT ERROR:\n${validationError}\n\nThe package was not published. Repair the plan so a fresh build avoids this error while preserving every user requirement and all verified evidence.`,
              );
              this.db.updateJob(jobId, {
                providerResponseId: repairResponse.id,
                error: null,
                message: `Artifact regeneration: repair attempt ${buildAttempt} started`,
              });
              repairResponse = await this.awaitBackgroundResponse(
                jobId,
                repairResponse,
                () =>
                  createPlanRepairResponse(
                    parentResponseId,
                    `BUILT ARTIFACT ERROR:\n${validationError}\n\nRegenerate a corrected complete plan. Do not use tools or repeat research.`,
                  ),
                96,
                "Artifact regeneration",
                true,
              );
              if (!repairResponse) return;
              response = repairResponse;
              output = repairResponse.output_text?.trim() || "{}";
            }
          }
        } else
          log("info", "artifact.build_resume_reused", {
            jobId,
            artifactCount: this.db.listArtifacts(jobId).length,
          });
      } else {
        response = existingResponseId
          ? await this.client.responses.retrieve(existingResponseId)
          : await createEvidenceResponse();
        if (!existingResponseId)
          this.db.updateJob(jobId, {
            providerResponseId: response.id,
            progress: 25,
            message: "Background response started",
          });
        response = await this.awaitBackgroundResponse(
          jobId,
          response,
          createEvidenceResponse,
          75,
          "Agent",
        );
        if (!response) return;
        output = response.output_text?.trim() || "";
      }
      const userOutput = isArtifact
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
      const current = this.db.getJob(jobId);
      const artifactKinds = [
        "research",
        "analysis",
        "presentation",
        "document",
        "website",
      ];
      if (
        current &&
        current.status !== "cancelled" &&
        artifactKinds.includes(current.kind)
      ) {
        const restartEvidencePhase =
          current.message.startsWith("Gathering evidence") ||
          (!this.db.getProviderResponseId(jobId) && current.progress < 62);
        this.db.updateJob(jobId, {
          status: "running",
          progress: Math.max(10, Math.min(95, current.progress)),
          message: restartEvidencePhase
            ? "Gathering evidence: unexpected pipeline error; restarting automatically"
            : "Structuring artifact: unexpected pipeline error; restarting automatically",
          error: null,
        });
        const existing = this.db.raw
          .prepare(
            "SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1",
          )
          .get(jobId) as { id: string } | undefined;
        if (existing)
          this.db.updateMessage(existing.id, {
            status: "streaming",
            error: null,
          });
        log("error", "artifact.pipeline_restart_scheduled", {
          jobId,
          kind: current.kind,
          error: message,
        });
        setTimeout(() => this.start(jobId), 5000);
        return;
      }
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
