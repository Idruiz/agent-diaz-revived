import fs from "node:fs";

function replaceOnce(source, oldValue, newValue, label) {
  const first = source.indexOf(oldValue);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(oldValue, first + oldValue.length) >= 0)
    throw new Error(`Ambiguous patch anchor: ${label}`);
  return source.slice(0, first) + newValue + source.slice(first + oldValue.length);
}

// 1. Keep semantic validation upstream of physical presentation compilation.
const agentPath = "src/server/openai-agent.ts";
let agent = fs.readFileSync(agentPath, "utf8");
agent = replaceOnce(
  agent,
  `export function normalizeArtifactPlan(\n  kind: JobKind,\n  input: ArtifactPlan,\n  _prompt = "",\n): {`,
  `export function normalizeArtifactPlan(\n  kind: JobKind,\n  input: ArtifactPlan,\n  _prompt = "",\n  compileForRender = true,\n): {`,
  "normalization compile mode",
);
agent = replaceOnce(
  agent,
  `  const compiled = compileArtifactPlan(kind, plan);\n  normalizations.push(...compiled.normalizations);\n  return { plan: compiled.plan, normalizations };\n}`,
  `  if (!compileForRender) return { plan, normalizations };\n  const compiled = compileArtifactPlan(kind, plan);\n  normalizations.push(...compiled.normalizations);\n  return { plan: compiled.plan, normalizations };\n}`,
  "normalization compile tail",
);
agent = replaceOnce(
  agent,
  `  const normalized = normalizeArtifactPlan(kind, parsed, prompt);\n  const violations = collectArtifactPlanViolations(\n    kind,\n    normalized.plan,\n    minVisuals,\n    prompt,\n  );`,
  `  // Validate the model's semantic plan before compiling it into physical\n  // slides. The compiler is allowed to move activity directions/frames onto\n  // support slides, so applying semantic activity rules after compilation would\n  // incorrectly reject a correct physical plan.\n  const normalized = normalizeArtifactPlan(kind, parsed, prompt, false);\n  const violations = collectArtifactPlanViolations(\n    kind,\n    normalized.plan,\n    minVisuals,\n    prompt,\n  );`,
  "semantic validation before compile",
);
agent = replaceOnce(
  agent,
  `  return {\n    plan: normalized.plan,\n    normalizations: [...normalized.normalizations, ...warnings],\n  };`,
  `  const compiled = compileArtifactPlan(kind, normalized.plan);\n  return {\n    plan: compiled.plan,\n    normalizations: [\n      ...normalized.normalizations,\n      ...compiled.normalizations,\n      ...warnings,\n    ],\n  };`,
  "compile after semantic validation",
);
fs.writeFileSync(agentPath, agent);

// 2. Output fidelity should be invariant to OOXML run/line whitespace.
const qualityPath = "src/server/artifact-quality.ts";
let quality = fs.readFileSync(qualityPath, "utf8");
quality = replaceOnce(
  quality,
  `  const normalized = normalize(visibleText);\n  if (normalized.length < 200)\n    throw new Error("Artifact output validation failed: finished artifact contains too little visible content");\n\n  const requireVisible = (label: string, value: string) => {\n    const expected = normalize(value);\n    if (!expected) return;\n    if (!normalized.includes(expected))\n      throw new Error(\`Artifact output validation failed: \${label} is missing from the finished artifact\`);\n  };\n\n  for (const section of plan.sections) {\n    const headingNeedle = normalize(section.heading).slice(0, 40);\n    if (headingNeedle && !normalized.includes(headingNeedle))`,
  `  const normalized = normalize(visibleText);\n  const compact = (value: string) => normalize(value).replace(/\\s+/g, "");\n  const compactVisible = compact(visibleText);\n  if (normalized.length < 200)\n    throw new Error("Artifact output validation failed: finished artifact contains too little visible content");\n\n  const requireVisible = (label: string, value: string) => {\n    const expected = compact(value);\n    if (!expected) return;\n    // PptxGenJS/OOXML may split one semantic string across adjacent text runs.\n    // Whitespace is presentation markup, not content, so compare the canonical\n    // character stream while retaining punctuation and every non-whitespace\n    // character. This still detects truncation and dropped words.\n    if (!compactVisible.includes(expected))\n      throw new Error(\`Artifact output validation failed: \${label} is missing from the finished artifact\`);\n  };\n\n  for (const section of plan.sections) {\n    const headingNeedle = compact(section.heading).slice(0, 40);\n    if (headingNeedle && !compactVisible.includes(headingNeedle))`,
  "OOXML run whitespace fidelity",
);
fs.writeFileSync(qualityPath, quality);

