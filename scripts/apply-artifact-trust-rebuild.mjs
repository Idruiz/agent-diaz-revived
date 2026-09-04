import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, value) => fs.writeFileSync(path.join(root, p), value);

function replaceOnce(file, before, after) {
  let value = read(file);
  const first = value.indexOf(before);
  if (first < 0) throw new Error(`Patch anchor missing in ${file}: ${before.slice(0, 120)}`);
  if (value.indexOf(before, first + before.length) >= 0)
    throw new Error(`Patch anchor is not unique in ${file}: ${before.slice(0, 120)}`);
  value = value.slice(0, first) + after + value.slice(first + before.length);
  write(file, value);
}

function replaceBetween(file, start, end, replacement) {
  const value = read(file);
  const a = value.indexOf(start);
  if (a < 0) throw new Error(`Start anchor missing in ${file}`);
  const b = value.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`End anchor missing in ${file}`);
  write(file, value.slice(0, a) + replacement + value.slice(b));
}

// 1. Make the semantic contract physically compatible with the deterministic renderers.
replaceOnce(
  "src/shared/contracts.ts",
  '  directions: z.array(z.string().min(2).max(300)).min(2).max(8),\n  prompts: z.array(z.string().min(2).max(500)).min(1).max(16),\n  sentenceFrames: z.array(z.string().min(2).max(300)).max(12).default([]),\n  cornerLabels: z.array(z.string().min(1).max(120)).max(4).default([]),',
  '  // These are render-surface budgets, not aesthetic suggestions. The deterministic\n  // PPTX templates can display every accepted value without slicing or ellipsis.\n  directions: z.array(z.string().min(2).max(180)).min(2).max(5),\n  prompts: z.array(z.string().min(2).max(240)).min(1).max(6),\n  sentenceFrames: z.array(z.string().min(2).max(180)).max(4).default([]),\n  cornerLabels: z.array(z.string().min(1).max(80)).max(4).default([]),'
);
replaceOnce(
  "src/shared/contracts.ts",
  '        heading: z.string().min(1).max(180),\n        body: z.string().min(1).max(8000),\n        bullets: z.array(z.string().max(500)).max(12).default([]),',
  '        // Atomic strings are bounded to what the narrowest deterministic surface\n        // can faithfully render. Long bodies and bullet lists are paginated later by\n        // the compiler; individual strings are never silently truncated.\n        heading: z.string().min(1).max(92),\n        body: z.string().min(1).max(8000),\n        bullets: z.array(z.string().max(180)).max(12).default([]),'
);
replaceOnce(
  "src/shared/contracts.ts",
  '            title: z.string().max(180),',
  '            title: z.string().max(140),'
);
replaceOnce(
  "src/shared/contracts.ts",
  '            title: z.string().max(180),\n            type: z.enum(["bar", "line", "pie", "donut"]),',
  '            title: z.string().max(120),\n            type: z.enum(["bar", "line", "pie", "donut"]),'
);
replaceOnce(
  "src/shared/contracts.ts",
  '            sourceNote: z.string().max(300).optional().default(""),',
  '            sourceNote: z.string().max(180).optional().default(""),'
);
replaceOnce(
  "src/shared/contracts.ts",
  '            title: z.string().max(180),\n            nodes: z.array(z.string().max(100)).min(2).max(8),',
  '            title: z.string().max(120),\n            nodes: z.array(z.string().max(100)).min(2).max(8),'
);

