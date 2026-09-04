from pathlib import Path
import re

builders = Path('src/server/builders.ts')
text = builders.read_text()
if 'artifact.build_progress' in Path('src/server/openai-agent.ts').read_text() and 'ArtifactBuildProgress' in text:
    print('builder hardening already applied')
    raise SystemExit(0)

text = text.replace(
'''  type CommonsImageCandidate,\n  type RealImage,\n} from "./real-images.js";''',
'''  type CommonsImageCandidate,\n  type RealImage,\n  type ImageProviderEvent,\n} from "./real-images.js";''',
1)

anchor = 'export interface BuiltFile { name:string; mime:string; path:string; size:number; validationReceipt:ArtifactValidationReceipt; }\n'
assert anchor in text
text = text.replace(anchor, anchor + '''export interface ArtifactBuildProgress {\n  progress: number;\n  stage: "visual-plan" | "image-search" | "image-judge" | "image-download" | "render" | "validate" | "package";\n  message: string;\n  current?: number;\n  total?: number;\n  completed?: number;\n  found?: number;\n}\nexport type ArtifactBuildProgressHandler = (event: ArtifactBuildProgress) => void;\nconst emitBuildProgress = (handler: ArtifactBuildProgressHandler | undefined, event: ArtifactBuildProgress) => handler?.(event);\n\n''', 1)

