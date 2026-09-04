import fs from "node:fs";

function replaceExact(source, oldValue, newValue, label) {
  const count = source.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 anchor, found ${count}`);
  return source.replace(oldValue, newValue);
}

function replaceBetween(source, start, end, replacement, label) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`${label}: start anchor missing`);
  const secondStart = source.indexOf(start, startIndex + start.length);
  if (secondStart >= 0) throw new Error(`${label}: start anchor ambiguous`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`${label}: end anchor missing`);
  return source.slice(0, startIndex) + replacement + source.slice(endIndex);
}

const buildersPath = "src/server/builders.ts";
let builders = fs.readFileSync(buildersPath, "utf8");
builders = replaceExact(
  builders,
  'import { compileArtifactPlan } from "./artifact-compiler.js";\n',
  'import { compileArtifactPlan } from "./artifact-compiler.js";\nimport { planArtifactVisuals } from "./artifact-visual-plan.js";\n',
  "builders visual planner import",
);

const imageLoopStart = `  for (const section of judgeSections) {\n    const decision = judged.decisions.find(`;
const imageLoopEnd = `  return {\n    images,\n    metrics: {`;
const imageLoop = `  for (const section of judgeSections) {\n    const decision = judged.decisions.find(\n      (item) => item.sectionIndex === section.sectionIndex,\n    );\n    const chosen = decision?.chosenCandidate\n      ? section.candidates.find(\n          (candidate) => candidate.id === decision.chosenCandidate,\n        )\n      : undefined;\n\n    if (!chosen) {\n      for (const candidate of section.candidates)\n        rejectedWithReasons.push({\n          sectionIndex: section.sectionIndex,\n          query: section.query,\n          candidateId: candidate.id,\n          title: candidate.title,\n          reason: decision?.reason\n            ? \`Not selected by image judge: \${decision.reason}\`\n            : "Not selected by image judge.",\n        });\n      rejectedWithReasons.push({\n        sectionIndex: section.sectionIndex,\n        query: section.query,\n        candidateId: null,\n        title: null,\n        reason:\n          decision?.reason ||\n          "No candidate met the qualitative relevance bar.",\n      });\n      continue;\n    }\n\n    const downloadOrder = [\n      chosen,\n      ...section.candidates.filter((candidate) => candidate.id !== chosen.id),\n    ];\n    const failedIds = new Set<string>();\n    let selected: CommonsImageCandidate | undefined;\n    for (const candidate of downloadOrder) {\n      try {\n        const image = await downloadCommonsCandidate(candidate);\n        images.set(section.query, image);\n        fetched++;\n        selected = candidate;\n        log(\n          "info",\n          candidate.id === chosen.id\n            ? "artifact.image_judged_retrieved"\n            : "artifact.image_fallback_retrieved",\n          {\n            query: section.query,\n            sectionIndex: section.sectionIndex,\n            candidateId: candidate.id,\n            title: candidate.title,\n            primaryCandidateId: chosen.id,\n          },\n        );\n        break;\n      } catch (error) {\n        failedIds.add(candidate.id);\n        rejectedWithReasons.push({\n          sectionIndex: section.sectionIndex,\n          query: section.query,\n          candidateId: candidate.id,\n          title: candidate.title,\n          reason: \`Candidate download failed: \${error instanceof Error ? error.message : String(error)}\`,\n        });\n        log("warn", "artifact.image_candidate_download_failed", {\n          query: section.query,\n          sectionIndex: section.sectionIndex,\n          candidateId: candidate.id,\n          primaryCandidateId: chosen.id,\n          error: error instanceof Error ? error.message : String(error),\n        });\n      }\n    }\n\n    for (const candidate of section.candidates) {\n      if (candidate.id === selected?.id || failedIds.has(candidate.id)) continue;\n      rejectedWithReasons.push({\n        sectionIndex: section.sectionIndex,\n        query: section.query,\n        candidateId: candidate.id,\n        title: candidate.title,\n        reason: selected\n          ? \`Not used after successfully retrieving '\${selected.title}'.\`\n          : "Not selected by image judge.",\n      });\n    }\n    if (!selected)\n      rejectedWithReasons.push({\n        sectionIndex: section.sectionIndex,\n        query: section.query,\n        candidateId: null,\n        title: null,\n        reason: "All judged image candidates failed download.",\n      });\n  }\n\n`;
builders = replaceBetween(builders, imageLoopStart, imageLoopEnd, imageLoop, "collectImages fallback loop");

builders = replaceExact(
  builders,
  '    const assetPath=`assets/images/${digest}.jpg`;\n',
  '    const assetPath=`assets/images/${digest}.${image.extension === "png" ? "png" : "jpg"}`;\n',
  "website image extension",
);

builders = replaceExact(
  builders,
  '  const fileName=(page:(typeof pages)[number])=>\n    page.slug==="index"?"index.html":`${page.slug}.html`;\n',
  '  const HOME_FILE="MAIN_HOMEPAGE.html";\n  const fileName=(page:(typeof pages)[number])=>\n    page.slug==="index"?HOME_FILE:`${page.slug}.html`;\n',
  "website canonical home filename",
);

builders = replaceExact(
  builders,
  `  const home=htmlPages.find(page=>page.name==="index.html");\n  if(!home)\n    throw new ArtifactPipelineError(\n      "BUILD",\n      "Website build did not produce index.html.",\n      {ruleOrPart:"website-index"},\n    );\n  htmlPages.push({\n    name:"OPEN_ME_FIRST.html",\n    html:home.html,\n  });\n`,
  `  const home=htmlPages.find(page=>page.name===HOME_FILE);\n  if(!home)\n    throw new ArtifactPipelineError(\n      "BUILD",\n      "Website build did not produce the canonical main homepage.",\n      {ruleOrPart:"website-index"},\n    );\n  // MAIN_HOMEPAGE.html is the clearly labelled local entry point and every\n  // generated navigation bar links back to it. index.html remains the standard\n  // hosting alias, while the OPEN_ME files preserve existing user workflows.\n  htmlPages.push(\n    {name:"index.html",html:home.html},\n    {name:"OPEN_ME_FIRST_HOME_PAGE.html",html:home.html},\n    {name:"OPEN_ME_FIRST.html",html:home.html},\n  );\n`,
  "website homepage aliases",
);

builders = replaceExact(
  builders,
  `  const compiledPlan = compileArtifactPlan(kind, plan).plan;\n`,
  `  const visualized = planArtifactVisuals(kind, plan, prompt);\n  log("info", "artifact.visual_plan", { kind, ...visualized.receipt });\n  const compiledPlan = compileArtifactPlan(kind, visualized.plan).plan;\n`,
  "builder visual plan boundary",
);

builders = replaceExact(
  builders,
  `  const ratios=estimatePptxEmptyCanvasRatio(target).bySlide;\n  const validationReceipt=await validateBuiltArtifact(\n`,
  `  const ratios=estimatePptxEmptyCanvasRatio(target).bySlide;\n  collectedImages.metrics.placed=rendered.placedImageQueries.size;\n  log("info", "artifact.image_summary", {\n    kind:"presentation",\n    requested:collectedImages.metrics.requested,\n    judged:collectedImages.metrics.judged,\n    fetched:collectedImages.metrics.fetched,\n    placed:collectedImages.metrics.placed,\n    unresolved:Math.max(0,collectedImages.metrics.requested-collectedImages.metrics.placed),\n  });\n  const validationReceipt=await validateBuiltArtifact(\n`,
  "presentation image summary",
);

builders = replaceExact(
  builders,
  `  atomicWrite(target,buf);\n  const validationReceipt=await validateBuiltArtifact(\n    kind,\n`,
  `  atomicWrite(target,buf);\n  collectedImages.metrics.placed=placedImageQueries.size;\n  log("info", "artifact.image_summary", {\n    kind,\n    requested:collectedImages.metrics.requested,\n    judged:collectedImages.metrics.judged,\n    fetched:collectedImages.metrics.fetched,\n    placed:collectedImages.metrics.placed,\n    unresolved:Math.max(0,collectedImages.metrics.requested-collectedImages.metrics.placed),\n  });\n  const validationReceipt=await validateBuiltArtifact(\n    kind,\n`,
  "document image summary",
);

builders = replaceExact(
  builders,
  `  atomicWrite(target,buf);\n  const validationReceipt=await validateBuiltArtifact(\n    "website",\n`,
  `  atomicWrite(target,buf);\n  collectedImages.metrics.placed=placedImageQueries.size;\n  log("info", "artifact.image_summary", {\n    kind:"website",\n    requested:collectedImages.metrics.requested,\n    judged:collectedImages.metrics.judged,\n    fetched:collectedImages.metrics.fetched,\n    placed:collectedImages.metrics.placed,\n    unresolved:Math.max(0,collectedImages.metrics.requested-collectedImages.metrics.placed),\n    uniqueFiles:uniqueImageAssets.size,\n  });\n  const validationReceipt=await validateBuiltArtifact(\n    "website",\n`,
  "website image summary",
);
fs.writeFileSync(buildersPath, builders);

const exportPath = "src/server/presentation-exports.ts";
let exportsSource = fs.readFileSync(exportPath, "utf8");
const htmlStart = `export function browserPresentationHtml(\n`;
const htmlEnd = `async function renderPdf(\n`;
const htmlReplacement = `function assertJpeg(bytes: Buffer): void {\n  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)\n    throw new Error("Presentation HTML renderer received an invalid JPEG slide");\n}\n\nexport function browserPresentationHtml(\n  title: string,\n  slideImages: Buffer[],\n): string {\n  if (!slideImages.length)\n    throw new Error("Presentation HTML renderer received no slide images");\n  slideImages.forEach(assertJpeg);\n  const safeTitle = escapeHtml(title);\n  const slides = slideImages\n    .map(\n      (bytes, index) =>\n        \`<figure class="slide\${index === 0 ? " active" : ""}" id="slide-\${index + 1}" data-slide="\${index + 1}"><img src="data:image/jpeg;base64,\${bytes.toString("base64")}" alt="Slide \${index + 1} of \${slideImages.length}"></figure>\`,\n    )\n    .join("\\n");\n  return \`<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="color-scheme" content="dark">\n<title>\${safeTitle}</title>\n<style>\n:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1118;color:#f7f3ea}\n*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:#0b1118}body{display:grid;grid-template-rows:auto 1fr;overflow:hidden}\n.bar{display:flex;align-items:center;gap:.7rem;padding:.58rem .75rem;background:#17324d;border-bottom:3px solid #c99a2e;box-shadow:0 8px 24px #0008;z-index:2}.brand{font-weight:850;letter-spacing:.12em;color:#c99a2e;font-size:.78rem;white-space:nowrap}.title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:750}.counter{font-variant-numeric:tabular-nums;color:#d9e0e4;font-size:.85rem;min-width:5.5rem;text-align:center}.actions{display:flex;gap:.35rem;align-items:center}button{appearance:none;border:1px solid #ffffff35;border-radius:.55rem;background:#ffffff12;color:#fff;padding:.45rem .65rem;font:inherit;font-weight:750;cursor:pointer}button:hover{background:#ffffff20}button:disabled{opacity:.4;cursor:default}\n.stage{position:relative;min-height:0;display:grid;place-items:center;padding:.7rem;background:radial-gradient(circle at 50% 35%,#24313d 0,#111820 58%,#090d12 100%);overflow:hidden}.slide{display:none;margin:0;width:min(100%,calc((100vh - 4.5rem) * 16 / 9));max-height:100%;aspect-ratio:16/9;background:#fff;box-shadow:0 24px 80px #000b}.slide.active{display:block}.slide img{display:block;width:100%;height:100%;object-fit:contain;background:#fff}\n.hint{font-size:.72rem;color:#bdc8d1;white-space:nowrap}@media(max-width:820px){.hint,.brand{display:none}.title{font-size:.9rem}.counter{min-width:4rem}.bar{padding:.42rem}.stage{padding:.25rem}button{padding:.4rem .5rem}}\n@media print{html,body{height:auto;background:white;overflow:visible}.bar{display:none}.stage{display:block;padding:0;background:white;overflow:visible}.slide,.slide.active{display:block;width:100%;max-height:none;aspect-ratio:16/9;box-shadow:none;break-after:page;page-break-after:always}.slide:last-child{break-after:auto;page-break-after:auto}}\n</style>\n</head>\n<body>\n<header class="bar"><div class="brand">AGENT DÍAZ</div><div class="title">\${safeTitle}</div><div class="hint">Exact PPTX/PDF visual parity · Arrow keys / Page Up / Page Down</div><div class="counter" id="counter">1 / \${slideImages.length}</div><div class="actions"><button id="prev" type="button" aria-label="Previous slide">◀</button><button id="next" type="button" aria-label="Next slide">▶</button><button id="fullscreen" type="button">Full screen</button></div></header>\n<main class="stage" id="stage">\${slides}</main>\n<script>\n(()=>{const frames=[...document.querySelectorAll(".slide")],counter=document.getElementById("counter"),prev=document.getElementById("prev"),next=document.getElementById("next");let index=0;const show=value=>{index=Math.max(0,Math.min(frames.length-1,value));frames.forEach((frame,i)=>frame.classList.toggle("active",i===index));counter.textContent=(index+1)+" / "+frames.length;prev.disabled=index===0;next.disabled=index===frames.length-1;};prev.addEventListener("click",()=>show(index-1));next.addEventListener("click",()=>show(index+1));document.getElementById("fullscreen").addEventListener("click",()=>{const stage=document.getElementById("stage");if(document.fullscreenElement)document.exitFullscreen();else stage.requestFullscreen();});addEventListener("keydown",event=>{if(["ArrowRight","PageDown"," "].includes(event.key)){event.preventDefault();show(index+1);}else if(["ArrowLeft","PageUp"].includes(event.key)){event.preventDefault();show(index-1);}else if(event.key==="Home")show(0);else if(event.key==="End")show(frames.length-1);});show(0);})();\n</script>\n</body>\n</html>\`;\n}\n\nasync function renderPdfSlideJpegs(pdfPath: string): Promise<Buffer[]> {\n  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-html-slides-"));\n  try {\n    const prefix = path.join(tempRoot, "slide");\n    const { stdout, stderr } = await execFileAsync(\n      "pdftoppm",\n      ["-jpeg", "-r", "144", "-jpegopt", "quality=90,progressive=y", pdfPath, prefix],\n      { timeout: 120_000, maxBuffer: 1_000_000 },\n    );\n    const files = fs.readdirSync(tempRoot)\n      .filter((name) => /^slide-\\d+\\.jpg$/i.test(name))\n      .sort((a, b) => {\n        const an = Number(a.match(/-(\\d+)\\.jpg$/i)?.[1] ?? 0);\n        const bn = Number(b.match(/-(\\d+)\\.jpg$/i)?.[1] ?? 0);\n        return an - bn;\n      });\n    if (!files.length)\n      throw new Error(\`pdftoppm did not create presentation slide images\${stderr ? \`: \${stderr.trim()}\` : stdout ? \`: \${stdout.trim()}\` : ""}\`);\n    return files.map((name) => {\n      const bytes = fs.readFileSync(path.join(tempRoot, name));\n      assertJpeg(bytes);\n      return bytes;\n    });\n  } finally {\n    fs.rmSync(tempRoot, { recursive: true, force: true });\n  }\n}\n\n`;
exportsSource = replaceBetween(exportsSource, htmlStart, htmlEnd, htmlReplacement, "presentation HTML renderer");
exportsSource = replaceExact(
  exportsSource,
  `    const html = browserPresentationHtml(\n      displayTitle(artifact.name),\n      fs.readFileSync(pdfTarget),\n    );\n    if (\n      !html.startsWith("<!doctype html>") ||\n      !html.includes('id="pdf-data"')\n    )\n`,
  `    const slideImages = await renderPdfSlideJpegs(pdfTarget);\n    const html = browserPresentationHtml(\n      displayTitle(artifact.name),\n      slideImages,\n    );\n    if (\n      !html.startsWith("<!doctype html>") ||\n      !html.includes('id="slide-1"') ||\n      !html.includes("data:image/jpeg;base64,")\n    )\n`,
  "presentation export HTML generation",
);
exportsSource = replaceExact(
  exportsSource,
  `      size: fs.statSync(htmlTarget).size,\n    });\n`,
  `      size: fs.statSync(htmlTarget).size,\n      renderer:"pdf-page-jpeg-parity",\n    });\n`,
  "presentation HTML log",
);
fs.writeFileSync(exportPath, exportsSource);

const qualityPath = "src/server/artifact-quality.ts";
let quality = fs.readFileSync(qualityPath, "utf8");
quality = replaceExact(
  quality,
  `  if (!names.has("index.html") || !names.has("OPEN_ME_FIRST.html"))\n    throw new Error("Website package validation failed: missing entry page");\n`,
  `  if (\n    !names.has("index.html") ||\n    !names.has("MAIN_HOMEPAGE.html") ||\n    !names.has("OPEN_ME_FIRST_HOME_PAGE.html") ||\n    !names.has("OPEN_ME_FIRST.html")\n  )\n    throw new Error("Website package validation failed: missing canonical or labelled homepage entry");\n`,
  "website homepage validation",
);
quality = replaceExact(
  quality,
  `    if (hasPlaceholderText(html))\n      throw new Error(\`Website package validation failed: placeholder content in \${entry.entryName}\`);\n`,
  `    if (hasPlaceholderText(html))\n      throw new Error(\`Website package validation failed: placeholder content in \${entry.entryName}\`);\n    if (\n      entry.entryName !== "MAIN_HOMEPAGE.html" &&\n      !html.includes('href="MAIN_HOMEPAGE.html"')\n    )\n      throw new Error(\`Website package validation failed: \${entry.entryName} does not link to MAIN_HOMEPAGE.html\`);\n`,
  "website home navigation validation",
);
fs.writeFileSync(qualityPath, quality);

const dockerPath = "Dockerfile";
let docker = fs.readFileSync(dockerPath, "utf8");
docker = docker.replaceAll(
  "libreoffice-impress-nogui libreoffice-writer-nogui",
  "libreoffice-impress-nogui libreoffice-writer-nogui poppler-utils",
);
if ((docker.match(/poppler-utils/g) ?? []).length !== 2)
  throw new Error("Dockerfile poppler install count mismatch");
fs.writeFileSync(dockerPath, docker);

const workflowPath = ".github/workflows/verify.yml";
let workflow = fs.readFileSync(workflowPath, "utf8");
workflow = replaceExact(
  workflow,
  "sudo apt-get install -y --no-install-recommends libreoffice-impress-nogui libreoffice-writer-nogui",
  "sudo apt-get install -y --no-install-recommends libreoffice-impress-nogui libreoffice-writer-nogui poppler-utils",
  "verify poppler install",
);
fs.writeFileSync(workflowPath, workflow);

const exportTestPath = "src/server/__tests__/presentation-exports.test.ts";
let exportTest = fs.readFileSync(exportTestPath, "utf8");
exportTest = replaceExact(
  exportTest,
  `  it("rejects invalid PDF bytes before creating a browser presentation", () => {\n    expect(() => browserPresentationHtml("Broken", Buffer.from("not a pdf"))).toThrow(\n      /invalid PDF/i,\n    );\n  });\n`,
  `  it("rejects an empty slide-image set before creating a browser presentation", () => {\n    expect(() => browserPresentationHtml("Broken", [])).toThrow(/no slide images/i);\n  });\n\n  it("creates a standalone browser deck from rendered slide images rather than embedding a PDF viewer", () => {\n    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);\n    const html = browserPresentationHtml("Parity", [jpeg, jpeg]);\n    expect(html).toContain('id="slide-1"');\n    expect(html).toContain('id="slide-2"');\n    expect(html).toContain("data:image/jpeg;base64,");\n    expect(html).toContain("requestFullscreen");\n    expect(html).not.toContain('id="pdf-data"');\n    expect(html).not.toContain("<iframe");\n  });\n`,
  "presentation export unit test",
);
exportTest = replaceExact(
  exportTest,
  `    expect(html).toContain('type="application/octet-stream"');\n    expect(html).toContain('id="pdf-data"');\n    expect(html).toContain("Open PDF");\n    expect(html).toContain("requestFullscreen");\n    expect(html).not.toMatch(/https?:\\/\\//i);\n`,
  `    expect(html).toContain('id="slide-1"');\n    expect(html).toContain("data:image/jpeg;base64,");\n    expect(html).toContain("Exact PPTX/PDF visual parity");\n    expect(html).toContain("requestFullscreen");\n    expect(html).not.toContain('id="pdf-data"');\n    expect(html).not.toContain("<iframe");\n    expect(html).not.toMatch(/https?:\\/\\//i);\n`,
  "presentation export integration assertions",
);
exportTest = replaceExact(
  exportTest,
  `    expect(views[1]!.size).toBeGreaterThan(exports.pdf.size);\n`,
  `    expect(views[1]!.size).toBeGreaterThan(3_000);\n`,
  "presentation HTML size assertion",
);
fs.writeFileSync(exportTestPath, exportTest);

const buildersTestPath = "src/server/__tests__/builders.test.ts";
let buildersTest = fs.readFileSync(buildersTestPath, "utf8");
buildersTest = replaceExact(
  buildersTest,
  `      const zip = new AdmZip(out.path);\n      const imageEntries = zip\n`,
  `      const zip = new AdmZip(out.path);\n      expect(zip.getEntry("MAIN_HOMEPAGE.html")).not.toBeNull();\n      expect(zip.getEntry("OPEN_ME_FIRST_HOME_PAGE.html")).not.toBeNull();\n      const detailsHtml = zip.getEntry("details.html")!.getData().toString("utf8");\n      expect(detailsHtml).toContain('href="MAIN_HOMEPAGE.html"');\n      const imageEntries = zip\n`,
  "website homepage regression",
);
fs.writeFileSync(buildersTestPath, buildersTest);

console.log("Applied visual parity, resilient imagery, homepage clarity, and HTML slide rendering patches.");