// 2. Add a real deterministic content-to-layout compiler.
write(
  "src/server/artifact-compiler.ts",
  `import type { ArtifactPlan, JobKind } from "../shared/contracts.js";\nimport type { ArtifactNormalizationReceipt } from "./artifact-quality.js";\n\nconst MAX_PRESENTATION_BODY = 440;\nconst MAX_PRESENTATION_BULLETS = 5;\nconst MAX_HEADING = 92;\n\nfunction chunks(value: string, maxChars: number): string[] {\n  const clean = value.replace(/\\s+/g, " ").trim();\n  if (!clean) return [""];\n  if (clean.length <= maxChars) return [clean];\n  const words = clean.split(" ");\n  const out: string[] = [];\n  let current = "";\n  for (const word of words) {\n    if (!current) { current = word; continue; }\n    if ((current + " " + word).length <= maxChars) current += " " + word;\n    else { out.push(current); current = word; }\n  }\n  if (current) out.push(current);\n  return out;\n}\n\nfunction continuationHeading(base: string, index: number): string {\n  const suffix = \` — continued \${index}\`;\n  const available = Math.max(12, MAX_HEADING - suffix.length);\n  return \`\${base.slice(0, available).trimEnd()}\${suffix}\`;\n}\n\nfunction standardFragments(\n  section: ArtifactPlan["sections"][number],\n): ArtifactPlan["sections"] {\n  const bodyChunks = chunks(section.body, MAX_PRESENTATION_BODY);\n  const bulletGroups = Array.from(\n    { length: Math.max(1, Math.ceil(section.bullets.length / MAX_PRESENTATION_BULLETS)) },\n    (_, index) => section.bullets.slice(\n      index * MAX_PRESENTATION_BULLETS,\n      index * MAX_PRESENTATION_BULLETS + MAX_PRESENTATION_BULLETS,\n    ),\n  );\n  const count = Math.max(bodyChunks.length, bulletGroups.length);\n  return Array.from({ length: count }, (_, index) => ({\n    ...structuredClone(section),\n    heading: index === 0 ? section.heading : continuationHeading(section.heading, index + 1),\n    body: bodyChunks[index] ?? "",\n    bullets: bulletGroups[index] ?? [],\n    imageQuery: index === 0 ? section.imageQuery : undefined,\n  }));\n}\n\nfunction contextFragments(\n  section: ArtifactPlan["sections"][number],\n): ArtifactPlan["sections"] {\n  const source = {\n    ...structuredClone(section),\n    heading: continuationHeading(section.heading, 1).replace("continued 1", "context"),\n    layout: "standard" as const,\n    activity: undefined,\n    table: undefined,\n    chart: undefined,\n    diagram: undefined,\n    imageQuery: undefined,\n  };\n  return standardFragments(source);\n}\n\n/**\n * Converts a semantic ArtifactPlan into a render-admissible plan before any PPTX\n * bytes are written. This stage owns pagination. Builders must not discover fit\n * failures after serialization and must not delete semantic content with slice().\n */\nexport function compileArtifactPlan(\n  kind: JobKind,\n  input: ArtifactPlan,\n): { plan: ArtifactPlan; normalizations: ArtifactNormalizationReceipt[] } {\n  if (kind !== "presentation")\n    return { plan: structuredClone(input), normalizations: [] };\n\n  const plan = structuredClone(input);\n  const compiled: ArtifactPlan["sections"] = [];\n  const normalizations: ArtifactNormalizationReceipt[] = [];\n\n  for (const section of plan.sections) {\n    const structured = Boolean(section.table || section.chart || section.diagram);\n    const activity = section.activity?.type;\n    const bodyLimit = activity === "four_corners" ? 280 : activity ? 340 : MAX_PRESENTATION_BODY;\n    const bodyNeedsPagination = section.body.replace(/\\s+/g, " ").trim().length > bodyLimit;\n    const bulletsNeedPagination = section.bullets.length > MAX_PRESENTATION_BULLETS;\n    const builderDoesNotRenderBody = structured || activity === "speed_dating";\n    const builderDoesNotRenderBullets = Boolean(activity);\n\n    if (builderDoesNotRenderBody || builderDoesNotRenderBullets || bodyNeedsPagination || bulletsNeedPagination) {\n      const context = contextFragments(section);\n      compiled.push(...context);\n      normalizations.push({\n        code: "presentation_content_paginated",\n        detail: \`Moved audience-facing context for '\${section.heading}' into \${context.length} deterministic context slide(s) so no body or bullet content is dropped.\`,\n      });\n      const primary = structuredClone(section);\n      primary.body = chunks(section.body, bodyLimit)[0] ?? "";\n      primary.bullets = [];\n      compiled.push(primary);\n      continue;\n    }\n\n    const fragments = standardFragments(section);\n    compiled.push(...fragments);\n    if (fragments.length > 1)\n      normalizations.push({\n        code: "presentation_content_paginated",\n        detail: \`Split '\${section.heading}' into \${fragments.length} deterministic slides to preserve all audience-facing content.\`,\n      });\n  }\n\n  plan.sections = compiled;\n  return { plan, normalizations };\n}\n`
);