replacement = r'''async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}

async function collectImages(
  config: Config,
  plan: ArtifactPlan,
  prompt = "",
  progress?: ArtifactBuildProgressHandler,
): Promise<CollectedImages> {
  const requests = plan.sections
    .map((section, sectionIndex) => ({ section, sectionIndex }))
    .filter(
      (item): item is {
        section: ArtifactPlan["sections"][number] & { imageQuery: string };
        sectionIndex: number;
      } => Boolean(item.section.imageQuery),
    );
  const rejectedWithReasons: ImageResolutionReceipt["rejectedWithReasons"] = [];
  const total = requests.length;
  let searchCompleted = 0;
  let fetched = 0;
  let downloadCompleted = 0;

  const providerEvent = (event: ImageProviderEvent) => {
    const seconds = Math.max(1, Math.ceil(event.waitMs / 1000));
    const message = event.type === "rate_limit" || event.type === "cooldown_wait"
      ? `Image provider rate-limited — waiting ${seconds}s · ${searchCompleted}/${total} searches complete · ${fetched} images ready`
      : `Image provider retrying in ${seconds}s · ${searchCompleted}/${total} searches complete`;
    emitBuildProgress(progress, {
      progress: 87,
      stage: "image-search",
      message,
      completed: searchCompleted,
      total,
      found: fetched,
    });
  };

  if (!total) {
    emitBuildProgress(progress, { progress: 88, stage: "image-search", message: "No external photographs required for this artifact", completed: 0, total: 0, found: 0 });
    return { images: new Map(), metrics: { requested: 0, fetched: 0, judged: 0, judgeCalls: 0, rejectedWithReasons, placed: 0 } };
  }

  emitBuildProgress(progress, { progress: 84, stage: "image-search", message: `Finding visuals: 0/${total} searches complete`, completed: 0, total, found: 0 });
  const judgeSections = await mapConcurrent(requests, 3, async ({ section, sectionIndex }, requestIndex) => {
    const query = section.imageQuery;
    emitBuildProgress(progress, {
      progress: 84 + Math.min(3, Math.floor((searchCompleted / Math.max(1, total)) * 4)),
      stage: "image-search",
      message: `Finding visual ${requestIndex + 1} of ${total}: ${section.heading}`,
      current: requestIndex + 1,
      total,
      completed: searchCompleted,
      found: fetched,
    });
    const candidateMap = new Map<string, CommonsImageCandidate>();
    const searchQueries = [query, section.heading, [section.heading, meaningfulWords(section.body)].filter(Boolean).join(" ")].filter(
      (value, index, all) => Boolean(value.trim()) && all.findIndex((candidate) => candidate.toLocaleLowerCase() === value.toLocaleLowerCase()) === index,
    );
    for (const searchQuery of searchQueries) {
      if (candidateMap.size >= 8) break;
      try {
        const result = await searchCommonsCandidates(searchQuery, 8 - candidateMap.size, { onEvent: providerEvent });
        for (const candidate of result.candidates) if (!candidateMap.has(candidate.id)) candidateMap.set(candidate.id, candidate);
        for (const rejected of result.rejected) rejectedWithReasons.push({ sectionIndex, query, candidateId: rejected.candidateId, title: rejected.title, reason: rejected.reason });
      } catch (error) {
        rejectedWithReasons.push({ sectionIndex, query, candidateId: null, title: null, reason: `Candidate search failed for '${searchQuery}': ${error instanceof Error ? error.message : String(error)}` });
      }
      if (candidateMap.size >= 4) break;
    }
    searchCompleted++;
    emitBuildProgress(progress, {
      progress: 84 + Math.min(4, Math.floor((searchCompleted / Math.max(1, total)) * 4)),
      stage: "image-search",
      message: `Finding visuals: ${searchCompleted}/${total} searches complete · ${candidateMap.size} candidates for ${section.heading}`,
      current: requestIndex + 1,
      total,
      completed: searchCompleted,
      found: fetched,
    });
    return { sectionIndex, heading: section.heading, body: section.body, audience: inferAudience(prompt), query, candidates: [...candidateMap.values()].slice(0, 8) } satisfies ImageJudgeSection;
  });

  emitBuildProgress(progress, { progress: 89, stage: "image-judge", message: `Judging relevance for ${total} visual slots`, completed: 0, total, found: fetched });
  const judged = await judgeImageCandidates(config, judgeSections, {
    onProviderEvent: providerEvent,
    onProgress: (message, completed, judgeTotal) => emitBuildProgress(progress, {
      progress: 89 + Math.min(2, Math.floor((completed / Math.max(1, judgeTotal)) * 2)),
      stage: "image-judge",
      message: `${message} · ${fetched} images ready`,
      completed,
      total: judgeTotal,
      found: fetched,
    }),
  });

  const images = new Map<string, RealImage>();
  await mapConcurrent(judgeSections, 3, async (section, sectionPosition) => {
    const decision = judged.decisions.find((item) => item.sectionIndex === section.sectionIndex);
    const chosen = decision?.chosenCandidate
      ? section.candidates.find((candidate) => candidate.id === decision.chosenCandidate)
      : undefined;
    if (!chosen) {
      for (const candidate of section.candidates) rejectedWithReasons.push({
        sectionIndex: section.sectionIndex,
        query: section.query,
        candidateId: candidate.id,
        title: candidate.title,
        reason: decision?.reason ? `Not selected by image judge: ${decision.reason}` : "Not selected by image judge.",
      });
      rejectedWithReasons.push({ sectionIndex: section.sectionIndex, query: section.query, candidateId: null, title: null, reason: decision?.reason || "No candidate met the qualitative relevance bar." });
      downloadCompleted++;
      emitBuildProgress(progress, { progress: 92 + Math.min(2, Math.floor((downloadCompleted / Math.max(1, total)) * 2)), stage: "image-download", message: `Visual ${sectionPosition + 1}/${total} unresolved · ${fetched} images ready`, current: sectionPosition + 1, total, completed: downloadCompleted, found: fetched });
      return;
    }

    emitBuildProgress(progress, { progress: 92, stage: "image-download", message: `Downloading visual ${sectionPosition + 1} of ${total}: ${section.heading}`, current: sectionPosition + 1, total, completed: downloadCompleted, found: fetched });
    const downloadOrder = [chosen, ...section.candidates.filter((candidate) => candidate.id !== chosen.id)];
    const failedIds = new Set<string>();
    let selected: CommonsImageCandidate | undefined;
    for (const candidate of downloadOrder) {
      try {
        const image = await downloadCommonsCandidate(candidate, { onEvent: providerEvent });
        images.set(section.query, image);
        fetched++;
        selected = candidate;
        log("info", candidate.id === chosen.id ? "artifact.image_judged_retrieved" : "artifact.image_fallback_retrieved", {
          query: section.query,
          sectionIndex: section.sectionIndex,
          candidateId: candidate.id,
          title: candidate.title,
          primaryCandidateId: chosen.id,
        });
        break;
      } catch (error) {
        failedIds.add(candidate.id);
        rejectedWithReasons.push({ sectionIndex: section.sectionIndex, query: section.query, candidateId: candidate.id, title: candidate.title, reason: `Candidate download failed: ${error instanceof Error ? error.message : String(error)}` });
        log("warn", "artifact.image_candidate_download_failed", { query: section.query, sectionIndex: section.sectionIndex, candidateId: candidate.id, primaryCandidateId: chosen.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const candidate of section.candidates) {
      if (candidate.id === selected?.id || failedIds.has(candidate.id)) continue;
      rejectedWithReasons.push({ sectionIndex: section.sectionIndex, query: section.query, candidateId: candidate.id, title: candidate.title, reason: selected ? `Not used after successfully retrieving '${selected.title}'.` : "Not selected by image judge." });
    }
    if (!selected) rejectedWithReasons.push({ sectionIndex: section.sectionIndex, query: section.query, candidateId: null, title: null, reason: "All judged image candidates failed download." });
    downloadCompleted++;
    emitBuildProgress(progress, {
      progress: 92 + Math.min(2, Math.floor((downloadCompleted / Math.max(1, total)) * 2)),
      stage: "image-download",
      message: `Images ready: ${fetched}/${total} · processed ${downloadCompleted}/${total}`,
      current: sectionPosition + 1,
      total,
      completed: downloadCompleted,
      found: fetched,
    });
  });

  return { images, metrics: { requested: requests.length, fetched, judged: judgeSections.length, judgeCalls: judged.judgeCalls, rejectedWithReasons, placed: 0 } };
}

const imageDataUri='''
text, count = re.subn(r'async function collectImages\([\s\S]*?\n}\n\nconst imageDataUri=', replacement, text, count=1)
assert count == 1, 'collectImages replacement failed'

