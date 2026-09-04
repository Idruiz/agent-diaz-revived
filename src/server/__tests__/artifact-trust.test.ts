import { describe, expect, it } from "vitest";
import { ArtifactPlanSchema } from "../../shared/contracts";
import { compileArtifactPlan } from "../artifact-compiler";
import { assertArtifactPlanQuality } from "../artifact-quality";

function basePlan() {
  return ArtifactPlanSchema.parse({
    title: "Trust regression",
    subtitle: "Deterministic content contract",
    requirements: [{ id: "R1", text: "Deliver all requested content", mandatory: true }],
    sections: [
      {
        heading: "Dense audience-facing explanation",
        body: Array.from({ length: 120 }, (_, i) => `sentence${i}`).join(" "),
        bullets: Array.from({ length: 12 }, (_, i) => `Complete bullet ${i + 1} with preserved content`),
        speakerNotes: "Explain the evidence.",
        requirementIds: ["R1"],
        layout: "standard",
      },
    ],
    sources: [],
  });
}

describe("artifact trust contract", () => {
  it("paginates presentation copy before rendering without silently deleting body words or bullets", () => {
    const input = basePlan();
    const compiled = compileArtifactPlan("presentation", input);
    expect(compiled.plan.sections.length).toBeGreaterThan(1);
    expect(compiled.plan.sections.every((section) => section.body.length <= 440)).toBe(true);
    expect(compiled.plan.sections.every((section) => section.bullets.length <= 5)).toBe(true);
    const originalWords = input.sections[0]!.body.replace(/\s+/g, " ").trim();
    const compiledWords = compiled.plan.sections.map((s) => s.body).filter(Boolean).join(" ");
    expect(compiledWords).toBe(originalWords);
    expect(compiled.plan.sections.flatMap((s) => s.bullets)).toEqual(input.sections[0]!.bullets);
  });

  it("does not fail a valid plan merely because it misses a nonmandatory visual target", () => {
    const plan = basePlan();
    expect(() =>
      assertArtifactPlanQuality(
        "document",
        "Create a professional document",
        plan,
      ),
    ).not.toThrow();
  });

  it("enforces atomic activity sizes at the schema boundary instead of truncating in the renderer", () => {
    const raw = basePlan();
    const section = raw.sections[0]!;
    section.activity = {
      type: "discussion",
      durationMinutes: 10,
      directions: ["d1", "d2"],
      prompts: Array.from({ length: 7 }, (_, i) => `Prompt ${i + 1}`),
      sentenceFrames: [],
      cornerLabels: [],
    };
    expect(() => ArtifactPlanSchema.parse(raw)).toThrow();
  });
});