// 3. Stop using quality preferences as repair triggers; compile before validation.
replaceOnce(
  "src/server/openai-agent.ts",
  'import fs from "node:fs";\nimport { createHash } from "node:crypto";',
  'import fs from "node:fs";\nimport path from "node:path";\nimport { createHash } from "node:crypto";'
);
replaceOnce(
  "src/server/openai-agent.ts",
  'import { buildArtifact } from "./builders.js";',
  'import { buildArtifact } from "./builders.js";\nimport { compileArtifactPlan } from "./artifact-compiler.js";'
);
replaceOnce(
  "src/server/openai-agent.ts",
  'const MAX_ARTIFACT_LLM_CALLS = 6;\nconst MAX_ARTIFACT_WALL_TIME_MS = 20 * 60 * 1000;',
  'const MAX_ARTIFACT_LLM_CALLS = 6;\nconst MAX_ARTIFACT_WALL_TIME_MS = 20 * 60 * 1000;\nconst MAX_PROVIDER_AUTOMATIC_RETRIES = 2;\nconst MAX_ASSET_BUILD_ATTEMPTS = 2;'
);
replaceOnce(
  "src/server/openai-agent.ts",
  '  return sha256Text(JSON.stringify(input));',
  '  // Package bytes can legitimately differ between deterministic attempts because\n  // OOXML embeds generated identifiers/timestamps. Loop detection therefore keys on\n  // the logical failure, not the regenerated package SHA.\n  return sha256Text(JSON.stringify({\n    failureClass: input.failureClass,\n    ruleOrPart: input.ruleOrPart,\n    planSha: input.planSha,\n    strategy: input.strategy,\n  }));'
);
replaceOnce(
  "src/server/openai-agent.ts",
  '  return { plan, normalizations };\n}\n\nexport function collectArtifactPlanViolations(',
  '  const compiled = compileArtifactPlan(kind, plan);\n  normalizations.push(...compiled.normalizations);\n  return { plan: compiled.plan, normalizations };\n}\n\nexport function collectArtifactPlanViolations('
);
replaceOnce(
  "src/server/openai-agent.ts",
  '  if (!violations.length) return;\n  throw new ArtifactPipelineError(\n    "PLAN_CONTENT",\n    `Artifact plan content violations:\\n${violations\n      .map(\n        (violation) =>\n          `- [${violation.code}] ${violation.message}`,\n      )\n      .join("\\n")}`,\n    { ruleOrPart: "plan-content" },\n  );',
  '  const blocking = violations.filter((violation) => violation.mandatory);\n  if (!blocking.length) return;\n  throw new ArtifactPipelineError(\n    "PLAN_CONTENT",\n    `Artifact plan content violations:\\n${blocking\n      .map(\n        (violation) =>\n          `- [${violation.code}] ${violation.message}`,\n      )\n      .join("\\n")}`,\n    { ruleOrPart: "plan-content" },\n  );'
);
replaceOnce(
  "src/server/openai-agent.ts",
  '  const blocking = allowNonMandatoryWarnings\n    ? violations.filter((violation) => violation.mandatory)\n    : violations;\n  if (blocking.length)\n    throw new ArtifactPlanContentError(\n      blocking,\n      normalized.plan,\n      normalized.normalizations,\n    );\n\n  const downgraded = allowNonMandatoryWarnings\n    ? violations\n        .filter((violation) => !violation.mandatory)\n        .map((violation) => ({\n          code: `downgraded_${violation.code}`,\n          detail: `Downgraded after two bounded plan-repair calls: ${violation.message}`,\n        }))\n    : [];\n  return {\n    plan: normalized.plan,\n    normalizations: [\n      ...normalized.normalizations,\n      ...downgraded,\n    ],\n  };',
  '  const blocking = violations.filter((violation) => violation.mandatory);\n  if (blocking.length)\n    throw new ArtifactPlanContentError(\n      blocking,\n      normalized.plan,\n      normalized.normalizations,\n    );\n\n  // Quality targets are telemetry. They never consume a plan-repair call.\n  const warnings = violations\n    .filter((violation) => !violation.mandatory)\n    .map((violation) => ({\n      code: `quality_warning_${violation.code}`,\n      detail: violation.message,\n    }));\n  return {\n    plan: normalized.plan,\n    normalizations: [...normalized.normalizations, ...warnings],\n  };'
);
replaceOnce(
  "src/server/openai-agent.ts",
  '      const mayRetry =\n        persistentRetry ||\n        (!this.config.MCP_SERVER_URL &&\n          automaticRetries === 1 &&\n          isTransientProviderFailure(response));',
  '      const mayRetry =\n        automaticRetries <= MAX_PROVIDER_AUTOMATIC_RETRIES &&\n        isTransientProviderFailure(response) &&\n        (persistentRetry || !this.config.MCP_SERVER_URL);'
);
replaceOnce(
  "src/server/openai-agent.ts",
  '            try {\n              const file = await buildArtifact(\n                this.config,\n                job.kind,\n                plan,\n                job.prompt,\n                jobId,\n              );',
  '            const buildWorkspace = path.join(\n              this.config.artifactDir,\n              ".work",\n              jobId,\n              `attempt-${buildAttempt + 1}`,\n            );\n            fs.mkdirSync(buildWorkspace, { recursive: true });\n            try {\n              const file = await buildArtifact(\n                { ...this.config, artifactDir: buildWorkspace },\n                job.kind,\n                plan,\n                job.prompt,\n                jobId,\n              );'
);
replaceOnce(
  "src/server/openai-agent.ts",
  '              const id = crypto.randomUUID();\n              this.db.addArtifact({\n                id,\n                jobId,\n                name: file.name,\n                mime: file.mime,\n                size: file.size,\n                path: file.path,\n                receipt: file.validationReceipt,\n              });',
  '              const id = crypto.randomUUID();\n              const extension = path.extname(file.name);\n              const durableName = `${path.basename(file.name, extension)}-${id.slice(0, 12)}${extension}`;\n              const durablePath = path.join(this.config.artifactDir, durableName);\n              fs.mkdirSync(this.config.artifactDir, { recursive: true });\n              fs.renameSync(file.path, durablePath);\n              file.name = durableName;\n              file.path = durablePath;\n              fs.rmSync(path.join(this.config.artifactDir, ".work", jobId), {\n                recursive: true,\n                force: true,\n              });\n              this.db.addArtifact({\n                id,\n                jobId,\n                name: file.name,\n                mime: file.mime,\n                size: file.size,\n                path: file.path,\n                receipt: file.validationReceipt,\n              });'
);
replaceOnce(
  "src/server/openai-agent.ts",
  '            } catch (buildError) {\n              buildAttempt++;',
  '            } catch (buildError) {\n              fs.rmSync(path.join(this.config.artifactDir, ".work", jobId), {\n                recursive: true,\n                force: true,\n              });\n              buildAttempt++;'
);
replaceOnce(
  "src/server/openai-agent.ts",
  '              if (failureRecord.classified.failureClass === "INFRA")\n                throw failureRecord.classified;\n\n              if (failureRecord.duplicateCount >= 2)',
  '              if (failureRecord.classified.failureClass === "INFRA")\n                throw failureRecord.classified;\n\n              const allowedBuildAttempts =\n                failureRecord.classified.failureClass === "ASSET"\n                  ? MAX_ASSET_BUILD_ATTEMPTS\n                  : 1;\n              if (buildAttempt >= allowedBuildAttempts)\n                throw failureRecord.classified;\n\n              if (failureRecord.duplicateCount >= 2)'
);
replaceBetween(
  "src/server/openai-agent.ts",
  '      if (\n        current &&\n        current.status !== "cancelled" &&\n        artifactKinds.includes(current.kind)\n      ) {\n        const restartEvidencePhase =',
  '      this.db.updateJob(jobId, {\n        status: "failed",\n        message: "Failed",',
  `      if (\n        current &&\n        current.status !== "cancelled" &&\n        artifactKinds.includes(current.kind)\n      ) {\n        const classified = classifyArtifactFailure(e);\n        const blocked = classified.failureClass === "INFRA";\n        this.db.updateJob(jobId, {\n          status: blocked ? "blocked" : "failed",\n          progress: Math.max(10, Math.min(96, current.progress)),\n          message: blocked\n            ? "blocked: infrastructure"\n            : "Artifact stopped: unexpected deterministic failure",\n          error: classified.message,\n        });\n        const existing = this.db.raw\n          .prepare(\n            "SELECT id FROM messages WHERE job_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1",\n          )\n          .get(jobId) as { id: string } | undefined;\n        if (existing)\n          this.db.updateMessage(existing.id, {\n            status: "failed",\n            error: classified.message,\n          });\n        log(blocked ? "warn" : "error", "artifact.unexpected_failure_stopped", {\n          jobId,\n          kind: current.kind,\n          failureClass: classified.failureClass,\n          ruleOrPart: classified.ruleOrPart,\n          error: classified.message,\n        });\n        return;\n      }\n`
);

