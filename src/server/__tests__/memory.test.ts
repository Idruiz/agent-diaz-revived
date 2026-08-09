import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db";
import type { Config } from "../config";
const dirs: string[] = [];
function database() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-memory-"));
  dirs.push(root);
  const config = {
    root,
    dataDir: path.join(root, "data"),
    artifactDir: path.join(root, "artifacts"),
    uploadDir: path.join(root, "uploads"),
  } as Config;
  return openDatabase(config);
}
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
describe("conversation memory", () => {
  it("persists ordered turns and connects jobs to conversations", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "New conversation");
    const j = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Remember the blue folder",
      conversationId: c.id,
      fileIds: [],
    });
    db.addMessage({
      id: crypto.randomUUID(),
      conversationId: c.id,
      role: "assistant",
      content: "I will remember it.",
      jobId: j.id,
    });
    expect(db.listMessages(c.id).map((m) => m.content)).toEqual([
      "Remember the blue folder",
      "I will remember it.",
    ]);
    expect(db.getJob(j.id)?.conversationId).toBe(c.id);
    expect(db.getConversation(c.id)?.title).toBe("Remember the blue folder");
    db.close();
  });
  it("keeps five detailed conversations and archives overflow", () => {
    const db = database();
    for (let i = 1; i <= 6; i++)
      db.createConversation(crypto.randomUUID(), `Conversation ${i}`);
    const overflow = db.archiveOverflow();
    expect(overflow).toHaveLength(1);
    const archived = overflow[0]!;
    db.setConversationSummary(archived.id, "Durable compact summary");
    const rows = db.listConversations();
    expect(rows.filter((c) => c.status === "active")).toHaveLength(5);
    expect(rows.find((c) => c.id === archived.id)?.summary).toBe(
      "Durable compact summary",
    );
    db.close();
  });
  it("persists provider linkage for approval continuation", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "Action");
    const j = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Perform the approved action",
      conversationId: c.id,
      fileIds: [],
    });
    const id = crypto.randomUUID();
    db.createApproval({
      id,
      jobId: j.id,
      tool: "calendar:create",
      summary: "Create event",
      argumentsJson: '{"title":"Review"}',
      providerItemId: "mcpr_test",
      providerResponseId: "resp_test",
    });
    expect(db.getApproval(id)).toMatchObject({
      jobId: j.id,
      status: "pending",
      providerItemId: "mcpr_test",
      providerResponseId: "resp_test",
    });
    db.decideApproval(id, "approved");
    expect(db.getApproval(id)?.status).toBe("approved");
    db.close();
  });
  it("retries without duplicating the failed user message", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "Retry");
    db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Please identify yourself",
      conversationId: c.id,
      fileIds: [],
    });
    db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Please identify yourself",
      conversationId: c.id,
      fileIds: [],
      recordUserMessage: false,
    });
    expect(
      db
        .listMessages(c.id)
        .filter((m) => m.role === "user")
        .map((m) => m.content),
    ).toEqual(["Please identify yourself"]);
    db.close();
  });
  it("persists a model mode and attachment on the visible user turn", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "Files");
    db.setConversationMode(c.id, "deep");
    const uploadId = crypto.randomUUID();
    db.addUpload({
      id: uploadId,
      name: "evidence.png",
      mime: "image/png",
      size: 1234,
      path: "/tmp/evidence.png",
      openaiFileId: "file_test",
    });
    const job = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Inspect this image",
      conversationId: c.id,
      fileIds: [uploadId],
      modelMode: "deep",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(db.getConversation(c.id)?.modelMode).toBe("deep");
    expect(db.getJob(job.id)).toMatchObject({
      modelMode: "deep",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(db.listMessages(c.id)[0]?.attachments).toEqual([
      { id: uploadId, name: "evidence.png", mime: "image/png", size: 1234 },
    ]);
    db.close();
  });
  it("stores each voice exchange as one atomic user-assistant pair", () => {
    const db = database();
    const c = db.createConversation(crypto.randomUUID(), "New conversation");
    db.addVoiceTurn({
      conversationId: c.id,
      userId: crypto.randomUUID(),
      assistantId: crypto.randomUUID(),
      userText: "Can you hear me?",
      assistantText: "Loud and clear.",
    });
    expect(db.listMessages(c.id).map((m) => [m.role, m.content])).toEqual([
      ["user", "Can you hear me?"],
      ["assistant", "Loud and clear."],
    ]);
    expect(db.getConversation(c.id)?.title).toBe("Can you hear me?");
    db.close();
  });
  it("marks an interrupted live stream retryable after reopening storage", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-recovery-"));
    dirs.push(root);
    const config = {
      root,
      dataDir: path.join(root, "data"),
      artifactDir: path.join(root, "artifacts"),
      uploadDir: path.join(root, "uploads"),
    } as Config;
    let db = openDatabase(config);
    const c = db.createConversation(crypto.randomUUID(), "Recovery");
    const job = db.createJob({
      id: crypto.randomUUID(),
      kind: "chat",
      prompt: "Long answer",
      conversationId: c.id,
      fileIds: [],
    });
    const assistantId = crypto.randomUUID();
    db.addMessage({
      id: assistantId,
      conversationId: c.id,
      role: "assistant",
      content: "Partial",
      jobId: job.id,
      status: "streaming",
    });
    db.updateJob(job.id, { status: "running" });
    db.close();
    db = openDatabase(config);
    expect(db.getJob(job.id)?.status).toBe("failed");
    expect(
      db.listMessages(c.id).find((m) => m.id === assistantId),
    ).toMatchObject({ status: "failed", content: "Partial" });
    db.close();
  });
});