// 3. Update the Four Corners trust regression to the new capacity contract.
const trustPath = "src/server/__tests__/artifact-trust.test.ts";
let trust = fs.readFileSync(trustPath, "utf8");
trust = replaceOnce(
  trust,
  `    expect(rounds[0]!.activity!.sentenceFrames).toEqual(\n      source.activity!.sentenceFrames.slice(0, 3),\n    );\n    expect(context.flatMap((section) => section.bullets)).toEqual([\n      ...source.bullets,\n      source.activity!.sentenceFrames[3],\n    ]);`,
  `    expect(\n      rounds.every((section) => section.activity!.directions.length === 0),\n    ).toBe(true);\n    expect(\n      rounds.every((section) => section.activity!.sentenceFrames.length === 0),\n    ).toBe(true);\n    expect(context.flatMap((section) => section.bullets)).toEqual([\n      ...source.bullets,\n      ...source.activity!.directions,\n      ...source.activity!.sentenceFrames,\n    ]);`,
  "Four Corners support-slide expectations",
);
fs.writeFileSync(trustPath, trust);

// 4. Make the new physical PPTX regression compare decoded text, not raw XML entities.
const activityTestPath = "src/server/__tests__/activity-capacity-regression.test.ts";
let activityTest = fs.readFileSync(activityTestPath, "utf8");
activityTest = replaceOnce(
  activityTest,
  `function visibleXml(filePath: string): string {\n  const zip = new AdmZip(filePath);\n  return zip.getEntries()\n    .filter((entry) => /^ppt\\\\/slides\\\\/slide\\\\d+\\\\.xml$/.test(entry.entryName))\n    .map((entry) => entry.getData().toString("utf8"))\n    .join("\\\\n");\n}`,
  `function decodeXml(value: string): string {\n  return value\n    .replace(/&lt;/g, "<")\n    .replace(/&gt;/g, ">")\n    .replace(/&quot;/g, '\"')\n    .replace(/&apos;/g, "'")\n    .replace(/&amp;/g, "&")\n    .replace(/&#(\\d+);/g, (_, code) => String.fromCharCode(Number(code)));\n}\n\nfunction visibleText(filePath: string): string {\n  const zip = new AdmZip(filePath);\n  return zip.getEntries()\n    .filter((entry) => /^ppt\\\\/slides\\\\/slide\\\\d+\\\\.xml$/.test(entry.entryName))\n    .flatMap((entry) =>\n      [...entry.getData().toString("utf8").matchAll(/<a:t>([\\s\\S]*?)<\\/a:t>/g)]\n        .map((match) => decodeXml(match[1]!)),\n    )\n    .join(" ")\n    .replace(/\\s+/g, " ")\n    .trim();\n}`,
  "decoded PPTX text helper",
);
activityTest = replaceOnce(
  activityTest,
  `    const xml = visibleXml(built.path);\n    for (const value of [...longDirections, ...frames, ...prompts])\n      expect(xml).toContain(value.replace(/&/g, "&amp;"));`,
  `    const text = visibleText(built.path);\n    for (const value of [...longDirections, ...frames, ...prompts])\n      expect(text).toContain(value);`,
  "decoded PPTX assertion",
);
fs.writeFileSync(activityTestPath, activityTest);

console.log("Applied semantic/physical activity boundary and fidelity fixes.");
