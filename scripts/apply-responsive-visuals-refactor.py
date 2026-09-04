from pathlib import Path
import re

builders = Path("src/server/builders.ts")
text = builders.read_text()

old = '''import {
  downloadCommonsCandidate,
  searchCommonsCandidates,
  type CommonsImageCandidate,
  type RealImage,
} from "./real-images.js";'''
new = '''import {
  downloadCommonsCandidate,
  imageProviderCooldownRemainingMs,
  searchCommonsCandidates,
  type CommonsImageCandidate,
  type RealImage,
} from "./real-images.js";'''
assert old in text, "real-images import anchor changed"
text = text.replace(old, new, 1)

old = 'export interface BuiltFile { name:string; mime:string; path:string; size:number; validationReceipt:ArtifactValidationReceipt; }\n'
new = '''export interface BuiltFile { name:string; mime:string; path:string; size:number; validationReceipt:ArtifactValidationReceipt; }
export interface ArtifactBuildProgress {
  progress: number;
  message: string;
  stage: "visual-plan" | "image-search" | "image-judge" | "image-download" | "render" | "validate" | "package";
  completed?: number;
  total?: number;
}
export type ArtifactBuildProgressCallback = (update: ArtifactBuildProgress) => void;
'''
assert old in text, "BuiltFile anchor changed"
text = text.replace(old, new, 1)

