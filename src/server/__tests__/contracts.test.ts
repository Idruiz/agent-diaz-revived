import { describe, expect, it } from "vitest";
import {
  ArtifactPlanSchema,
  CreateJobSchema,
  RealtimeTokenSchema,
  StreamChatSchema,
  UpdateConversationSettingsSchema,
} from "../../shared/contracts";
import { PERSONAS } from "../../shared/personas";
import { personaInstructions } from "../personas";
import {
  isImageUpload,
  isSpreadsheetUpload,
  modelProfileFor,
  providerFailureMessage,
} from "../openai-agent";
describe("contracts", () => {
  it("rejects empty jobs", () => {
    expect(
      CreateJobSchema.safeParse({ prompt: "", kind: "chat" }).success,
    ).toBe(false);
  });
  it("requires a prompt unless chat is an explicit retry", () => {
    expect(
      StreamChatSchema.safeParse({
        conversationId: crypto.randomUUID(),
        fileIds: [],
      }).success,
    ).toBe(false);
    expect(
      StreamChatSchema.safeParse({
        conversationId: crypto.randomUUID(),
        fileIds: [],
        retryJobId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
  });
  it("locks the three production model profiles", () => {
    expect(modelProfileFor("quick")).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
    });
    expect(modelProfileFor("balanced")).toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    expect(modelProfileFor("deep")).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });
  it("locks six distinct OpenAI Realtime persona voices", () => {
    expect(PERSONAS.map((persona) => persona.id)).toEqual([
      "diaz",
      "javier",
      "vega",
      "mara",
      "luz",
      "salcedo",
    ]);
    expect(new Set(PERSONAS.map((persona) => persona.voice)).size).toBe(6);
    expect(PERSONAS.find((persona) => persona.id === "javier")).toMatchObject({
      voice: "echo",
      voiceLabel: "Echo · Cuban cadence",
    });
  });
  it("keeps persona selection server-owned and rejects empty settings", () => {
    expect(
      UpdateConversationSettingsSchema.safeParse({ persona: "javier" })
        .success,
    ).toBe(true);
    expect(UpdateConversationSettingsSchema.safeParse({}).success).toBe(false);
    const parsed = RealtimeTokenSchema.parse({
      conversationId: crypto.randomUUID(),
      voice: "cedar",
    });
    expect(parsed).not.toHaveProperty("voice");
  });
  it("defines Javier as Cuban, solution-oriented, and memory-safe", () => {
    const instructions = personaInstructions("javier");
    expect(instructions).toContain("CURRENT PERSONA: Javier");
    expect(instructions).toContain("Cuban Spanish swear");
    expect(instructions).toContain("solution-oriented");
    expect(instructions).toContain("not a separate factual database");
    expect(instructions).toContain("Never turn jokes, profanity");
  });
  it("routes images and spreadsheets by actual file metadata", () => {
    expect(isImageUpload("image/png")).toBe(true);
    expect(isImageUpload("application/octet-stream", "photo.webp")).toBe(true);
    expect(
      isSpreadsheetUpload("results.xlsx", "application/octet-stream"),
    ).toBe(true);
    expect(
      isSpreadsheetUpload(
        "brief.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false);
  });
  it("rejects invented non-url sources", () => {
    expect(
      ArtifactPlanSchema.safeParse({
        title: "x",
        sections: [{ heading: "h", body: "b", bullets: [] }],
        sources: [{ title: "s", url: "made up" }],
      }).success,
    ).toBe(false);
  });
  it("surfaces provider failure details", () => {
    expect(
      providerFailureMessage({
        status: "failed",
        error: { code: "server_error", message: "Temporary provider fault" },
      }),
    ).toBe("OpenAI response failed (server_error): Temporary provider fault");
  });
});