text = text.replace('async function pptx(config:Config,plan:ArtifactPlan,prompt="",jobId=""):Promise<BuiltFile>{', 'async function pptx(config:Config,plan:ArtifactPlan,prompt="",jobId="",progress?:ArtifactBuildProgressHandler):Promise<BuiltFile>{', 1)
text = text.replace('''    {...plan,sections:originalContentSections},\n    prompt,\n  );''', '''    {...plan,sections:originalContentSections},\n    prompt,\n    progress,\n  );''', 1)

old_diagram = re.compile(r'    const addNativeDiagram=\(slide:any,section:ArtifactPlan\["sections"\]\[number\],image\?:RealImage\)=>\{[\s\S]*?\n    };\n    const addNativeTable=', re.M)
new_diagram = r'''    const addNativeDiagram=(slide:any,section:ArtifactPlan["sections"][number],image?:RealImage)=>{
      const diagram=section.diagram!,nodes=diagram.nodes.slice(0,8),availableW=image?9.08:11.85;
      const longest=Math.max(0,...nodes.map(node=>node.length));
      const columns=nodes.length<=4&&longest<=28?Math.max(1,nodes.length):longest>52?Math.min(2,nodes.length):Math.min(3,nodes.length);
      const rows=Math.ceil(nodes.length/columns),gapX=.24,gapY=.25,boxW=(availableW-(columns-1)*gapX)/columns;
      const fontSize=longest>62?11.5:longest>38?12.5:13.5;
      const rawHeights=Array.from({length:rows},()=>.82);
      nodes.forEach((node,index)=>{
        const row=Math.floor(index/columns);
        rawHeights[row]=Math.max(rawHeights[row]!,estimatedTextHeight(node,boxW-.28,fontSize,.04,1.12)+.2);
      });
      const availableH=3.65,totalRaw=rawHeights.reduce((sum,value)=>sum+value,0)+(rows-1)*gapY;
      const scale=Math.min(1,availableH/Math.max(.1,totalRaw));
      const rowHeights=rawHeights.map(value=>Math.max(.72,value*scale));
      const rowY:number[]=[];let cursorY=2.0;
      rowHeights.forEach(height=>{rowY.push(cursorY);cursorY+=height+gapY;});
      const boxes=nodes.map((node,index)=>{const row=Math.floor(index/columns),col=index%columns;return{node,row,col,x:.75+col*(boxW+gapX),y:rowY[row]!,w:boxW,h:rowHeights[row]!};});
      addModelText(slide,short(diagram.title,120),{x:.75,y:1.5,w:availableW,fontSize:18,bold:true,color:navy,align:"center",margin:0},{minHeight:.3,maxHeight:.5});
      boxes.forEach((box,index)=>{
        slide.addShape(p.ShapeType.roundRect,{x:box.x,y:box.y,w:box.w,h:box.h,rectRadius:.05,fill:{color:index%2?pale:"F1E5C5"},line:{color:gold,pt:1.2},shadow:{type:"outer",color:"000000",opacity:.08,blur:1,angle:45,distance:.4}});
        addModelText(slide,box.node,{x:box.x+.14,y:box.y+.08,w:box.w-.28,fontSize,bold:true,color:navy,align:"center",valign:"mid",margin:.04,breakLine:false},{minHeight:.28,maxHeight:box.h-.16,lineHeight:1.12});
      });
      for(let index=0;index<boxes.length-1;index++){
        const current=boxes[index]!,next=boxes[index+1]!;
        if(current.row===next.row){
          slide.addShape(p.ShapeType.line,{x:current.x+current.w,y:current.y+current.h/2,w:Math.max(.05,next.x-(current.x+current.w)),h:0,line:{color:blue,pt:1.8,endArrowType:"triangle"}});
        }else{
          const startX=current.x+current.w/2,startY=current.y+current.h,endX=next.x+next.w/2,endY=next.y;
          const midY=startY+Math.max(.08,(endY-startY)/2);
          slide.addShape(p.ShapeType.line,{x:startX,y:startY,w:0,h:Math.max(.05,midY-startY),line:{color:blue,pt:1.6}});
          slide.addShape(p.ShapeType.line,{x:Math.min(startX,endX),y:midY,w:Math.abs(endX-startX),h:0,line:{color:blue,pt:1.6}});
          slide.addShape(p.ShapeType.line,{x:endX,y:midY,w:0,h:Math.max(.05,endY-midY),line:{color:blue,pt:1.6,endArrowType:"triangle"}});
        }
      }
      const captionY=Math.min(6.05,cursorY+.06);
      if(diagram.caption||section.body)addModelText(slide,short(diagram.caption||section.body,320),{x:.9,y:captionY,w:availableW-.3,fontSize:14,color:muted,align:"center",margin:0},{minHeight:.24,maxHeight:.62});
      if(image)addStructuredPhoto(slide,section,image);
    };
    const addNativeTable='''