pattern = re.compile(r'''async function collectImages\(
  config: Config,
  plan: ArtifactPlan,
  prompt = "",
\): Promise<CollectedImages> \{[\s\S]*?
\}

const imageDataUri''')
replacement = '''async function collectImages(
  config: Config,
  plan: ArtifactPlan,
  prompt = "",
  onProgress?: ArtifactBuildProgressCallback,
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
  const judgeSections: ImageJudgeSection[] = [];
  const total = requests.length;
  const emit = (
    progress: number,
    message: string,
    stage: ArtifactBuildProgress["stage"],
    completed?: number,
  ) => onProgress?.({ progress, message, stage, completed, total });

  if (!total) {
    emit(92, "No external photographs needed for this artifact", "image-search", 0);
    return {
      images: new Map(),
      metrics: {
        requested: 0,
        fetched: 0,
        judged: 0,
        judgeCalls: 0,
        rejectedWithReasons,
        placed: 0,
      },
    };
  }

  for (const [requestIndex, { section, sectionIndex }] of requests.entries()) {
    const query = section.imageQuery;
    emit(
      84 + Math.floor((requestIndex / Math.max(1, total)) * 4),
      `Finding visual ${requestIndex + 1} of ${total}: ${section.heading}`,
      "image-search",
      requestIndex,
    );
    const candidateMap = new Map<string, CommonsImageCandidate>();
    const searchQueries = [query, section.heading].filter(
      (value, index, all) =>
        Boolean(value.trim()) &&
        all.findIndex(
          (candidate) => candidate.toLocaleLowerCase() === value.toLocaleLowerCase(),
        ) === index,
    );

    for (const searchQuery of searchQueries) {
      const cooldown = imageProviderCooldownRemainingMs();
      if (cooldown > 0) {
        const detail = `Image provider rate-limited; ${Math.ceil(cooldown / 1000)}s cooldown active. Continuing with visuals already found.`;
        emit(
          84 + Math.floor((requestIndex / Math.max(1, total)) * 4),
          detail,
          "image-search",
          requestIndex,
        );
        rejectedWithReasons.push({
          sectionIndex,
          query,
          candidateId: null,
          title: null,
          reason: detail,
        });
        break;
      }
      try {
        const result = await searchCommonsCandidates(searchQuery, 8 - candidateMap.size);
        for (const candidate of result.candidates)
          if (!candidateMap.has(candidate.id)) candidateMap.set(candidate.id, candidate);
        for (const rejected of result.rejected)
          rejectedWithReasons.push({
            sectionIndex,
            query,
            candidateId: rejected.candidateId,
            title: rejected.title,
            reason: rejected.reason,
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectedWithReasons.push({
          sectionIndex,
          query,
          candidateId: null,
          title: null,
          reason: `Candidate search failed for '${searchQuery}': ${message}`,
        });
        log("warn", "artifact.image_search_failed", {
          sectionIndex,
          query,
          searchQuery,
          error: message,
        });
        if (/429|cooldown|rate.?limit/i.test(message)) {
          emit(
            84 + Math.floor((requestIndex / Math.max(1, total)) * 4),
            `Image provider throttled while finding visual ${requestIndex + 1} of ${total}; continuing without blocking the artifact`,
            "image-search",
            requestIndex,
          );
          break;
        }
      }
      if (candidateMap.size >= 4) break;
    }

    judgeSections.push({
      sectionIndex,
      heading: section.heading,
      body: section.body,
      audience: inferAudience(prompt),
      query,
      candidates: [...candidateMap.values()].slice(0, 8),
    });
  }

  emit(88, `Reviewing candidate images for ${total} planned visual slots`, "image-judge", 0);
  const judged = await judgeImageCandidates(
    config,
    judgeSections,
    (message) => emit(89, message, "image-judge"),
  );
  const images = new Map<string, RealImage>();
  let fetched = 0;

  for (const [downloadIndex, section] of judgeSections.entries()) {
    emit(
      90 + Math.floor((downloadIndex / Math.max(1, total)) * 3),
      `Loading visual ${downloadIndex + 1} of ${total}: ${section.heading}`,
      "image-download",
      downloadIndex,
    );
    const decision = judged.decisions.find((item) => item.sectionIndex === section.sectionIndex);
    const chosen = decision?.chosenCandidate
      ? section.candidates.find((candidate) => candidate.id === decision.chosenCandidate)
      : undefined;

    if (!chosen) {
      for (const candidate of section.candidates)
        rejectedWithReasons.push({
          sectionIndex: section.sectionIndex,
          query: section.query,
          candidateId: candidate.id,
          title: candidate.title,
          reason: decision?.reason
            ? `Not selected by image judge: ${decision.reason}`
            : "Not selected by image judge.",
        });
      rejectedWithReasons.push({
        sectionIndex: section.sectionIndex,
        query: section.query,
        candidateId: null,
        title: null,
        reason: decision?.reason || "No candidate met the qualitative relevance bar.",
      });
      continue;
    }

    const downloadOrder = [chosen, ...section.candidates.filter((candidate) => candidate.id !== chosen.id)];
    const failedIds = new Set<string>();
    let selected: CommonsImageCandidate | undefined;
    for (const candidate of downloadOrder) {
      if (imageProviderCooldownRemainingMs() > 0) break;
      try {
        const image = await downloadCommonsCandidate(candidate);
        images.set(section.query, image);
        fetched++;
        selected = candidate;
        log(
          "info",
          candidate.id === chosen.id
            ? "artifact.image_judged_retrieved"
            : "artifact.image_fallback_retrieved",
          {
            query: section.query,
            sectionIndex: section.sectionIndex,
            candidateId: candidate.id,
            title: candidate.title,
            primaryCandidateId: chosen.id,
          },
        );
        break;
      } catch (error) {
        failedIds.add(candidate.id);
        const message = error instanceof Error ? error.message : String(error);
        rejectedWithReasons.push({
          sectionIndex: section.sectionIndex,
          query: section.query,
          candidateId: candidate.id,
          title: candidate.title,
          reason: `Candidate download failed: ${message}`,
        });
        log("warn", "artifact.image_candidate_download_failed", {
          query: section.query,
          sectionIndex: section.sectionIndex,
          candidateId: candidate.id,
          primaryCandidateId: chosen.id,
          error: message,
        });
        if (/429|cooldown|rate.?limit/i.test(message)) {
          emit(
            90 + Math.floor((downloadIndex / Math.max(1, total)) * 3),
            `Image provider throttled during visual ${downloadIndex + 1} of ${total}; keeping ${fetched} retrieved visual${fetched === 1 ? "" : "s"} and continuing`,
            "image-download",
            downloadIndex,
          );
          break;
        }
      }
    }

    for (const candidate of section.candidates) {
      if (candidate.id === selected?.id || failedIds.has(candidate.id)) continue;
      rejectedWithReasons.push({
        sectionIndex: section.sectionIndex,
        query: section.query,
        candidateId: candidate.id,
        title: candidate.title,
        reason: selected
          ? `Not used after successfully retrieving '${selected.title}'.`
          : "Not selected by image judge.",
      });
    }
    if (!selected)
      rejectedWithReasons.push({
        sectionIndex: section.sectionIndex,
        query: section.query,
        candidateId: null,
        title: null,
        reason: "No judged image candidate could be retrieved.",
      });
  }

  emit(
    93,
    `Visual acquisition complete: ${fetched} of ${total} planned visuals retrieved`,
    "image-download",
    total,
  );
  return {
    images,
    metrics: {
      requested: requests.length,
      fetched,
      judged: judgeSections.length,
      judgeCalls: judged.judgeCalls,
      rejectedWithReasons,
      placed: 0,
    },
  };
}

const imageDataUri'''
text, count = pattern.subn(replacement, text, count=1)
assert count == 1, "collectImages block changed"

