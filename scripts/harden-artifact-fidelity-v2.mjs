import fs from "node:fs";

function read(file) { return fs.readFileSync(file, "utf8"); }
function write(file, content) { fs.writeFileSync(file, content); }
function replaceOnce(file, before, after) {
  let content = read(file);
  const at = content.indexOf(before);
  if (at < 0) throw new Error(`Missing anchor in ${file}: ${before.slice(0, 120)}`);
  if (content.indexOf(before, at + before.length) >= 0)
    throw new Error(`Ambiguous anchor in ${file}: ${before.slice(0, 120)}`);
  write(file, content.slice(0, at) + after + content.slice(at + before.length));
}
function replaceCount(file, before, after, expected) {
  let content = read(file);
  const count = content.split(before).length - 1;
  if (count !== expected)
    throw new Error(`Expected ${expected} anchors in ${file}, found ${count}: ${before.slice(0, 100)}`);
  write(file, content.split(before).join(after));
}

replaceOnce(
  "src/server/builders.ts",
  `import { reconcilePresentationPlan } from "./reconcile.js";`,
  `import { reconcilePresentationPlan } from "./reconcile.js";\nimport { compileArtifactPlan } from "./artifact-compiler.js";`,
);
replaceOnce(
  "src/server/builders.ts",
  `  prompt = "",\n  limit = 10,\n): Promise<CollectedImages> {`,
  `  prompt = "",\n): Promise<CollectedImages> {`,
);
replaceOnce(
  "src/server/builders.ts",
  `    .filter(\n      (item): item is {\n        section: ArtifactPlan["sections"][number] & { imageQuery: string };\n        sectionIndex: number;\n      } => Boolean(item.section.imageQuery),\n    )\n    .slice(0, limit);`,
  `    .filter(\n      (item): item is {\n        section: ArtifactPlan["sections"][number] & { imageQuery: string };\n        sectionIndex: number;\n      } => Boolean(item.section.imageQuery),\n    );`,
);
replaceCount(
  "src/server/builders.ts",
  `    prompt,\n    10,\n  );`,
  `    prompt,\n  );`,
  2,
);
replaceOnce(
  "src/server/builders.ts",
  `    prompt,\n    12,\n  );`,
  `    prompt,\n  );`,
);
replaceOnce(
  "src/server/builders.ts",
  `): Promise<BuiltFile> {\n  if (kind === "presentation") return pptx(config, plan, prompt, jobId);\n  if (kind === "document" || kind === "analysis" || kind === "research")\n    return docx(config, plan, prompt, kind, jobId);\n  if (kind === "website") return website(config, plan, prompt, jobId);`,
  `): Promise<BuiltFile> {\n  // Builder boundary is independently safe: callers cannot bypass deterministic\n  // pagination/reflow by invoking buildArtifact directly. The compiler is\n  // intentionally idempotent, so AgentRunner may also compile before this point.\n  const compiledPlan = compileArtifactPlan(kind, plan).plan;\n  if (kind === "presentation") return pptx(config, compiledPlan, prompt, jobId);\n  if (kind === "document" || kind === "analysis" || kind === "research")\n    return docx(config, compiledPlan, prompt, kind, jobId);\n  if (kind === "website") return website(config, compiledPlan, prompt, jobId);`,
);

replaceOnce(
  "src/server/artifact-quality.ts",
  `function assertOutputCoverage(kind: JobKind, prompt: string, plan: ArtifactPlan, visibleText: string): void {\n  const normalized = visibleText.replace(/\\s+/g, " ").trim();\n  if (normalized.length < 200)\n    throw new Error("Artifact output validation failed: finished artifact contains too little visible content");\n  for (const section of plan.sections) {\n    if (!normalized.toLocaleLowerCase().includes(section.heading.toLocaleLowerCase().slice(0, 40)))\n      throw new Error(\`Artifact output validation failed: section '\${section.heading}' is missing from the finished artifact\`);\n  }\n  if (kind === "presentation" && SPEED_DATING_RE.test(prompt) && !SPEED_DATING_RE.test(normalized))\n    throw new Error("Artifact output validation failed: Speed Dating is missing from the finished deck");\n  if (kind === "presentation" && FOUR_CORNERS_RE.test(prompt) && !FOUR_CORNERS_RE.test(normalized))\n    throw new Error("Artifact output validation failed: Four Corners is missing from the finished deck");\n}`,
  `function assertOutputCoverage(kind: JobKind, prompt: string, plan: ArtifactPlan, visibleText: string): void {\n  const normalize = (value: string) => value.replace(/\\s+/g, " ").trim().toLocaleLowerCase();\n  const normalized = normalize(visibleText);\n  if (normalized.length < 200)\n    throw new Error("Artifact output validation failed: finished artifact contains too little visible content");\n\n  const requireVisible = (label: string, value: string) => {\n    const expected = normalize(value);\n    if (!expected) return;\n    if (!normalized.includes(expected))\n      throw new Error(\`Artifact output validation failed: \${label} is missing from the finished artifact\`);\n  };\n\n  for (const section of plan.sections) {\n    const headingNeedle = normalize(section.heading).slice(0, 40);\n    if (headingNeedle && !normalized.includes(headingNeedle))\n      throw new Error(\`Artifact output validation failed: section '\${section.heading}' is missing from the finished artifact\`);\n    requireVisible(\`body for section '\${section.heading}'\`, section.body);\n    section.bullets.forEach((bullet, index) => requireVisible(\`bullet \${index + 1} for section '\${section.heading}'\`, bullet));\n    const activity = section.activity;\n    if (activity) {\n      activity.directions.forEach((value, index) => requireVisible(\`activity direction \${index + 1} for section '\${section.heading}'\`, value));\n      activity.prompts.forEach((value, index) => requireVisible(\`activity prompt \${index + 1} for section '\${section.heading}'\`, value));\n      activity.sentenceFrames.forEach((value, index) => requireVisible(\`sentence frame \${index + 1} for section '\${section.heading}'\`, value));\n      activity.cornerLabels.forEach((value, index) => requireVisible(\`corner label \${index + 1} for section '\${section.heading}'\`, value));\n    }\n    if (section.table) {\n      requireVisible(\`table title for section '\${section.heading}'\`, section.table.title);\n      section.table.headers.forEach((value, index) => requireVisible(\`table header \${index + 1} for section '\${section.heading}'\`, value));\n      section.table.rows.flat().forEach((value, index) => requireVisible(\`table cell \${index + 1} for section '\${section.heading}'\`, value));\n    }\n  }\n  if (kind === "presentation" && SPEED_DATING_RE.test(prompt) && !SPEED_DATING_RE.test(normalized))\n    throw new Error("Artifact output validation failed: Speed Dating is missing from the finished deck");\n  if (kind === "presentation" && FOUR_CORNERS_RE.test(prompt) && !FOUR_CORNERS_RE.test(normalized))\n    throw new Error("Artifact output validation failed: Four Corners is missing from the finished deck");\n}`,
);

console.log("Artifact fidelity hardening v2 applied.");