text, count = old_diagram.subn(new_diagram, text, count=1)
assert count == 1, 'native diagram replacement failed'

text = text.replace('''  const rendered=await renderAttempt(false);''', '''  emitBuildProgress(progress,{progress:95,stage:"render",message:`Rendering presentation · ${contentSections.length} content sections · ${images.size} photographs ready`,completed:images.size,total:collectedImages.metrics.requested,found:images.size});\n  const rendered=await renderAttempt(false);''', 1)
text = text.replace('''  const validationReceipt=await validateBuiltArtifact(\n    "presentation",''', '''  emitBuildProgress(progress,{progress:97,stage:"validate",message:"Checking PPTX package and desktop-render compatibility"});\n  const validationReceipt=await validateBuiltArtifact(\n    "presentation",''', 1)
text = text.replace('''  return{name,mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",path:target,size:rendered.raw.length,validationReceipt};''', '''  emitBuildProgress(progress,{progress:99,stage:"package",message:"Presentation validated and ready for export"});\n  return{name,mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",path:target,size:rendered.raw.length,validationReceipt};''', 1)

text = text.replace('async function docx(config:Config,plan:ArtifactPlan,prompt="",kind:Extract<JobKind,"document"|"analysis"|"research">="document",jobId=""):Promise<BuiltFile>{', 'async function docx(config:Config,plan:ArtifactPlan,prompt="",kind:Extract<JobKind,"document"|"analysis"|"research">="document",jobId="",progress?:ArtifactBuildProgressHandler):Promise<BuiltFile>{', 1)
docx_anchor = '''    {...plan,sections:contentSections},\n    prompt,\n  );'''
pos = text.find(docx_anchor, text.find('async function docx'))
assert pos >= 0
text = text[:pos] + docx_anchor.replace('    prompt,\n  );','    prompt,\n    progress,\n  );') + text[pos+len(docx_anchor):]