text = text.replace(
    'async function pptx(config:Config,plan:ArtifactPlan,prompt="",jobId=""):Promise<BuiltFile>{',
    'async function pptx(config:Config,plan:ArtifactPlan,prompt="",jobId="",onProgress?:ArtifactBuildProgressCallback):Promise<BuiltFile>{',
    1,
)
text = text.replace(
    '''  const collectedImages=await collectImages(
    config,
    {...plan,sections:originalContentSections},
    prompt,
  );''',
    '''  const collectedImages=await collectImages(
    config,
    {...plan,sections:originalContentSections},
    prompt,
    onProgress,
  );''',
    1,
)

pattern = re.compile(r'''    const addNativeDiagram=\(slide:any,section:ArtifactPlan\["sections"\]\[number\],image\?:RealImage\)=>\{[\s\S]*?
    \};
    const addNativeTable=''')
replacement = '''    const addNativeDiagram=async(slide:any,section:ArtifactPlan["sections"][number],image?:RealImage)=>{
      const diagram=section.diagram!,png=await diagramPng(diagram),visualW=image?9.08:11.85;
      slide.addImage({
        data:`data:image/png;base64,${png.toString("base64")}`,
        x:.75,
        y:1.48,
        w:visualW,
        h:4.95,
        altText:diagram.title,
      });
      if(image)addStructuredPhoto(slide,section,image);
    };
    const addNativeTable='''
text, count = pattern.subn(replacement, text, count=1)
assert count == 1, "addNativeDiagram block changed"
assert 'else if(section.diagram)addNativeDiagram(slide,section,image);' in text
text = text.replace(
    'else if(section.diagram)addNativeDiagram(slide,section,image);',
    'else if(section.diagram)await addNativeDiagram(slide,section,image);',
    1,
)

assert '  const rendered=await renderAttempt(false);' in text
text = text.replace(
    '  const rendered=await renderAttempt(false);',
    '  onProgress?.({progress:94,message:"Rendering PowerPoint slides",stage:"render"});\n  const rendered=await renderAttempt(false);',
    1,
)
text = text.replace(
    '  const validationReceipt=await validateBuiltArtifact(\n    "presentation",',
    '  onProgress?.({progress:97,message:"Checking PowerPoint package and render integrity",stage:"validate"});\n  const validationReceipt=await validateBuiltArtifact(\n    "presentation",',
    1,
)

text = text.replace(
    'async function docx(config:Config,plan:ArtifactPlan,prompt="",kind:Extract<JobKind,"document"|"analysis"|"research">="document",jobId=""):Promise<BuiltFile>{',
    'async function docx(config:Config,plan:ArtifactPlan,prompt="",kind:Extract<JobKind,"document"|"analysis"|"research">="document",jobId="",onProgress?:ArtifactBuildProgressCallback):Promise<BuiltFile>{',
    1,
)
text = text.replace(
    '''  const collectedImages=await collectImages(
    config,
    {...plan,sections:contentSections},
    prompt,
  );''',
    '''  const collectedImages=await collectImages(
    config,
    {...plan,sections:contentSections},
    prompt,
    onProgress,
  );''',
    1,
)
text = text.replace(
    '  const buf=await Packer.toBuffer(d); if(buf.length<3000)throw new Error("DOCX validation failed: output too small");',
    '  onProgress?.({progress:94,message:"Rendering document pages",stage:"render"});\n  const buf=await Packer.toBuffer(d); if(buf.length<3000)throw new Error("DOCX validation failed: output too small");',
    1,
)
text = text.replace(
    '  const validationReceipt=await validateBuiltArtifact(\n    kind,',
    '  onProgress?.({progress:97,message:"Checking document package and render integrity",stage:"validate"});\n  const validationReceipt=await validateBuiltArtifact(\n    kind,',
    1,
)

text = text.replace(
    '''async function website(
  config:Config,
  plan:ArtifactPlan,
  prompt="",
  jobId="",
):Promise<BuiltFile>{''',
    '''async function website(
  config:Config,
  plan:ArtifactPlan,
  prompt="",
  jobId="",
  onProgress?:ArtifactBuildProgressCallback,
):Promise<BuiltFile>{''',
    1,
)
old = '''  const collectedImages=await collectImages(
    config,
    {...plan,sections:contentSections},
    prompt,
  );'''
