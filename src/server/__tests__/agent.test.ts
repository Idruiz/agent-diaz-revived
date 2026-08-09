import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db";
import { AgentRunner, modelProfileFor } from "../openai-agent";
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
        audio: { output: { voice: "echo" } },
      },
    });
    expect(body.session.instructions).toContain("Hello Díaz");
    expect(body.session.instructions).toContain("CURRENT PERSONA: Javier");
    expect(body.session.instructions).toContain("lively adult Cuban cadence");
    expect(body.session.instructions).toContain("street-level rhythm");
    expect(body.session.instructions).toContain(
      "university-trained assistant wearing Cuban slang",
    );
    expect(options.headers["OpenAI-Safety-Identifier"]).toBe(
      "agent-diaz-owner",
    );
    expect(JSON.stringify(token)).not.toContain(config.OPENAI_API_KEY);
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
      yield { type: "response.output_text.delta", delta: "Asere, el problema" };
      yield { type: "response.output_text.delta", delta: " es esta mierda." };
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
    expect(request.instructions).not.toContain(
      "Every response must contain at least one organic Cuban Spanish swear",
    );
    expect(db.getJob(job.id)).toMatchObject({
      status: "completed",
      persona: "javier",
    });
    db.close();
  });
});