text = text.replace('''  jobId="",\n):Promise<BuiltFile>{''', '''  jobId="",\n  progress?:ArtifactBuildProgressHandler,\n):Promise<BuiltFile>{''', 1)
website_start = text.find('async function website(')
collect_anchor = '''    {...plan,sections:contentSections},\n    prompt,\n  );'''
pos = text.find(collect_anchor, website_start)
assert pos >= 0
text = text[:pos] + collect_anchor.replace('    prompt,\n  );','    prompt,\n    progress,\n  );') + text[pos+len(collect_anchor):]
# Insert website render progress after its image collection only.
website_marker = '''  const images=collectedImages.images;\n  const placedImageQueries=new Set<string>();'''
pos = text.find(website_marker, website_start)
assert pos >= 0
text = text[:pos] + website_marker.replace('  const images=collectedImages.images;','  const images=collectedImages.images;\n  emitBuildProgress(progress,{progress:95,stage:"render",message:`Rendering ${pages.length} website pages · ${images.size} photographs ready`,completed:images.size,total:collectedImages.metrics.requested,found:images.size});') + text[pos+len(website_marker):]
website_validate = '''  const validationReceipt=await validateBuiltArtifact(\n    "website",'''
pos = text.find(website_validate, website_start)
assert pos >= 0
text = text[:pos] + '''  emitBuildProgress(progress,{progress:98,stage:"validate",message:`Checking website package, links, and ${uniqueImageAssets.size} image assets`});\n''' + text[pos:]
website_return = '''  return{\n    name,\n    mime:"application/zip",'''
pos = text.find(website_return, website_start)
assert pos >= 0
text = text[:pos] + '''  emitBuildProgress(progress,{progress:99,stage:"package",message:`Website packaged · ${pages.length} pages · ${uniqueImageAssets.size} image files`});\n''' + text[pos:]

text = text.replace('''  jobId = "",\n): Promise<BuiltFile> {''', '''  jobId = "",\n  progress?: ArtifactBuildProgressHandler,\n): Promise<BuiltFile> {''', 1)
text = text.replace('''  log("info", "artifact.visual_plan", { kind, ...visualized.receipt });\n  const compiledPlan''', '''  log("info", "artifact.visual_plan", { kind, ...visualized.receipt });\n  emitBuildProgress(progress,{progress:83,stage:"visual-plan",message:`Planning visuals: ${visualized.receipt.plannedSlots} image slots${visualized.receipt.suppressedExplicitQueries ? ` · ${visualized.receipt.suppressedExplicitQueries} excess model slots suppressed` : ""}`,total:visualized.receipt.plannedSlots,completed:0,found:0});\n  const compiledPlan''', 1)
text = text.replace('if (kind === "presentation") return pptx(config, compiledPlan, prompt, jobId);', 'if (kind === "presentation") return pptx(config, compiledPlan, prompt, jobId, progress);', 1)
text = text.replace('return docx(config, compiledPlan, prompt, kind, jobId);', 'return docx(config, compiledPlan, prompt, kind, jobId, progress);', 1)
text = text.replace('if (kind === "website") return website(config, compiledPlan, prompt, jobId);', 'if (kind === "website") return website(config, compiledPlan, prompt, jobId, progress);', 1)
builders.write_text(text)

agent = Path('src/server/openai-agent.ts')
text = agent.read_text()
old = '''            this.db.updateJob(jobId, {\n              status: "building",\n              progress: Math.min(96, 90 + Math.min(buildAttempt, 6)),\n              error: null,\n              message:\n                buildAttempt === 0\n                  ? "Building and validating artifact"\n                  : `Rebuilding artifact after validation repair (attempt ${buildAttempt + 1})`,\n            });'''
new = '''            this.db.updateJob(jobId, {\n              status: "building",\n              progress: 82,\n              error: null,\n              message:\n                buildAttempt === 0\n                  ? "Preparing deterministic artifact build"\n                  : `Rebuilding artifact after asset failure (attempt ${buildAttempt + 1})`,\n            });'''
assert old in text, 'build progress anchor changed'
text = text.replace(old, new, 1)
old_call = '''                job.prompt,\n                jobId,\n              );'''
new_call = '''                job.prompt,\n                jobId,\n                (event) => {\n                  const currentProgress = this.db.getJob(jobId)?.progress ?? 82;\n                  this.db.updateJob(jobId, {\n                    status: "building",\n                    progress: Math.max(currentProgress, Math.min(99, event.progress)),\n                    error: null,\n                    message: event.message,\n                  });\n                  log("info", "artifact.build_progress", { jobId, kind: job.kind, ...event });\n                },\n              );'''
build_pos = text.find('const file = await buildArtifact(')
pos = text.find(old_call, build_pos)
assert pos >= 0, 'buildArtifact call anchor changed'
text = text[:pos] + new_call + text[pos+len(old_call):]
agent.write_text(text)