// 4. Validators prove objective breakage; quality heuristics become receipts.
replaceOnce(
  "src/server/artifact-quality.ts",
  '  normalizations: ArtifactNormalizationReceipt[];\n}',
  '  normalizations: ArtifactNormalizationReceipt[];\n  qualityWarnings: ArtifactNormalizationReceipt[];\n}'
);
replaceOnce(
  "src/server/artifact-quality.ts",
  '    if (plan.sections.length > 14)\n      push(\n        "presentation_sections_excess",\n        `Presentation supports at most 14 content sections; received ${plan.sections.length}.`,\n      );',
  '    if (plan.sections.length > 14)\n      push(\n        "presentation_sections_excess",\n        `Presentation compiled to ${plan.sections.length} content sections; this is a quality metric, not a validity failure.`,\n        false,\n      );'
);
replaceOnce(
  "src/server/artifact-quality.ts",
  '  const violations = artifactPlanQualityViolations(kind, prompt, plan);\n  if (!violations.length) return;\n  throw new ArtifactPipelineError(\n    "PLAN_CONTENT",\n    `Artifact plan content violations:\\n${violations\n      .map((violation) => `- [${violation.code}] ${violation.message}`)\n      .join("\\n")}`,\n    { ruleOrPart: "plan-content" },\n  );',
  '  const violations = artifactPlanQualityViolations(kind, prompt, plan);\n  const blocking = violations.filter((violation) => violation.mandatory);\n  if (!blocking.length) return;\n  throw new ArtifactPipelineError(\n    "PLAN_CONTENT",\n    `Artifact plan content violations:\\n${blocking\n      .map((violation) => `- [${violation.code}] ${violation.message}`)\n      .join("\\n")}`,\n    { ruleOrPart: "plan-content" },\n  );'
);
replaceOnce(
  "src/server/artifact-quality.ts",
  'function decodeXml(value: string): string {\n  return value\n    .replace(/&lt;/g, "<")\n    .replace(/&gt;/g, ">")\n    .replace(/&quot;/g, \'"\')\n    .replace(/&apos;/g, "\'")\n    .replace(/&amp;/g, "&")\n    .replace(/&#(\\d+);/g, (_, code) => String.fromCharCode(Number(code)));\n}\n',
  'function decodeXml(value: string): string {\n  return value\n    .replace(/&lt;/g, "<")\n    .replace(/&gt;/g, ">")\n    .replace(/&quot;/g, \'"\')\n    .replace(/&apos;/g, "\'")\n    .replace(/&amp;/g, "&")\n    .replace(/&#(\\d+);/g, (_, code) => String.fromCharCode(Number(code)));\n}\n\nexport function assertPresentationSlidesHaveMeaningfulContent(filePath: string): void {\n  const zip = new AdmZip(filePath);\n  const slides = zip.getEntries()\n    .filter((entry) => /^ppt\\/slides\\/slide\\d+\\.xml$/.test(entry.entryName))\n    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));\n  for (const [index, entry] of slides.entries()) {\n    const xml = entry.getData().toString("utf8");\n    const text = [...xml.matchAll(/<a:t>([\\s\\S]*?)<\\/a:t>/g)]\n      .map((match) => decodeXml(match[1]!).replace(/\\s+/g, " ").trim())\n      .filter(Boolean)\n      .join(" ")\n      .replace(/\\b(?:AGENT DÍAZ|VISUAL BRIEF|EVIDENCE TRAIL|DIRECTIONS|PART \\d+|\\d{1,3})\\b/gi, " ")\n      .replace(/\\s+/g, " ")\n      .trim();\n    const hasSubstantiveText = text.length >= 8;\n    const hasMeaningfulVisual = /<p:(?:pic|graphicFrame)\\b/.test(xml);\n    if (!hasSubstantiveText && !hasMeaningfulVisual)\n      throw new ArtifactPipelineError(\n        "BUILD",\n        `Presentation contains an objectively empty slide at slide ${index + 1}.`,\n        { ruleOrPart: `pptx-empty-slide-${index + 1}` },\n      );\n  }\n}\n'
);
replaceOnce(
  "src/server/artifact-quality.ts",
  '    if (kind === "presentation") assertPresentationPackage(buffer);',
  '    if (kind === "presentation") {\n      assertPresentationPackage(buffer);\n      assertPresentationSlidesHaveMeaningfulContent(filePath);\n    }'
);
replaceBetween(
  "src/server/artifact-quality.ts",
  '    if (kind === "presentation") {\n      const ratios = estimatePptxEmptyCanvasRatio(filePath).bySlide;',
  '    let schemaValidator: string | null = null;',
  '    // Empty-canvas ratio is diagnostic telemetry only. Truly empty slides are\n    // rejected above using visible-content/package evidence.\n\n'
);
replaceOnce(
  "src/server/artifact-quality.ts",
  '    const receipt: ArtifactValidationReceipt = {\n      kind,',
  '    const scores = artifactQualityScores(kind, plan, filePath);\n    const qualityWarnings: ArtifactNormalizationReceipt[] = [];\n    if (kind === "presentation") {\n      const contentSlides =\n        diagnostics?.presentationContentSlides ??\n        plan.sections.map((_, index) => index + 2);\n      const sparse = contentSlides\n        .map((slideNumber) => ({ slideNumber, ratio: scores.emptyCanvasRatio.bySlide[slideNumber - 1] }))\n        .filter((item): item is { slideNumber: number; ratio: number } =>\n          typeof item.ratio === "number" && item.ratio > 0.55,\n        );\n      if (sparse.length)\n        qualityWarnings.push({\n          code: "pptx_empty_canvas_metric",\n          detail: `Diagnostic only: ${sparse.map(({ slideNumber, ratio }) => `slide ${slideNumber}=${ratio.toFixed(3)}`).join(", ")}.`,\n        });\n    }\n    const receipt: ArtifactValidationReceipt = {\n      kind,'
);
replaceOnce(
  "src/server/artifact-quality.ts",
  '      scores: artifactQualityScores(kind, plan, filePath),',
  '      scores,'
);
replaceOnce(
  "src/server/artifact-quality.ts",
  '      normalizations: [],\n    };',
  '      normalizations: [],\n      qualityWarnings,\n    };'
);

