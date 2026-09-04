import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8");
const write = (p, s) => fs.writeFileSync(p, s);
function replaceOnce(file, before, after) {
  let s = read(file);
  const a = s.indexOf(before);
  if (a < 0) throw new Error(`Missing anchor in ${file}: ${before.slice(0, 100)}`);
  if (s.indexOf(before, a + before.length) >= 0) throw new Error(`Ambiguous anchor in ${file}`);
  s = s.slice(0, a) + after + s.slice(a + before.length);
  write(file, s);
}
function replaceCount(file, before, after, expectedCount) {
  let s = read(file);
  const actual = s.split(before).length - 1;
  if (actual !== expectedCount)
    throw new Error(`Expected ${expectedCount} anchors in ${file}, found ${actual}: ${before.slice(0, 100)}`);
  s = s.split(before).join(after);
  write(file, s);
}

replaceOnce(
  "src/server/artifact-compiler.ts",
  `    if (builderDoesNotRenderBody || builderDoesNotRenderBullets || bodyNeedsPagination || bulletsNeedPagination) {\n      const context = contextFragments(section);\n      compiled.push(...context);\n      normalizations.push({\n        code: "presentation_content_paginated",\n        detail: \`Moved audience-facing context for '\${section.heading}' into \${context.length} deterministic context slide(s) so no body or bullet content is dropped.\`,\n      });\n      const primary = structuredClone(section);\n      primary.body = chunks(section.body, bodyLimit)[0] ?? "";\n      primary.bullets = [];\n      compiled.push(primary);\n      continue;\n    }\n\n    const fragments = standardFragments(section);`,
  `    if (builderDoesNotRenderBody || builderDoesNotRenderBullets) {\n      const context = contextFragments(section);\n      compiled.push(...context);\n      normalizations.push({\n        code: "presentation_content_paginated",\n        detail: \`Moved audience-facing context for '\${section.heading}' into \${context.length} deterministic context slide(s) so no body or bullet content is dropped.\`,\n      });\n      const primary = structuredClone(section);\n      primary.body = chunks(section.body, bodyLimit)[0] ?? "";\n      primary.bullets = [];\n      compiled.push(primary);\n      continue;\n    }\n\n    const fragments = standardFragments(section);`
);

replaceOnce(
  "src/server/openai-agent.ts",
  `    if (plan.sections.length < 7)\n      push(\n        "presentation_sections_missing",\n        \`Presentation needs at least 7 content sections; received \${plan.sections.length}.\`,\n        true,\n      );`,
  `    if (plan.sections.length < 7)\n      push(\n        "presentation_sections_low",\n        \`Presentation has \${plan.sections.length} content sections; seven is a quality target, not a validity requirement.\`,\n        false,\n      );`
);

replaceOnce(
  "src/server/__tests__/agent.test.ts",
  `  it("keeps up to 14 presentation sections intact and sends larger plans to PLAN_CONTENT repair", () => {`,
  `  it("keeps presentation section-count targets as nonblocking telemetry", () => {`
);
replaceOnce(
  "src/server/__tests__/agent.test.ts",
  `          code: "presentation_sections_excess",\n          mandatory: true,\n          message: expect.stringContaining("received 15"),`,
  `          code: "presentation_sections_excess",\n          mandatory: false,\n          message: expect.stringContaining("compiled to 15"),`
);
replaceOnce(
  "src/server/__tests__/agent.test.ts",
  `          code: "presentation_sections_missing",\n          mandatory: true,`,
  `          code: "presentation_sections_low",\n          mandatory: false,`
);
replaceOnce(
  "src/server/__tests__/agent.test.ts",
  `  it("repairs an invalid presentation plan without repeating the evidence phase", async () => {`,
  `  it("does not repair a valid presentation solely to increase its slide count", async () => {`
);
replaceOnce(
  "src/server/__tests__/agent.test.ts",
  `    expect(create).toHaveBeenCalledTimes(3);\n    const firstRepairRequest = create.mock.calls[2]![0] as any;\n    expect(firstRepairRequest.tools).toBeUndefined();\n    expect(firstRepairRequest.previous_response_id).toBe("resp_invalid_plan");\n    expect(firstRepairRequest.input).toContain(\n      "[presentation_sections_missing] Presentation needs at least 7 content sections",\n    );\n    expect(firstRepairRequest.instructions).toContain(\n      "Do not research again, do not use tools",\n    );\n    expect(firstRepairRequest.text.format.schema.properties.sections).toMatchObject({\n      minItems: 1,\n      maxItems: 30,\n    });\n    // The second plan only misses a visual-density target. That is telemetry,\n    // so it must not consume another LLM repair call.`,
  `    expect(create).toHaveBeenCalledTimes(2);\n    // Evidence + structure only: section-count and visual-density targets are\n    // telemetry and must not consume plan-repair calls.`
);
replaceOnce(
  "src/server/__tests__/agent.test.ts",
  `    expect(db.getProviderResponseId(job.id)).toBe("resp_still_invalid_plan");`,
  `    expect(db.getProviderResponseId(job.id)).toBe("resp_invalid_plan");`
);

replaceOnce(
  "src/server/__tests__/artifact-golden.test.ts",
  `import { setImageJudgeProviderForTests } from "../image-judge";`,
  `import { setImageJudgeProviderForTests } from "../image-judge";\nimport { compileArtifactPlan } from "../artifact-compiler";`
);
replaceOnce(
  "src/server/__tests__/artifact-golden.test.ts",
  `        const receipt = artifact.receipt as any;\n        expect(receipt).toMatchObject({`,
  `        const receipt = artifact.receipt as any;\n        const compiledGolden = compileArtifactPlan(golden.kind, golden.plan).plan;\n        expect(receipt).toMatchObject({`
);
replaceOnce(
  "src/server/__tests__/artifact-golden.test.ts",
  `          normalizations: [],`,
  `          normalizations: expect.any(Array),`
);
replaceCount(
  "src/server/__tests__/artifact-golden.test.ts",
  `              contentSections: golden.plan.sections.length,`,
  `              contentSections: compiledGolden.sections.length,`,
  2,
);
replaceOnce(
  "src/server/__tests__/artifact-golden.test.ts",
  `    expect(french.receipt.presentation).toMatchObject({\n      placedAssets: 6,\n      reconciliations: [],\n      titleCounts: {\n        contentSlides: 7,\n        licensedVisuals: 6,\n      },\n    });`,
  `    const compiledFrench = compileArtifactPlan(\n      french.golden.kind,\n      french.golden.plan,\n    ).plan;\n    expect(french.receipt.presentation).toMatchObject({\n      placedAssets: 6,\n      reconciliations: [],\n      titleCounts: {\n        contentSlides: compiledFrench.sections.length,\n        licensedVisuals: 6,\n      },\n    });`
);
replaceOnce(
  "src/server/__tests__/artifact-golden.test.ts",
  `    expect(frenchSlideText).toContain("7 ideas · 6 licensed visuals");`,
  `    expect(frenchSlideText).toContain(\n      \`\${compiledFrench.sections.length} ideas · 6 licensed visuals\`,\n    );`
);

console.log("Artifact trust regression corrections applied.");