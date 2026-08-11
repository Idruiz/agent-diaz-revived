import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db";
import { AgentRunner, modelProfileFor } from "../openai-agent";
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
    const audioBytes = new TextEncoder().encode("complete-mp3"),
      create = vi.fn(async () => ({
        arrayBuffer: async () => audioBytes.buffer,
      })),
      runner = new AgentRunner(config, db);
    (runner as any).client = { audio: { speech: { create } } };
    const text =
      "Asere, esto es una morronga y esa hijadeputá se va pa casa del carajo.";
    const audio = await runner.createSpeech(conversation.id, text),
      [body, options] = create.mock.calls[0]! as any;
    expect(audio.toString()).toBe("complete-mp3");
    expect(body).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: "echo",
      input: text,
      response_format: "mp3",
    });
    expect(body.instructions).toContain("Read the supplied text completely and verbatim");
    expect(body.instructions).toContain("irreverent, volatile, subversive");
    expect(body.instructions).toContain("Do not summarize, soften, censor, omit");
    expect(options.headers["OpenAI-Safety-Identifier"]).toBe(
      "agent-diaz-owner",
    );
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