// 5. Make PPTX construction one-pass and ensure Four Corners renders its actual prompt.
replaceOnce(
  "src/server/builders.ts",
  '  let beforeRatios:number[]|null=null;\n\n  const renderAttempt=async(scaled:boolean)=>{',
  '  const renderAttempt=async(scaled:boolean)=>{'
);
replaceOnce(
  "src/server/builders.ts",
  '        const labels=activity.cornerLabels.slice(0,4),colors=["F1E5C5","E7EEF2","E4EFE6","F3E4DF"];',
  '        if(activity.prompts[0])\n          addModelText(slide,activity.prompts[0],{x:.95,y:2.14,w:11.42,fontSize:15,bold:true,color:blue,align:"center",margin:0},{minHeight:.24,maxHeight:.36});\n        const labels=activity.cornerLabels.slice(0,4),colors=["F1E5C5","E7EEF2","E4EFE6","F3E4DF"];'
);
replaceBetween(
  "src/server/builders.ts",
  '  for(const scaled of [false,true]){',
  '}\n\nasync function docx(',
  `  const rendered=await renderAttempt(false);\n  const ratios=estimatePptxEmptyCanvasRatio(target).bySlide;\n  const validationReceipt=await validateBuiltArtifact(\n    "presentation",\n    prompt,\n    reconciled.plan,\n    target,\n    jobId\n      ?{root:path.join(config.storageRoot,"diagnostics"),jobId,presentationContentSlides:rendered.contentSlideNumbers}\n      :{presentationContentSlides:rendered.contentSlideNumbers},\n  );\n  collectedImages.metrics.placed=rendered.placedImageQueries.size;\n  const enrichedReceipt=validationReceipt as ArtifactValidationReceipt&{images:ImageResolutionReceipt;presentation:PresentationBuildReceipt};\n  enrichedReceipt.images=collectedImages.metrics;\n  enrichedReceipt.presentation={\n    placedAssets:rendered.placedImageQueries.size,\n    activityTemplates:[...rendered.usedActivityTemplates].sort(),\n    reconciliations:reconciled.reconciliations,\n    titleCounts:{contentSlides:rendered.contentSlideNumbers.length,licensedVisuals:rendered.placedImageQueries.size},\n    layoutFitting:{retried:false,before:null,after:ratios},\n  };\n  return{name,mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",path:target,size:rendered.raw.length,validationReceipt};\n}\n\nasync function docx(`
);

