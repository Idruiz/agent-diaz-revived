import fs from "node:fs";

const path = "src/server/__tests__/artifact-quality.test.ts";
let source = fs.readFileSync(path, "utf8");
const before = `    const compiledPlan = compileArtifactPlan("presentation", plan).plan;\n    expect(receipt.presentation.titleCounts.contentSlides).toBe(\n      compiledPlan.sections.length,\n    );\n    const zip = new AdmZip(out.path);`;
const after = `    const compiledPlan = compileArtifactPlan("presentation", plan).plan;\n    const zip = new AdmZip(out.path);\n    const physicalSlideCount = zip\n      .getEntries()\n      .filter((entry) => /^ppt\\/slides\\/slide\\d+\\.xml$/.test(entry.entryName))\n      .length;\n    expect(receipt.presentation.titleCounts.contentSlides).toBe(\n      physicalSlideCount - 2, // title + Sources are not content slides\n    );\n    expect(receipt.presentation.titleCounts.contentSlides).toBeGreaterThanOrEqual(\n      compiledPlan.sections.length,\n    );`;
if (!source.includes(before)) {
  throw new Error("Expected sparse-deck assertion block was not found");
}
source = source.replace(before, after);
fs.writeFileSync(path, source);
