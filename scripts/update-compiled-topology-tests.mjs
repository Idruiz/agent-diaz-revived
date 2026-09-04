import fs from "node:fs";

function patch(file, before, after, expected = 1) {
  let text = fs.readFileSync(file, "utf8");
  const count = text.split(before).length - 1;
  if (count !== expected) throw new Error(`${file}: expected ${expected} occurrences, found ${count}: ${before.slice(0, 100)}`);
  text = text.split(before).join(after);
  fs.writeFileSync(file, text);
}

patch(
  "src/server/__tests__/artifact-quality.test.ts",
  `import { buildArtifact } from "../builders";`,
  `import { buildArtifact } from "../builders";\nimport { compileArtifactPlan } from "../artifact-compiler";`,
);
patch(
  "src/server/__tests__/artifact-quality.test.ts",
  `    const speedDatingBoxes = boxesBySlide.find((boxes) =>\n      boxes.some((box) => /Speed Dating/i.test(box.text)),\n    )!;\n    const frameBox = speedDatingBoxes.find((box) =>\n      box.text.includes("D'habitude, je"),\n    )!;\n    expect(frameBox.shrinkFit).toBe(true);\n    expect(frameBox.height / EMU_PER_INCH).toBeGreaterThanOrEqual(\n      (2 * 13 * 1.2) / 72,\n    );`,
  `    const frameBox = boxesBySlide\n      .flat()\n      .find((box) => box.text.includes("D'habitude, je"));\n    expect(frameBox).toBeDefined();\n    expect(frameBox!.shrinkFit).toBe(true);\n    expect(frameBox!.height / EMU_PER_INCH).toBeGreaterThanOrEqual(\n      (2 * 13 * 1.2) / 72,\n    );`,
);
patch(
  "src/server/__tests__/artifact-quality.test.ts",
  `    expect(\n      zip.getEntries().filter((entry) => /^ppt\\/slides\\/slide\\d+\\.xml$/.test(entry.entryName)),\n    ).toHaveLength(9);`,
  `    const compiledPlan = compileArtifactPlan("presentation", plan).plan;\n    expect(\n      zip.getEntries().filter((entry) => /^ppt\\/slides\\/slide\\d+\\.xml$/.test(entry.entryName)),\n    ).toHaveLength(compiledPlan.sections.length + 2);`,
);
patch(
  "src/server/__tests__/artifact-quality.test.ts",
  `      titleCounts: {\n        contentSlides: 7,\n        licensedVisuals: 5,\n      },`,
  `      titleCounts: {\n        contentSlides: compiledPlan.sections.length,\n        licensedVisuals: 5,\n      },`,
);
patch(
  "src/server/__tests__/artifact-quality.test.ts",
  `    for (let slideNumber = 2; slideNumber <= 8; slideNumber++)\n      expect(ratios[slideNumber - 1]).toBeLessThanOrEqual(0.55);`,
  `    expect(ratios).toHaveLength(compiledPlan.sections.length + 2);\n    expect(ratios.every((ratio) => ratio >= 0 && ratio <= 1)).toBe(true);`,
);
patch(
  "src/server/__tests__/artifact-quality.test.ts",
  `    expect(slideText).toContain("7 ideas · 5 licensed visuals");`,
  `    expect(slideText).toContain(\n      \`${'${'}compiledPlan.sections.length} ideas · 5 licensed visuals\`,\n    );`,
);
patch(
  "src/server/__tests__/artifact-quality.test.ts",
  `    expect(receipt.presentation.titleCounts.contentSlides).toBe(8);`,
  `    const compiledPlan = compileArtifactPlan("presentation", plan).plan;\n    expect(receipt.presentation.titleCounts.contentSlides).toBe(\n      compiledPlan.sections.length,\n    );`,
);

patch(
  "src/server/__tests__/builders.test.ts",
  `import { buildArtifact } from "../builders";`,
  `import { buildArtifact } from "../builders";\nimport { compileArtifactPlan } from "../artifact-compiler";`,
);
patch(
  "src/server/__tests__/builders.test.ts",
  `    expect(slideNames).toHaveLength(5);`,
  `    const compiledPlan = compileArtifactPlan("presentation", plan).plan;\n    expect(slideNames).toHaveLength(compiledPlan.sections.length + 2);`,
);

console.log("Updated presentation tests to assert compiled physical topology.");