assert old in text, "website collectImages anchor changed"
text = text.replace(
    old,
    '''  const collectedImages=await collectImages(
    config,
    {...plan,sections:contentSections},
    prompt,
    onProgress,
  );''',
    1,
)
text = text.replace(
    '  const stream=new PassThrough(),chunks:Buffer[]=[];',
    '  onProgress?.({progress:94,message:`Rendering ${pages.length} website pages and bundling ${uniqueImageAssets.size} image file${uniqueImageAssets.size===1?"":"s"}`,stage:"render"});\n  const stream=new PassThrough(),chunks:Buffer[]=[];',
    1,
)
text = text.replace(
    '  const validationReceipt=await validateBuiltArtifact(\n    "website",',
    '  onProgress?.({progress:97,message:"Checking website links, package structure, and bundled assets",stage:"validate"});\n  const validationReceipt=await validateBuiltArtifact(\n    "website",',
    1,
)

text = text.replace(
    '''export async function buildArtifact(
  config: Config,
  kind: JobKind,
  plan: ArtifactPlan,
  prompt = "",
  jobId = "",
): Promise<BuiltFile> {''',
    '''export async function buildArtifact(
  config: Config,
  kind: JobKind,
  plan: ArtifactPlan,
  prompt = "",
  jobId = "",
  onProgress?: ArtifactBuildProgressCallback,
): Promise<BuiltFile> {''',
    1,
)
text = text.replace(
    '  log("info", "artifact.visual_plan", { kind, ...visualized.receipt });\n  const compiledPlan = compileArtifactPlan(kind, visualized.plan).plan;',
    '''  log("info", "artifact.visual_plan", { kind, ...visualized.receipt });
  onProgress?.({
    progress: 83,
    message: `Planning visual coverage: ${visualized.receipt.plannedSlots} visual slot${visualized.receipt.plannedSlots===1?"":"s"}`,
    stage: "visual-plan",
    completed: 0,
    total: visualized.receipt.plannedSlots,
  });
  const compiledPlan = compileArtifactPlan(kind, visualized.plan).plan;''',
    1,
)
text = text.replace(
    '  if (kind === "presentation") return pptx(config, compiledPlan, prompt, jobId);',
    '  if (kind === "presentation") return pptx(config, compiledPlan, prompt, jobId, onProgress);',
    1,
)
text = text.replace(
    '    return docx(config, compiledPlan, prompt, kind, jobId);',
    '    return docx(config, compiledPlan, prompt, kind, jobId, onProgress);',
    1,
)
text = text.replace(
    '  if (kind === "website") return website(config, compiledPlan, prompt, jobId);',
    '  if (kind === "website") return website(config, compiledPlan, prompt, jobId, onProgress);',
    1,
)

builders.write_text(text)

agent = Path("src/server/openai-agent.ts")
text = agent.read_text()
old = '''            this.db.updateJob(jobId, {
              status: "building",
              progress: Math.min(96, 90 + Math.min(buildAttempt, 6)),
              error: null,
              message:
                buildAttempt === 0
                  ? "Building and validating artifact"
                  : `Rebuilding artifact after validation repair (attempt ${buildAttempt + 1})`,
            });'''
new = '''            this.db.updateJob(jobId, {
              status: "building",
              progress: buildAttempt === 0 ? 82 : Math.min(96, 90 + Math.min(buildAttempt, 6)),
              error: null,
              message:
                buildAttempt === 0
                  ? "Preparing artifact build"
                  : `Rebuilding artifact after validation repair (attempt ${buildAttempt + 1})`,
            });'''
assert old in text, "build progress anchor changed"
text = text.replace(old, new, 1)

old = '''              const file = await buildArtifact(
                { ...this.config, artifactDir: buildWorkspace },
                job.kind,
                plan,
                job.prompt,
                jobId,
              );'''
new = '''              const file = await buildArtifact(
                { ...this.config, artifactDir: buildWorkspace },
                job.kind,
                plan,
                job.prompt,
                jobId,
                (update) => {
                  this.db.updateJob(jobId, {
                    status: "building",
                    progress: update.progress,
                    message: update.message,
                    error: null,
                  });
                  log("info", "artifact.progress", {
                    jobId,
                    kind: job.kind,
                    ...update,
                  });
                },
              );'''
assert old in text, "buildArtifact call anchor changed"
text = text.replace(old, new, 1)
agent.write_text(text)