// 6. Correct tests that previously encoded routine repair as success.
replaceOnce(
  "src/server/__tests__/artifact-quality.test.ts",
  '  it("retries a sparse deck once with the same plan and publishes only ratios at or below 0.55", async () => {',
  '  it("publishes a structurally valid sparse deck on the first deterministic build and records sparsity as telemetry", async () => {'
);
replaceOnce(
  "src/server/__tests__/artifact-quality.test.ts",
  '    expect(receipt.presentation.layoutFitting).toMatchObject({\n      retried: true,\n    });',
  '    expect(receipt.presentation.layoutFitting).toMatchObject({\n      retried: false,\n      before: null,\n    });\n    expect(receipt.qualityWarnings).toEqual(\n      expect.arrayContaining([\n        expect.objectContaining({ code: "pptx_empty_canvas_metric" }),\n      ]),\n    );'
);
replaceOnce(
  "src/server/__tests__/artifact-quality.test.ts",
  '    expect(\n      receipt.presentation.layoutFitting.before.some(\n        (ratio: number) => ratio > 0.55,\n      ),\n    ).toBe(true);\n    for (let slideNumber = 2; slideNumber <= 9; slideNumber++)\n      expect(\n        receipt.presentation.layoutFitting.after[slideNumber - 1],\n      ).toBeLessThanOrEqual(0.55);',
  '    expect(\n      receipt.presentation.layoutFitting.after.some(\n        (ratio: number) => ratio > 0.55,\n      ),\n    ).toBe(true);'
);
replaceOnce(
  "src/server/__tests__/agent.test.ts",
  '    expect(create).toHaveBeenCalledTimes(4);\n    const firstRepairRequest = create.mock.calls[2]![0] as any;\n    const secondRepairRequest = create.mock.calls[3]![0] as any;',
  '    expect(create).toHaveBeenCalledTimes(3);\n    const firstRepairRequest = create.mock.calls[2]![0] as any;'
);
replaceBetween(
  "src/server/__tests__/agent.test.ts",
  '    expect(secondRepairRequest.tools).toBeUndefined();',
  '    expect(db.getJob(job.id)).toMatchObject({',
  '    // The second plan only misses a visual-density target. That is telemetry,\n    // so it must not consume another LLM repair call.\n'
);
replaceOnce(
  "src/server/__tests__/agent.test.ts",
  '    expect(db.getProviderResponseId(job.id)).toBe("resp_repaired_plan");',
  '    expect(db.getProviderResponseId(job.id)).toBe("resp_still_invalid_plan");'
);

