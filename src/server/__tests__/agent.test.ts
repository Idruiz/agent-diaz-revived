import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { openDatabase } from "../db";
import {
  AgentRunner,
  artifactPlanTextFormat,
  assertProviderRequestCompatible,
  isValidWav,
  modelProfileFor,
  sanitizeStructuredOutputSchema,
  validateArtifactPlan,
} from "../openai-agent";
import { inspectJavierStyle } from "../javier-style";
import type { Config } from "../config";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-agent-"));
  roots.push(root);
  const config = {
    root,
    storageRoot: root,
    dataDir: path.join(root, "data"),
    artifactDir: path.join(root, "artifacts"),
    uploadDir: path.join(root, "uploads"),
    NODE_ENV: "test",
    PORT: 3000,
    BASE_URL: "http://localhost:3000",
    OPENAI_API_KEY: crypto.randomUUID(),
    ADMIN_PASSWORD: crypto.randomUUID(),
    OPENAI_MODEL: "gpt-5.6",
    OPENAI_FAST_MODEL: "gpt-5.6-terra",
    OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
    STORAGE_DIR: "",
    SESSION_DAYS: 7,
    MAX_UPLOAD_MB: 25,
    IMAGE_PROVIDER: "wikimedia",
    MCP_SERVER_URL: "",
    MCP_SERVER_LABEL: "workspace",
    MCP_AUTHORIZATION: "",
  } satisfies Config;
  fs.mkdirSync(config.uploadDir, { recursive: true });
  return { config, db: openDatabase(config) };
}
describe("agent production paths", () => {
  it("streams multimodal chat, enables Python for a spreadsheet, and persists the final assistant turn", async () => {
    const { config, db } = harness(),
      conversation = db.createConversation(crypto.randomUUID(), "Files");
    db.setConversationSettings(conversation.id, {
      modelMode: "balanced",
      persona: "mara",
    });
    const imageId = crypto.randomUUID(),
      sheetId = crypto.randomUUID();
    db.addUpload({
      id: imageId,
      name: "photo.png",
      mime: "image/png",
      size: 2000,
      path: "/tmp/photo.png",
      openaiFileId: "file_image",
    });
    db.addUpload({
      id: sheetId,
      name: "results.csv",
      mime: "text/csv",
      size: 3000,
      path: "/tmp/results.csv",
      openaiFileId: "file_sheet",
    });
    const profile = modelProfileFor("balanced"),
      job = db.createJob({
        id: crypto.randomUUID(),
        kind: "chat",
        prompt: "Inspect both files",
        conversationId: conversation.id,
        fileIds: [imageId, sheetId],
        ...profile,
      }),
      assistantId = crypto.randomUUID();
    db.addMessage({
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      jobId: job.id,
      status: "streaming",
    });
    async function* events() {
      yield { type: "response.created", response: { id: "resp_test" } };
      yield { type: "response.output_text.delta", delta: "Evidence " };
      yield { type: "response.output_text.delta", delta: "received." };
    }
    const create = vi.fn(async (_request: any) => events()),
      runner = new AgentRunner(config, db);
    (runner as any).client = { responses: { create } };
    const deltas: string[] = [];
    await runner.streamChat(job.id, assistantId, {
      onDelta: (delta) => deltas.push(delta),
    });
    const request = create.mock.calls[0]![0] as any,
      user = request.input.find((item: any) => item.role === "user");
    expect(request).toMatchObject({
      model: "gpt-5.6-terra",
      reasoning: { effort: "medium" },
      stream: true,
      store: true,
    });
    expect(request.instructions).toContain("CURRENT PERSONA: Mara");
    expect(request.instructions).toContain("strict validation");
    expect(user.content).toEqual(
      expect.arrayContaining([
        { type: "input_image", file_id: "file_image", detail: "auto" },
        { type: "input_file", file_id: "file_sheet" },
      ]),
    );
    expect(request.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "code_interpreter" }),
      ]),
    );
    expect(deltas.join("")).toBe("Evidence received.");
    expect(db.getJob(job.id)?.status).toBe("completed");
    expect(
      db
        .listMessages(conversation.id)
        .find((message) => message.id === assistantId),
    ).toMatchObject({ content: "Evidence received.", status: "complete" });
    db.close();
  });
  it("mints a short-lived Realtime credential with Javier's server-owned voice and accent", async () => {
    const { config, db } = harness(),
      conversation = db.createConversation(crypto.randomUUID(), "Voice");
    db.setConversationSettings(conversation.id, { persona: "javier" });
    db.addVoiceTurn({
      conversationId: conversation.id,
      userId: crypto.randomUUID(),
      assistantId: crypto.randomUUID(),
      userText: "Hello Díaz",
      assistantText: "Hello comandante",
      persona: "javier",
    });
    const create = vi.fn(async (_body: any, _options: any) => ({
        value: "ek_ephemeral",
        expires_at: 12345,
        session: {},
      })),
      runner = new AgentRunner(config, db);
    (runner as any).client = { realtime: { clientSecrets: { create } } };
    const token = await runner.createRealtimeToken(conversation.id),
      [body, options] = create.mock.calls[0]! as any;
    expect(token).toEqual({
      value: "ek_ephemeral",
      expiresAt: 12345,
      model: "gpt-realtime-2.1-mini",
      voice: "echo",
      persona: "javier",
    });
    expect(body).toMatchObject({
      expires_after: { seconds: 120 },
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1-mini",
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-mini-transcribe",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.35,
              prefix_padding_ms: 500,
              silence_duration_ms: 700,
              create_response: false,
              interrupt_response: false,
            },
          },
          output: { voice: "echo" },
        },
      },
    });
    expect(body.session.instructions).toContain("Hello Díaz");
    expect(body.session.instructions).toContain("CURRENT PERSONA: Javier");
    expect(body.session.instructions).toContain("lively adult Cuban cadence");
    expect(body.session.instructions).toContain("street-level rhythm");
    expect(body.session.instructions).toContain("esto es una morronga");
    expect(body.session.instructions).toContain("que se vaya pa casa del carajo");
    expect(body.session.instructions).toContain(
      "university-trained assistant wearing Cuban slang",
    );
    expect(body.session.instructions.lastIndexOf("JAVIER FINAL OUTPUT CONTRACT")).toBeGreaterThan(
      body.session.instructions.lastIndexOf("OLDER DURABLE MEMORY"),
    );
    expect(options.headers["OpenAI-Safety-Identifier"]).toBe(
      "agent-diaz-owner",
    );
    expect(JSON.stringify(body.session.audio.input.transcription)).not.toContain(
      "Preserve Cuban words",
    );
    expect(JSON.stringify(token)).not.toContain(config.OPENAI_API_KEY);
    db.close();
  });

  it("renders the canonical Javier text verbatim through non-interruptible TTS", async () => {
    const { config, db } = harness(),
      conversation = db.createConversation(crypto.randomUUID(), "Javier speech");
    db.setConversationSettings(conversation.id, { persona: "javier" });
    const audioBytes = Buffer.alloc(48);
    audioBytes.write("RIFF", 0, "ascii");
    audioBytes.writeUInt32LE(40, 4);
    audioBytes.write("WAVEfmt ", 8, "ascii");
    audioBytes.writeUInt32LE(16, 16);
    audioBytes.writeUInt16LE(1, 20);
    audioBytes.writeUInt16LE(1, 22);
    audioBytes.writeUInt32LE(24_000, 24);
    audioBytes.writeUInt32LE(48_000, 28);
    audioBytes.writeUInt16LE(2, 32);
    audioBytes.writeUInt16LE(16, 34);
    audioBytes.write("data", 36, "ascii");
    audioBytes.writeUInt32LE(4, 40);
    const create = vi.fn(async () => ({
        arrayBuffer: async () => audioBytes.buffer,
      })),
      runner = new AgentRunner(config, db);
    (runner as any).client = { audio: { speech: { create } } };
    const text =
      "Asere, esto es una morronga y esa hijadeputá se va pa casa del carajo.";
    const audio = await runner.createSpeech(conversation.id, text),
      [body, options] = create.mock.calls[0]! as any;
    expect(isValidWav(audio)).toBe(true);
    expect(body).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: "echo",
      input: text,
      response_format: "wav",
    });
    expect(body.instructions).toContain("Read the supplied text completely and verbatim");
    expect(body.instructions).toContain("irreverent, volatile, subversive");
    expect(body.instructions).toContain("Do not summarize, soften, censor, omit");
    expect(options.headers["OpenAI-Safety-Identifier"]).toBe(
      "agent-diaz-owner",
    );
    db.close();
  });

  it("rejects the exact tool plus JSON provider contract that broke every artifact route", () => {
    expect(() =>
      assertProviderRequestCompatible({
        tools: [{ type: "web_search" }],
        text: { format: { type: "json_object" } },
      }),
    ).toThrow("tool-enabled requests cannot use JSON response mode");
    expect(() =>
      assertProviderRequestCompatible({
        tools: [{ type: "code_interpreter" }],
        text: { format: { type: "json_schema" } },
      }),
    ).toThrow("tool-enabled requests cannot use JSON response mode");
    expect(() =>
      assertProviderRequestCompatible({ tools: [{ type: "web_search" }] }),
    ).not.toThrow();
    expect(() =>
      assertProviderRequestCompatible({
        text: { format: { type: "json_object" } },
      }),
    ).not.toThrow();
  });

  it("keeps persistent artifact retries active even when workspace MCP is configured", async () => {
    const { config, db } = harness();
    config.MCP_SERVER_URL = "https://workspace.example.test/mcp";
    const conversation = db.createConversation(
      crypto.randomUUID(),
      "Persistent artifact retry",
    );
    const job = db.createJob({
      id: crypto.randomUUID(),
      kind: "document",
      prompt: "Create a production document",
      conversationId: conversation.id,
      fileIds: [],
      ...modelProfileFor("balanced"),
    });
    const createFresh = vi.fn(async () => ({
      id: "resp_retry_success",
      status: "completed",
      output_text: "Recovered artifact phase",
      output: [],
    }));
    const runner = new AgentRunner(config, db);
    (runner as any).client = {
      responses: {
        retrieve: vi.fn(),
      },
    };

    const response = await (runner as any).awaitBackgroundResponse(
      job.id,
      {
        id: "resp_retry_failure",
        status: "failed",
        error: { code: "server_error", message: "Temporary provider fault" },
        output: [],
      },
      createFresh,
      58,
      "Gathering evidence",
      true,
    );

    expect(createFresh).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      id: "resp_retry_success",
      status: "completed",
    });
    expect(db.getJob(job.id)).toMatchObject({
      status: "running",
      error: null,
    });
    db.close();
  });

  it("removes unsupported URI formats from every artifact structure request", () => {
    const format = artifactPlanTextFormat() as any,
      sourceUrl = format.schema.properties.sources.items.properties.url;
    expect(format).toMatchObject({
      type: "json_schema",
      name: "artifact_plan",
      strict: true,
    });
    expect(sourceUrl).toEqual({ type: "string" });
    expect(JSON.stringify(format.schema)).not.toContain('"format":"uri"');
    expect(
      sanitizeStructuredOutputSchema({
        contact: { type: "string", format: "email" },
        source: { type: "string", format: "uri" },
      }),
    ).toEqual({
      contact: { type: "string", format: "email" },
      source: { type: "string" },
    });
  });

  it("enforces the presentation section boundary in both provider and deterministic validation", () => {
    const format = artifactPlanTextFormat("presentation") as any;
    expect(format.schema.properties.sections).toMatchObject({
      minItems: 7,
      maxItems: 11,
    });
    const planWithSections = (count: number) => ({
      title: "Presentation boundary",
      subtitle: "Exact section contract",
      sections: Array.from({ length: count }, (_, index) => ({
        heading: `Section ${index + 1}`,
        body: `Finished content for section ${index + 1}.`,
        bullets: [],
        speakerNotes: "",
        imageQuery: `documentary classroom scene ${index + 1}`,
      })),
      sources: [],
    });
    expect(() =>
      validateArtifactPlan("presentation", planWithSections(6), 5),
    ).toThrow("expected 7-11 content sections");
    expect(() =>
      validateArtifactPlan("presentation", planWithSections(7), 5),
    ).not.toThrow();
    expect(() =>
      validateArtifactPlan("presentation", planWithSections(11), 5),
    ).not.toThrow();
    expect(() =>
      validateArtifactPlan("presentation", planWithSections(12), 5),
    ).toThrow("expected 7-11 content sections");
  });

  it("runs artifact evidence and JSON structuring as two incompatible-safe provider phases", async () => {
    const { config, db } = harness(),
      conversation = db.createConversation(
        crypto.randomUUID(),
        "Artifact pipeline",
      );
    fs.mkdirSync(config.artifactDir, { recursive: true });
    const profile = modelProfileFor("balanced"),
      staleJob = db.createJob({
        id: crypto.randomUUID(),
        kind: "presentation",
        prompt: "STALE REQUEST: build unrelated slides",
        conversationId: conversation.id,
        fileIds: [],
        ...profile,
      });
    db.updateJob(staleJob.id, {
      status: "failed",
      message: "Failed",
      error: "Old failure",
    });
    const job = db.createJob({
        id: crypto.randomUUID(),
        kind: "research",
        prompt: "Research a verified three-step workflow",
        conversationId: conversation.id,
        fileIds: [],
        ...profile,
      }),
      plan = {
        title: "Verified workflow",
        subtitle: "Two-phase provider integration",
        requirements: [{ id: "R1", text: "Research and explain a verified three-step workflow", mandatory: true }],
        sections: [
          {
            heading: "Evidence",
            body: "The evidence phase gathers source material before structuring.",
            bullets: ["Search first", "Preserve exact sources"],
            speakerNotes: "",
            table: {
              title: "Provider phases",
              headers: ["Phase", "Mode"],
              rows: [
                ["Evidence", "Tools"],
                ["Structure", "JSON"],
              ],
            },
          },
          {
            heading: "Separation",
            body: "Tool execution and JSON mode never share one request.",
            bullets: [],
            speakerNotes: "",
            diagram: {
              title: "Safe pipeline",
              nodes: ["Evidence", "Structure", "Build"],
              caption: "Each phase has one responsibility.",
            },
          },
          {
            heading: "Validation",
            body: "The deterministic builder validates and writes the file.",
            bullets: [],
            speakerNotes: "",
            imageQuery: "software validation workflow photograph",
          },
        ],
        sources: [
          {
            title: "OpenAI web search documentation",
            url: "https://developers.openai.com/api/docs/guides/tools-web-search",
          },
        ],
      },
      providerPlan = {
        ...plan,
        pages: null,
        sections: plan.sections.map((section) => ({
          requirementIds: ["R1"],
          layout: "auto",
          activity: null,
          table: null,
          chart: null,
          diagram: null,
          imageQuery: null,
          ...section,
        })),
      },
      create = vi.fn(async (request: any) =>
        request.tools?.length
          ? {
              id: "resp_evidence",
              status: "completed",
              output_text:
                "Verified evidence dossier with exact source URLs and findings.",
              output: [],
            }
          : {
              id: "resp_structure",
              status: "completed",
              output_text: JSON.stringify(providerPlan),
              output: [],
            },
      ),
      runner = new AgentRunner(config, db);
    (runner as any).client = {
      responses: { create, retrieve: vi.fn() },
    };

    const imageBytes = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: "#2f739c",
      },
    }).jpeg().toBuffer();
    const imageFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("commons.wikimedia.org/w/api.php"))
        return new Response(JSON.stringify({query:{pages:{1:{title:"Validation workflow",imageinfo:[{thumburl:"https://images.example.test/workflow.jpg",descriptionurl:"https://commons.wikimedia.org/wiki/File:Workflow.jpg",width:1200,height:800,extmetadata:{ObjectName:{value:"Validation workflow"},Artist:{value:"Test photographer"},LicenseShortName:{value:"CC BY 4.0"}}}]}}}}),{status:200,headers:{"content-type":"application/json"}});
      if (url === "https://images.example.test/workflow.jpg")
        return new Response(imageBytes,{status:200,headers:{"content-type":"image/jpeg"}});
      throw new Error(`Unexpected fetch in artifact test: ${url}`);
    });

    await (runner as any).run(job.id);
    imageFetch.mockRestore();

    expect(create).toHaveBeenCalledTimes(2);
    const evidenceRequest = create.mock.calls[0]![0] as any,
      structureRequest = create.mock.calls[1]![0] as any;
    expect(evidenceRequest.tools).toEqual([{ type: "web_search" }]);
    expect(evidenceRequest.text).toBeUndefined();
    expect(evidenceRequest.instructions).toContain("Do not return JSON");
    expect(evidenceRequest.instructions).toContain(
      "STALE REQUEST: build unrelated slides",
    );
    expect(JSON.stringify(evidenceRequest.input)).not.toContain(
      "STALE REQUEST: build unrelated slides",
    );
    expect(JSON.stringify(evidenceRequest.input)).toContain(
      "Research a verified three-step workflow",
    );
    expect(structureRequest.tools).toBeUndefined();
    expect(structureRequest.text.format).toMatchObject({
      type: "json_schema",
      name: "artifact_plan",
      strict: true,
    });
    const schema = artifactPlanTextFormat().schema as any;
    expect(schema.required).toEqual(expect.arrayContaining(["requirements", "sections", "pages"]));
    expect(schema.properties.sections.items.required).toEqual(
      expect.arrayContaining([
        "table",
        "chart",
        "diagram",
        "imageQuery",
      ]),
    );
    expect(structureRequest.text.format.schema).toEqual(schema);
    expect(structureRequest.input).toContain("Verified evidence dossier");
    expect(db.getJob(job.id)).toMatchObject({
      status: "completed",
      error: null,
    });
    const artifacts = db.listArtifacts(job.id);
    expect(artifacts).toHaveLength(1);
    expect(fs.existsSync(path.join(config.artifactDir, artifacts[0]!.name))).toBe(
      true,
    );
    db.close();
  });

  it("completes every artifact route through evidence, structure, build, validation, and persistence", async () => {
    const kinds = [
      "research",
      "analysis",
      "presentation",
      "document",
      "website",
    ] as const;
    const expectedTool = {
      research: "web_search",
      analysis: "code_interpreter",
      presentation: "web_search",
      document: "web_search",
      website: "web_search",
    } as const;
    const expectedExtension = {
      research: ".docx",
      analysis: ".docx",
      presentation: ".pptx",
      document: ".docx",
      website: ".zip",
    } as const;

    const makeSection = (
      heading: string,
      index: number,
      extra: Record<string, unknown> = {},
    ) => ({
      heading,
      body:
        `Finished audience-facing content for ${heading}. This section contains enough concrete explanatory material to survive output coverage validation and remain useful in the finished artifact.`,
      bullets: [
        `Verified point ${index + 1}A with complete explanatory context.`,
        `Verified point ${index + 1}B with complete explanatory context.`,
      ],
      speakerNotes: `Explain ${heading} with the evidence in this section.`,
      requirementIds: ["R1"],
      layout: "standard",
      ...extra,
    });

    const planFor = (kind: (typeof kinds)[number]) => {
      const requirements = [
        {
          id: "R1",
          text: `Create the requested production-ready ${kind} artifact`,
          mandatory: true,
        },
      ];
      const sources = [
        {
          title: "Verified fixture source",
          url: "https://example.com/verified-source",
        },
      ];

      if (kind === "presentation") {
        const sections = Array.from({ length: 7 }, (_, index) =>
          makeSection(`Presentation section ${index + 1}`, index, {
            ...(index < 3
              ? { imageQuery: `documentary classroom route ${index + 1}` }
              : {}),
            ...(index === 3
              ? {
                  table: {
                    title: "Route matrix",
                    headers: ["Route", "Status"],
                    rows: [
                      ["Evidence", "Validated"],
                      ["Build", "Validated"],
                    ],
                  },
                }
              : {}),
            ...(index === 4
              ? {
                  diagram: {
                    title: "Artifact pipeline",
                    nodes: ["Evidence", "Structure", "Build", "Validate"],
                    caption: "Every stage is exercised.",
                  },
                }
              : {}),
          }),
        );
        return {
          title: "Presentation route validation",
          subtitle: "End-to-end production path",
          requirements,
          sections,
          sources,
        };
      }

      if (kind === "website") {
        const sections = Array.from({ length: 4 }, (_, index) =>
          makeSection(`Website section ${index + 1}`, index, {
            imageQuery: `documentary website route ${index + 1}`,
          }),
        );
        return {
          title: "Website route validation",
          subtitle: "End-to-end production path",
          requirements,
          sections,
          pages: [
            {
              slug: "index",
              title: "Home",
              description: "Primary route validation page",
              sectionHeadings: ["Website section 1", "Website section 2"],
            },
            {
              slug: "details",
              title: "Details",
              description: "Supporting route validation page",
              sectionHeadings: ["Website section 3"],
            },
            {
              slug: "resources",
              title: "Resources",
              description: "Final route validation page",
              sectionHeadings: ["Website section 4"],
            },
          ],
          sources,
        };
      }

      if (kind === "analysis") {
        return {
          title: "Analysis route validation",
          subtitle: "Executed-data production path",
          requirements,
          sections: [
            makeSection("Method", 0),
            makeSection("Executed findings", 1, {
              chart: {
                title: "Executed values",
                type: "bar",
                labels: ["A", "B", "C"],
                series: [{ name: "Score", values: [10, 20, 30] }],
                unit: "points",
                sourceNote: "Executed fixture analysis",
              },
            }),
            makeSection("Exact results", 2, {
              table: {
                title: "Executed result table",
                headers: ["Item", "Score"],
                rows: [
                  ["A", "10"],
                  ["B", "20"],
                  ["C", "30"],
                ],
              },
            }),
            makeSection("Limitations", 3),
            makeSection("Conclusion", 4),
          ],
          sources,
        };
      }

      return {
        title:
          kind === "research"
            ? "Research route validation"
            : "Document route validation",
        subtitle: "End-to-end production path",
        requirements,
        sections: [
          makeSection("Executive summary", 0, {
            imageQuery: `documentary ${kind} route photograph`,
          }),
          makeSection("Evidence", 1, {
            table: {
              title: "Evidence matrix",
              headers: ["Stage", "Result"],
              rows: [
                ["Evidence", "Complete"],
                ["Validation", "Complete"],
              ],
            },
          }),
          makeSection("Process", 2, {
            diagram: {
              title: "Validated workflow",
              nodes: ["Request", "Evidence", "Build", "Validate"],
              caption: "The route remains deterministic after structuring.",
            },
          }),
          makeSection("Implications", 3),
          makeSection("Conclusion", 4),
        ],
        sources,
      };
    };

    const imageBytes = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: "#2f739c",
      },
    })
      .jpeg()
      .toBuffer();

    const imageFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("commons.wikimedia.org/w/api.php"))
          return new Response(
            JSON.stringify({
              query: {
                pages: {
                  1: {
                    title: "Route validation image",
                    imageinfo: [
                      {
                        thumburl:
                          "https://images.example.test/route-validation.jpg",
                        descriptionurl:
                          "https://commons.wikimedia.org/wiki/File:Route_validation.jpg",
                        width: 1200,
                        height: 800,
                        extmetadata: {
                          ObjectName: { value: "Route validation image" },
                          Artist: { value: "Test photographer" },
                          LicenseShortName: { value: "CC BY 4.0" },
                        },
                      },
                    ],
                  },
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        if (url === "https://images.example.test/route-validation.jpg")
          return new Response(imageBytes, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        throw new Error(`Unexpected fetch in route matrix test: ${url}`);
      });

    try {
      for (const kind of kinds) {
        const { config, db } = harness();
        fs.mkdirSync(config.artifactDir, { recursive: true });
        const conversation = db.createConversation(
          crypto.randomUUID(),
          `${kind} route`,
        );

        let fileIds: string[] = [];
        if (kind === "analysis") {
          const uploadId = crypto.randomUUID();
          const csvPath = path.join(config.uploadDir, "analysis-route.csv");
          fs.writeFileSync(csvPath, "label,value\\nA,10\\nB,20\\nC,30\\n");
          db.addUpload({
            id: uploadId,
            name: "analysis-route.csv",
            mime: "text/csv",
            size: fs.statSync(csvPath).size,
            path: csvPath,
            openaiFileId: "file_analysis_route",
          });
          fileIds = [uploadId];
        }

        const job = db.createJob({
          id: crypto.randomUUID(),
          kind,
          prompt: `Create the requested production-ready ${kind} artifact`,
          conversationId: conversation.id,
          fileIds,
          ...modelProfileFor("balanced"),
        });
        const plan = planFor(kind);
        const create = vi.fn(async (request: any) => {
          if (request.tools?.length)
            return {
              id: `resp_${kind}_evidence`,
              status: "completed",
              output_text:
                "Verified evidence dossier with complete findings and https://example.com/verified-source.",
              output: [],
            };
          return {
            id: `resp_${kind}_structure`,
            status: "completed",
            output_text: JSON.stringify(plan),
            output: [],
          };
        });
        const runner = new AgentRunner(config, db);
        (runner as any).client = {
          responses: { create, retrieve: vi.fn() },
        };

        await (runner as any).run(job.id);

        const evidenceRequest = create.mock.calls[0]![0] as any;
        expect(evidenceRequest.tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: expectedTool[kind] }),
          ]),
        );
        if (kind === "analysis")
          expect(evidenceRequest.tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "code_interpreter",
                container: expect.objectContaining({
                  file_ids: ["file_analysis_route"],
                }),
              }),
            ]),
          );

        const completed = db.getJob(job.id);
        expect(completed).toMatchObject({
          status: "completed",
          progress: 100,
          error: null,
        });
        const artifacts = db.listArtifacts(job.id);
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]!.name.endsWith(expectedExtension[kind])).toBe(true);
        expect(
          fs.existsSync(path.join(config.artifactDir, artifacts[0]!.name)),
        ).toBe(true);
        expect(completed?.outputText).toContain(`Completed ${kind} artifact`);
        db.close();
      }
    } finally {
      imageFetch.mockRestore();
    }
  });

  it("repairs an invalid presentation plan without repeating the evidence phase", async () => {
    const { config, db } = harness(),
      conversation = db.createConversation(
        crypto.randomUUID(),
        "Presentation repair",
      );
    fs.mkdirSync(config.artifactDir, { recursive: true });
    const job = db.createJob({
        id: crypto.randomUUID(),
        kind: "presentation",
        prompt: "Build a seven-section visual presentation",
        conversationId: conversation.id,
        fileIds: [],
        ...modelProfileFor("balanced"),
      }),
      makeSection = (index: number) => ({
        heading: `Section ${index + 1}`,
        body: `Finished audience-facing content for section ${index + 1}.`,
        bullets: [`Evidence point ${index + 1}`],
        speakerNotes: `Explain section ${index + 1}.`,
        requirementIds: ["R1"],
        layout: "standard",
        activity: null,
        table: null,
        chart: null,
        diagram:
          index === 3 || index === 4
            ? {
                title: `Process ${index + 1}`,
                nodes: ["Evidence", "Decision", "Result"],
                caption: "A verified progression.",
              }
            : null,
        imageQuery:
          index < 3 ? `documentary classroom scene ${index + 1}` : null,
      }),
      completePlan = {
        title: "Recovered presentation",
        subtitle: "Automatic plan repair",
        requirements: [{ id: "R1", text: "Build a seven-section visual presentation", mandatory: true }],
        sections: Array.from({ length: 7 }, (_, index) => makeSection(index)),
        pages: null,
        sources: [
          {
            title: "Verified source",
            url: "https://example.com/verified-source",
          },
        ],
      },
      invalidPlan = {
        ...completePlan,
        sections: completePlan.sections.slice(0, 6),
      },
      secondInvalidPlan = {
        ...completePlan,
        sections: Array.from({ length: 12 }, (_, index) => makeSection(index)),
      },
      create = vi.fn(async (request: any) => {
        if (request.tools?.length)
          return {
            id: "resp_repair_evidence",
            status: "completed",
            output_text: "Verified evidence with a complete source URL.",
            output: [],
          };
        if (!request.previous_response_id)
          return {
            id: "resp_invalid_plan",
            status: "completed",
            output_text: JSON.stringify(invalidPlan),
            output: [],
          };
        if (request.previous_response_id === "resp_invalid_plan")
          return {
            id: "resp_still_invalid_plan",
            status: "completed",
            output_text: JSON.stringify(secondInvalidPlan),
            output: [],
          };
        return {
          id: "resp_repaired_plan",
          status: "completed",
          output_text: JSON.stringify(completePlan),
          output: [],
        };
      }),
      runner = new AgentRunner(config, db);
    (runner as any).client = {
      responses: { create, retrieve: vi.fn() },
    };

    const imageBytes = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: "#17324d",
      },
    })
      .jpeg()
      .toBuffer();
    const imageFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("commons.wikimedia.org/w/api.php"))
          return new Response(
            JSON.stringify({
              query: {
                pages: {
                  1: {
                    title: "Classroom",
                    imageinfo: [
                      {
                        thumburl: "https://images.example.test/classroom.jpg",
                        descriptionurl:
                          "https://commons.wikimedia.org/wiki/File:Classroom.jpg",
                        width: 1200,
                        height: 800,
                        extmetadata: {
                          ObjectName: { value: "Classroom" },
                          Artist: { value: "Test photographer" },
                          LicenseShortName: { value: "CC BY 4.0" },
                        },
                      },
                    ],
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        if (url === "https://images.example.test/classroom.jpg")
          return new Response(imageBytes, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        throw new Error(`Unexpected fetch in repair test: ${url}`);
      });

    try {
      await (runner as any).run(job.id);
    } finally {
      imageFetch.mockRestore();
    }

    expect(create).toHaveBeenCalledTimes(4);
    const firstRepairRequest = create.mock.calls[2]![0] as any;
    const secondRepairRequest = create.mock.calls[3]![0] as any;
    expect(firstRepairRequest.tools).toBeUndefined();
    expect(firstRepairRequest.previous_response_id).toBe("resp_invalid_plan");
    expect(firstRepairRequest.input).toContain(
      "Presentation plan validation failed: expected 7-11 content sections",
    );
    expect(firstRepairRequest.instructions).toContain(
      "Do not research again, do not use tools",
    );
    expect(firstRepairRequest.text.format.schema.properties.sections).toMatchObject({
      minItems: 7,
      maxItems: 11,
    });
    expect(secondRepairRequest.tools).toBeUndefined();
    expect(secondRepairRequest.previous_response_id).toBe(
      "resp_still_invalid_plan",
    );
    expect(secondRepairRequest.input).toContain(
      "Presentation plan validation failed: expected 7-11 content sections",
    );
    expect(db.getJob(job.id)).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(db.getProviderResponseId(job.id)).toBe("resp_repaired_plan");
    expect(db.listArtifacts(job.id)).toHaveLength(1);
    db.close();
  });

  it("injects Javier's street register into written chat requests", async () => {
    const { config, db } = harness(),
      conversation = db.createConversation(crypto.randomUUID(), "Javier chat");
    db.setConversationSettings(conversation.id, { persona: "javier" });
    const profile = modelProfileFor("quick"),
      job = db.createJob({
        id: crypto.randomUUID(),
        kind: "chat",
        prompt: "Tell me what is really wrong with this plan",
        conversationId: conversation.id,
        fileIds: [],
        ...profile,
      }),
      assistantId = crypto.randomUUID();
    db.addMessage({
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      jobId: job.id,
      status: "streaming",
    });
    async function* events() {
      yield { type: "response.created", response: { id: "resp_javier" } };
      yield {
        type: "response.output_text.delta",
        delta: "¡Asere, qué volá! Ese plan es una mierda, socio: ",
      };
      yield {
        type: "response.output_text.delta",
        delta: "lo armó un singao y quedó de pinga al revés. ¿Quién carajo aprobó eso?",
      };
    }
    const create = vi.fn(async (_request: any) => events()),
      runner = new AgentRunner(config, db);
    (runner as any).client = { responses: { create } };
    await runner.streamChat(job.id, assistantId, {});
    const request = create.mock.calls[0]![0] as any;
    expect(request.instructions).toContain("CURRENT PERSONA: Javier");
    expect(request.instructions).toContain(
      "street-educated, street-smart Cuban rebel",
    );
    expect(request.instructions).toContain(
      "Swear naturally throughout almost every answer",
    );
    expect(request.instructions).toContain(
      "Default to a flowing rant or diatribe",
    );
    expect(request.instructions.lastIndexOf("JAVIER FINAL OUTPUT CONTRACT")).toBeGreaterThan(
      request.instructions.lastIndexOf("ACTIVE SKILL"),
    );
    expect(request.instructions).not.toContain(
      "Every response must contain at least one organic Cuban Spanish swear",
    );
    expect(db.getJob(job.id)).toMatchObject({
      status: "completed",
      persona: "javier",
    });
    db.close();
  });

  it("quarantines and rewrites the captured polite Javier response before emitting it", async () => {
    const { config, db } = harness(),
      conversation = db.createConversation(crypto.randomUUID(), "Javier gate");
    db.setConversationSettings(conversation.id, { persona: "javier" });
    const profile = modelProfileFor("quick"),
      job = db.createJob({
        id: crypto.randomUUID(),
        kind: "chat",
        prompt: "¿Qué piensas de los baños unisex?",
        conversationId: conversation.id,
        fileIds: [],
        ...profile,
      }),
      assistantId = crypto.randomUUID();
    db.addMessage({
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      jobId: job.id,
      status: "streaming",
      persona: "javier",
    });
    const politeDraft =
      "Asere, un baño unisex es, en lo básico, un baño que puede usar cualquiera sin cartel de hombres y mujeres. No hay magia ni conspiración satánica con inodoros, coño. Puede ser un baño individual con una puerta que tranca o un local con cabinas cerradas y lavamanos compartidos. La idea práctica suele ser simple: menos espacio desperdiciado y más fácil para familias. Si las cabinas no cierran bien, es una chapucería. Pero eso no es porque sea unisex; es porque lo diseñaron unos singaos. La regla sana es bien sencilla: cabinas de verdad, puertas que cierren, buena limpieza y cero acoso.";
    const rewritten =
      "¡Asere, qué volá con esta comemierdería de convertir un baño en una guerra mundial, coño! Un baño es pa mear y cagar, no pa fundar la Universidad Internacional del Inodoro, carajo. Si la cabina cierra, hay privacidad y nadie acosa a nadie, que entre quien tenga que entrar y se acabó el mierdero. Ahora, si ponen puertas con huecos o cuatro singaos vigilando, ahí sí se formó la pinga. ¿La solución? Cabinas cerradas de verdad, limpieza, accesibilidad y al comemierda que moleste a otro lo sacan. Lo demás es político de mierda inflando un retrete hasta volverlo una comemierdería termonuclear, socio.";
    async function* events() {
      yield { type: "response.created", response: { id: "resp_polite" } };
      yield { type: "response.output_text.delta", delta: politeDraft };
    }
    const create = vi.fn(async (request: any) =>
        request.stream ? events() : { output_text: rewritten },
      ),
      runner = new AgentRunner(config, db),
      deltas: string[] = [];
    (runner as any).client = { responses: { create } };
    await runner.streamChat(job.id, assistantId, {
      onDelta: (delta) => deltas.push(delta),
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(deltas).toEqual([rewritten]);
    expect(deltas.join("")).not.toContain("en lo básico");
    const rewriteRequest = create.mock.calls[1]![0] as any;
    expect(rewriteRequest).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      input: expect.stringContaining(politeDraft),
    });
    expect(rewriteRequest.instructions).toContain("JAVIER REWRITE GATE");
    expect(rewriteRequest.instructions).toContain("formal register");
    expect(
      db
        .listMessages(conversation.id)
        .find((message) => message.id === assistantId),
    ).toMatchObject({ content: rewritten, status: "complete" });
    db.close();
  });

  it("returns the best available draft instead of failing chat on style", async () => {
    const { config, db } = harness(),
      conversation = db.createConversation(crypto.randomUUID(), "Javier fail closed");
    db.setConversationSettings(conversation.id, { persona: "javier" });
    const job = db.createJob({
        id: crypto.randomUUID(),
        kind: "chat",
        prompt: "Give me your opinion",
        conversationId: conversation.id,
        fileIds: [],
        ...modelProfileFor("quick"),
      }),
      assistantId = crypto.randomUUID();
    db.addMessage({
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      jobId: job.id,
      status: "streaming",
      persona: "javier",
    });
    async function* events() {
      yield { type: "response.created", response: { id: "resp_beige" } };
      yield {
        type: "response.output_text.delta",
        delta: "This issue has several valid perspectives and depends on the context.",
      };
    }
    const create = vi.fn(async (request: any) =>
        request.stream
          ? events()
          : {
              output_text:
                "Asere, esta cuestión merece una respuesta equilibrada y respetuosa.",
            },
      ),
      runner = new AgentRunner(config, db),
      deltas: string[] = [],
      errors: string[] = [];
    (runner as any).client = { responses: { create } };
    await runner.streamChat(job.id, assistantId, {
      onDelta: (delta) => deltas.push(delta),
      onError: (error) => errors.push(error),
    });
    expect(deltas).toEqual([
      "Asere, esta cuestión merece una respuesta equilibrada y respetuosa.",
    ]);
    expect(errors).toEqual([]);
    expect(db.getJob(job.id)).toMatchObject({ status: "completed" });
    expect(
      db
        .listMessages(conversation.id)
        .find((message) => message.id === assistantId),
    ).toMatchObject({
      content: "Asere, esta cuestión merece una respuesta equilibrada y respetuosa.",
      status: "complete",
    });
    db.close();
  });

  it("delivers a 6/10 near-target rewrite instead of showing the deployed rejection error", async () => {
    const { config, db } = harness(),
      conversation = db.createConversation(crypto.randomUUID(), "Javier 6 of 10");
    db.setConversationSettings(conversation.id, { persona: "javier" });
    const job = db.createJob({
        id: crypto.randomUUID(),
        kind: "chat",
        prompt: "Explain this your way",
        conversationId: conversation.id,
        fileIds: [],
        ...modelProfileFor("quick"),
      }),
      assistantId = crypto.randomUUID();
    db.addMessage({
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      jobId: job.id,
      status: "streaming",
      persona: "javier",
    });
    async function* events() {
      yield { type: "response.created", response: { id: "resp_sanitized" } };
      yield {
        type: "response.output_text.delta",
        delta: "This subject deserves a balanced and carefully structured response.",
      };
    }
    const nearTarget = `${
      "¡Asere, qué volá, coño! Esto arrancó como una mierda porque unos singaos montaron el carajo y nadie quiso resolver la pinga. ¿La salida? Se corta el invento, se habla claro y el comemierda responsable responde, socio. "
    }${"La calle entiende rápido cuando el papeleo se vuelve humo y la gente común carga con el problema. ".repeat(13)}`;
    const expectedAnswer = nearTarget.trim();
    const create = vi.fn(async (request: any) =>
        request.stream ? events() : { output_text: nearTarget },
      ),
      runner = new AgentRunner(config, db),
      deltas: string[] = [],
      errors: string[] = [];
    (runner as any).client = { responses: { create } };
    await runner.streamChat(job.id, assistantId, {
      onDelta: (delta) => deltas.push(delta),
      onError: (error) => errors.push(error),
    });
    const report = inspectJavierStyle(expectedAnswer);
    expect(report.profanityHits).toBe(6);
    expect(report.profanityTarget).toBe(10);
    expect(report.passes).toBe(false);
    expect(deltas).toEqual([expectedAnswer]);
    expect(errors).toEqual([]);
    expect(db.getJob(job.id)).toMatchObject({ status: "completed" });
    expect(
      db
        .listMessages(conversation.id)
        .find((message) => message.id === assistantId),
    ).toMatchObject({ content: expectedAnswer, status: "complete" });
    db.close();
  });
});