real = Path('src/server/real-images.ts')
text = real.read_text()
text = text.replace('''          Math.min(15_000, 3_000 * Math.max(1, commons429Streak)),''', '''          Math.min(15_000, (process.env.NODE_ENV === "test" ? 25 : 3_000) * Math.max(1, commons429Streak)),''', 1)
real.write_text(text)

Path('src/server/__tests__/visual-layout-hardening.test.ts').write_text(r'''import { describe, expect, it } from "vitest";
import { chartRenderMode, chartSvg, diagramRenderMode, diagramSvg } from "../visuals.js";
import { planArtifactVisuals } from "../artifact-visual-plan.js";
import type { ArtifactPlan } from "../../shared/contracts.js";

describe("content-responsive visual builders", () => {
  it("splits a giant chart outlier instead of flattening the useful values", () => {
    const chart = {
      title: "Cifras esenciales del patrimonio español",
      type: "bar" as const,
      labels: ["Bienes Patrimonio", "Bienes culturales", "Bienes naturales", "Bienes mixtos", "Ciudades Patrimonio", "Bienes de Interés Cultural"],
      series: [{ name: "Cantidad", values: [50, 44, 4, 2, 15, 17000] }],
      sourceNote: "UNESCO World Heritage Convention y Spain.info.",
    };
    expect(chartRenderMode(chart)).toBe("outlier-split");
    const svg = chartSvg(chart);
    expect(svg).toContain("shown separately because its scale");
    expect(svg).toContain("17000");
    expect(svg).toContain("Bienes de Interés");
  });

  it("reflows six long diagram nodes and wraps their text", () => {
    const nodes = ["Prehistoria", "Roma", "Edad Media y al-Ándalus", "Edad Moderna", "Siglos XIX y XX", "España democrática contemporánea"];
    expect(diagramRenderMode(nodes)).toBe("grid");
    const svg = diagramSvg({ title: "Historia", nodes, caption: "Recorrido" });
    expect(svg.match(/<rect x=/g)?.length).toBeGreaterThanOrEqual(6);
    expect(svg).toContain("<tspan");
    expect(svg).toContain("España democrática");
  });
});

describe("visual acquisition budget", () => {
  const planWithImages = (count: number): ArtifactPlan => ({
    title: "Raíces de España",
    subtitle: "",
    requirements: [{ id: "R1", text: "Create an image-rich website", mandatory: true }],
    sections: Array.from({ length: count }, (_, index) => ({
      heading: `Historic place ${index + 1} in Spain`,
      body: `Culture, architecture, history and regional traditions in Spain number ${index + 1}.`,
      bullets: [], speakerNotes: "", requirementIds: ["R1"], layout: "gallery" as const,
      imageQuery: `Spain historic place photograph ${index + 1}`,
    })),
    pages: [
      { slug: "index", title: "Inicio", description: "", sectionHeadings: ["Historic place 1 in Spain"] },
      { slug: "history", title: "Historia", description: "", sectionHeadings: ["Historic place 2 in Spain"] },
      { slug: "culture", title: "Cultura", description: "", sectionHeadings: ["Historic place 3 in Spain"] },
    ],
    sources: [],
  });

  it("does not let model-authored imageQuery fields fan out without bound", () => {
    const result = planArtifactVisuals("website", planWithImages(20), "Create a robust image-rich website with many relevant photographs");
    expect(result.receipt.plannedSlots).toBeLessThanOrEqual(12);
    expect(result.receipt.suppressedExplicitQueries).toBe(8);
  });

  it("honors an exact user-requested photograph count", () => {
    const result = planArtifactVisuals("website", planWithImages(18), "Create a website with exactly 15 photographs");
    expect(result.receipt.plannedSlots).toBe(15);
  });
});
''')

Path('src/server/__tests__/builder-progress-contract.test.ts').write_text(r'''import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("artifact build progress contract", () => {
  it("bridges deterministic builder stages into live job messages", () => {
    const agent = fs.readFileSync(path.join(process.cwd(), "src/server/openai-agent.ts"), "utf8");
    const builders = fs.readFileSync(path.join(process.cwd(), "src/server/builders.ts"), "utf8");
    expect(agent).toContain("artifact.build_progress");
    expect(agent).toContain("event.message");
    expect(builders).toContain("Finding visual ${requestIndex + 1} of ${total}");
    expect(builders).toContain("Image provider rate-limited — waiting");
    expect(builders).toContain("Rendering ${pages.length} website pages");
    expect(builders).toContain("Checking website package, links");
  });
});
''')

print('builder hardening patch applied')