// 7. Add focused trust regressions.
write(
  "src/server/__tests__/artifact-trust.test.ts",
  `import { describe, expect, it } from "vitest";\nimport { ArtifactPlanSchema } from "../../shared/contracts";\nimport { compileArtifactPlan } from "../artifact-compiler";\nimport { assertArtifactPlanQuality } from "../artifact-quality";\n\nfunction basePlan() {\n  return ArtifactPlanSchema.parse({\n    title: "Trust regression",\n    subtitle: "Deterministic content contract",\n    requirements: [{ id: "R1", text: "Deliver all requested content", mandatory: true }],\n    sections: [\n      {\n        heading: "Dense audience-facing explanation",\n        body: Array.from({ length: 120 }, (_, i) => \`sentence\${i}\`).join(" "),\n        bullets: Array.from({ length: 12 }, (_, i) => \`Complete bullet \${i + 1} with preserved content\`),\n        speakerNotes: "Explain the evidence.",\n        requirementIds: ["R1"],\n        layout: "standard",\n      },\n    ],\n    sources: [],\n  });\n}\n\ndescribe("artifact trust contract", () => {\n  it("paginates presentation copy before rendering without silently deleting body words or bullets", () => {\n    const input = basePlan();\n    const compiled = compileArtifactPlan("presentation", input);\n    expect(compiled.plan.sections.length).toBeGreaterThan(1);\n    expect(compiled.plan.sections.every((section) => section.body.length <= 440)).toBe(true);\n    expect(compiled.plan.sections.every((section) => section.bullets.length <= 5)).toBe(true);\n    const originalWords = input.sections[0]!.body.replace(/\\s+/g, " ").trim();\n    const compiledWords = compiled.plan.sections.map((s) => s.body).filter(Boolean).join(" ");\n    expect(compiledWords).toBe(originalWords);\n    expect(compiled.plan.sections.flatMap((s) => s.bullets)).toEqual(input.sections[0]!.bullets);\n  });\n\n  it("does not fail a valid plan merely because it misses a nonmandatory visual target", () => {\n    const plan = basePlan();\n    expect(() =>\n      assertArtifactPlanQuality(\n        "document",\n        "Create a professional document",\n        plan,\n      ),\n    ).not.toThrow();\n  });\n\n  it("enforces atomic activity sizes at the schema boundary instead of truncating in the renderer", () => {\n    const raw = basePlan();\n    const section = raw.sections[0]!;\n    section.activity = {\n      type: "discussion",\n      durationMinutes: 10,\n      directions: ["d1", "d2"],\n      prompts: Array.from({ length: 7 }, (_, i) => \`Prompt \${i + 1}\`),\n      sentenceFrames: [],\n      cornerLabels: [],\n    };\n    expect(() => ArtifactPlanSchema.parse(raw)).toThrow();\n  });\n});\n`
);

// 8. Honest live acceptance harness: this is deliberately not mocked and not part of normal CI.
write(
  "scripts/live-artifact-acceptance.mjs",
  `const base = (process.env.DIAZ_BASE_URL || "").replace(/\\/$/, "");\nconst password = process.env.DIAZ_ADMIN_PASSWORD || "";\nif (!base || !password) {\n  console.error("Set DIAZ_BASE_URL and DIAZ_ADMIN_PASSWORD to run real-provider acceptance.");\n  process.exit(2);\n}\n\nlet cookie = "";\nasync function request(route, init = {}) {\n  const headers = new Headers(init.headers || {});\n  if (cookie) headers.set("cookie", cookie);\n  const response = await fetch(base + route, { ...init, headers });\n  if (!response.ok) throw new Error(`${route} -> ${response.status}: ${await response.text()}`);\n  return response;\n}\n\nconst login = await request("/api/login", {\n  method: "POST",\n  headers: { "content-type": "application/json", origin: base },\n  body: JSON.stringify({ password }),\n});\ncookie = login.headers.get("set-cookie")?.split(";")[0] || "";\nif (!cookie) throw new Error("Login cookie missing");\n\nconst cases = [\n  ["presentation", "Create a teaching presentation to teach the present tense in French, connect it to French culture, and include complete Speed Dating and Four Corners student practice."],\n  ["document", "Create a professional student-facing document about everyday culture in Spain with authentic examples and a discussion activity."],\n  ["research", "Research current evidence about teen social media use in Canada and create a sourced professional report with clear limitations."],\n  ["website", "Create a complete three-page website explaining public spaces in Barcelona with real licensed photography, working navigation, and sources."],\n];\n\nconst results = [];\nfor (const [kind, prompt] of cases) {\n  const conversation = await (await request("/api/conversations", {\n    method: "POST",\n    headers: { "content-type": "application/json", origin: base },\n    body: JSON.stringify({ title: `Acceptance ${kind}` }),\n  })).json();\n  const job = await (await request("/api/jobs", {\n    method: "POST",\n    headers: { "content-type": "application/json", origin: base },\n    body: JSON.stringify({ kind, prompt, conversationId: conversation.id, fileIds: [] }),\n  })).json();\n  let current;\n  const deadline = Date.now() + 20 * 60 * 1000;\n  do {\n    await new Promise((r) => setTimeout(r, 2500));\n    current = await (await request(`/api/jobs/${job.id}`)).json();\n    if (["failed", "blocked", "cancelled"].includes(current.status))\n      throw new Error(`${kind} failed: ${current.error || current.message}`);\n  } while (current.status !== "completed" && Date.now() < deadline);\n  if (current.status !== "completed") throw new Error(`${kind} timed out`);\n  if (current.artifacts?.length !== 1) throw new Error(`${kind} produced ${current.artifacts?.length ?? 0} artifacts`);\n  const artifact = current.artifacts[0];\n  const attempts = artifact.receipt?.attempts || [];\n  if (attempts.length)\n    throw new Error(`${kind} was not first-pass: ${JSON.stringify(attempts)}`);\n  if (kind === "presentation" && artifact.receipt?.presentation?.layoutFitting?.retried)\n    throw new Error("presentation used a layout repair pass");\n  const download = await request(`/api/artifacts/${artifact.id}/download`);\n  const bytes = new Uint8Array(await download.arrayBuffer());\n  if (bytes.length < 1500) throw new Error(`${kind} download unexpectedly small`);\n  results.push({ kind, jobId: job.id, artifact: artifact.name, bytes: bytes.length, firstPass: true });\n  console.log(`[acceptance] ${kind}: first-pass OK (${artifact.name}, ${bytes.length} bytes)`);\n}\nconsole.log(JSON.stringify({ base, results }, null, 2));\n`
);

