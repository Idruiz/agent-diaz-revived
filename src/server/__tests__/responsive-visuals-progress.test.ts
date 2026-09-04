import { describe, expect, it } from "vitest";
import { planArtifactVisuals } from "../artifact-visual-plan";
import { chartSvg, diagramSvg } from "../visuals";

function visualPlan(sectionCount = 24) {
  return {
    title: "Raíces de España",
    subtitle: "Historia, cultura y patrimonio",
    requirements: [{ id: "R1", text: "Create a visual cultural artifact", mandatory: true }],
    sections: Array.from({ length: sectionCount }, (_, index) => ({
      heading: `Lugar cultural ${index + 1} de España`,
      body: "Historia, patrimonio, arquitectura, gastronomía y vida cultural en un lugar concreto de España.",
      bullets: [],
      speakerNotes: "",
      requirementIds: ["R1"],
      layout: "standard" as const,
      imageQuery: `Spain cultural place ${index + 1}`,
    })),
    pages: undefined,
    sources: [],
  };
}

describe("responsive visual rendering and acquisition budgets", () => {
  it("caps model-authored website imageQuery explosions while preserving an image-heavy request", () => {
    const result = planArtifactVisuals(
      "website",
      visualPlan() as any,
      "Create an image-heavy cultural website with many relevant photographs",
    );
    expect(result.receipt.explicitQueries).toBe(24);
    expect(result.receipt.imageHeavyPrompt).toBe(true);
    expect(result.receipt.targetSlots).toBeLessThanOrEqual(14);
    expect(result.receipt.plannedSlots).toBe(result.receipt.targetSlots);
    expect(result.receipt.trimmedExplicitQueries).toBeGreaterThan(0);
    expect(result.plan.sections.filter((section) => section.imageQuery)).toHaveLength(
      result.receipt.targetSlots,
    );
  });

  it("honors a concrete user photograph count instead of the automatic cap", () => {
    const result = planArtifactVisuals(
      "website",
      visualPlan(20) as any,
      "Create the website with 20 photographs",
    );
    expect(result.receipt.userRequestedSlots).toBe(20);
    expect(result.receipt.targetSlots).toBe(20);
    expect(result.receipt.plannedSlots).toBe(20);
  });

  it("wraps long diagram labels into responsive multi-line nodes", () => {
    const svg = diagramSvg({
      title: "Historia de España",
      nodes: [
        "Prehistoria y primeras comunidades peninsulares",
        "Roma y la Hispania romana",
        "Edad Media y al-Ándalus",
        "Edad Moderna y expansión imperial",
        "Siglos XIX y XX: cambios políticos y sociales",
        "España democrática contemporánea",
      ],
      caption: "Una secuencia histórica de referencia.",
    });
    expect(svg).toContain("<tspan");
    expect((svg.match(/<tspan/g) ?? []).length).toBeGreaterThan(6);
    expect(svg).toContain("font-size:14px");
    expect(svg).toContain("España democrática");
    expect(svg).not.toContain("slice(0,28)");
  });

  it("separates an extreme bar-chart outlier instead of flattening every other value", () => {
    const svg = chartSvg({
      title: "Cifras esenciales del patrimonio español",
      type: "bar",
      labels: [
        "Bienes Patrimonio Mundial",
        "Bienes culturales",
        "Bienes naturales",
        "Bienes mixtos",
        "Ciudades Patrimonio",
        "Bienes de Interés Cultural",
      ],
      series: [{ name: "Cantidad", values: [50, 44, 4, 2, 15, 17000] }],
      sourceNote: "UNESCO World Heritage Convention y Spain.info.",
    });
    expect(svg).toContain("Different scale");
    expect(svg).toContain("17,000");
    expect(svg).toContain("Comparable categories shown on their own scale");
    expect(svg).toContain("Bienes de Interés");
  });
});