// 9. Make CI labels honest and add the focused trust test in the production container.
replaceOnce(
  ".github/workflows/verify.yml",
  '      - name: Reproduce exact presentation route inside container',
  '      - name: Run mocked artifact route matrix inside container'
);
replaceOnce(
  ".github/workflows/verify.yml",
  '      - name: Build production container\n        run: docker build --tag agent-diaz-verify:${{ github.sha }} .',
  '      - name: Run artifact trust regressions inside container\n        run: |\n          docker run --rm \\\n            -e CI=1 \\\n            -e GITHUB_SHA=${{ github.sha }} \\\n            agent-diaz-regression:${{ github.sha }} \\\n            npx vitest run --root . src/server/__tests__/artifact-trust.test.ts\n      - name: Build production container\n        run: docker build --tag agent-diaz-verify:${{ github.sha }} .'
);

// 10. Correct documentation claims and record the architecture reset.
let readme = read("README.md");
readme = readme.replace(
  "- Visual PPTX files with editable tables, charts, diagrams, notes, sources, and licensed photography when requested.",
  "- Visual PPTX files with editable text/tables/diagram primitives, rendered evidence charts, notes, sources, and licensed photography when requested. Presentation content is compiled into render-safe slide budgets before serialization."
);
readme = readme.replace(
  "- Three-to-six-page website ZIPs with responsive navigation, inline SVG visualizations, tables, embedded CSS, and embedded licensed Wikimedia images.",
  "- Three-to-six-page website ZIPs with responsive navigation, inline SVG visualizations, tables, one shared stylesheet, and deduplicated local licensed Wikimedia image assets."
);
readme = readme.replace(
  "- `OPEN_ME_FIRST.html` in every website ZIP. Pages work when opened directly on phones and do not depend on preserved asset folders.",
  "- `OPEN_ME_FIRST.html` in every website ZIP. Keep the ZIP contents together when extracting because pages reference the bundled shared stylesheet and image assets."
);
readme = readme.replace(
  "- Docker, Compose, runtime health checks, automated tests, and manual deployment tooling. GitHub Actions are intentionally not used.",
  "- Docker, Compose, runtime health checks, automated tests, GitHub Actions verification, and manual deployment tooling."
);
readme += `\n\n## Artifact trust boundary\n\nAutomated tests are evidence for the exact path they exercise; mocked-provider tests are never described as live end-to-end acceptance. The artifact pipeline separates semantic planning from deterministic compilation, one-pass rendering, objective package/consumer validation, and non-blocking quality telemetry. Soft visual scores do not trigger model repairs. A deterministic BUILD failure is not retried with identical inputs; only bounded transient provider/asset failures may retry. Real-provider acceptance is run separately with \`node scripts/live-artifact-acceptance.mjs\` and requires \`DIAZ_BASE_URL\` plus \`DIAZ_ADMIN_PASSWORD\`.\n`;
write("README.md", readme);

fs.appendFileSync(
  path.join(root, "DECISIONS.md"),
  `\n\n## 2026-09-03 — Artifact trust rebuild\nDECISION: Treat semantic generation, deterministic content compilation, rendering, objective validation, and quality telemetry as separate stages.\nREASON: The prior pipeline allowed render-capacity mismatches and soft quality heuristics to trigger routine repair loops.\n\nDECISION: Quality warnings never trigger LLM repair. Deterministic BUILD failures are single-attempt; ASSET/provider transient retries are bounded.\nREASON: Re-running identical deterministic inputs cannot repair code defects and normalized failure into ordinary operation.\n\nDECISION: Empty-canvas ratio is telemetry only; objectively empty PPTX slides remain hard BUILD failures.\nREASON: Whitespace percentage is not equivalent to emptiness or unusability.\n\nDECISION: Compile presentation content into box-capacity-safe slides before serialization and bound atomic activity strings/counts at the schema boundary.\nREASON: The renderer must not discover fit failures after the PPTX already exists and must never silently slice accepted semantic content.\n\nDECISION: Build each job in an isolated workspace and move the validated artifact to an immutable unique filename.\nREASON: Friendly title-derived filenames could collide across concurrent or historical jobs.\n\nDECISION: Mocked provider tests are labeled as mocked; real-provider acceptance is a separate explicit harness.\nREASON: Green fixtures are not evidence that the live model/provider path works.\n`
);

console.log("Artifact trust rebuild patch applied successfully.");
