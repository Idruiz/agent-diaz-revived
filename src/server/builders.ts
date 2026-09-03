import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import PptxGenModule from "pptxgenjs";
import { Document, Packer, Paragraph, TextRun, Footer, Header, PageNumber, AlignmentType, Table, TableRow, TableCell, WidthType, ImageRun, ShadingType, BorderStyle, VerticalAlign, TableLayoutType, LevelFormat } from "docx";
import archiver from "archiver";
import type { ArtifactPlan, JobKind } from "../shared/contracts.js";
import type { Config } from "./config.js";
import { atomicWrite, safeJoin } from "./files.js";
import { chartPng, chartSvg, diagramPng, diagramSvg } from "./visuals.js";
import {
  downloadCommonsCandidate,
  searchCommonsCandidates,
  type CommonsImageCandidate,
  type RealImage,
} from "./real-images.js";
import {
  judgeImageCandidates,
  type ImageJudgeSection,
} from "./image-judge.js";
import { reconcilePresentationPlan } from "./reconcile.js";
import { log } from "./log.js";
import {
  ArtifactPipelineError,
  validateBuiltArtifact,
  type ArtifactValidationReceipt,
} from "./artifact-quality.js";

const PptxGenJS=((PptxGenModule as any).default??PptxGenModule) as typeof PptxGenModule;

export interface BuiltFile { name:string; mime:string; path:string; size:number; validationReceipt:ArtifactValidationReceipt; }
const slug=(s:string)=>s.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,80)||"artifact";
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export interface ImageResolutionReceipt {
  requested: number;
  fetched: number;
  judged: number;
  judgeCalls: number;
  rejectedWithReasons: Array<{
    sectionIndex: number;
    query: string;
    candidateId: string | null;
    title: string | null;
    reason: string;
  }>;
  placed: number;
}

export interface PresentationBuildReceipt {
  placedAssets: number;
  activityTemplates: string[];
  reconciliations: Array<{
    sectionIndex: number;
    heading: string;
    reason: string;
    movedToSpeakerNotes: string[];
  }>;
  titleCounts: {
    contentSlides: number;
    licensedVisuals: number;
  };
}

export interface DocumentBuildReceipt {
  activitiesRendered: number;
  activityTypes: string[];
  truncations: Array<{
    section: string;
    field: string;
    originalCount: number;
    renderedCount: number;
  }>;
}

interface CollectedImages {
  images: Map<string, RealImage>;
  metrics: ImageResolutionReceipt;
}

const meaningfulWords = (value: string) =>
  value
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 7)
    .join(" ");

const inferAudience = (prompt: string) => {
  const grade = prompt.match(/\bgrade\s*(\d{1,2})\b/i);
  if (grade) return `Grade ${grade[1]} classroom`;
  if (/\b(?:teach|teaching|lesson|students?|classroom|practice)\b/i.test(prompt))
    return "school classroom audience";
  return "general audience";
};

async function collectImages(
  config: Config,
  plan: ArtifactPlan,
  prompt = "",
  limit = 10,
): Promise<CollectedImages> {
  const requests = plan.sections
    .map((section, sectionIndex) => ({ section, sectionIndex }))
    .filter(
      (item): item is {
        section: ArtifactPlan["sections"][number] & { imageQuery: string };
        sectionIndex: number;
      } => Boolean(item.section.imageQuery),
    )
    .slice(0, limit);
  const rejectedWithReasons: ImageResolutionReceipt["rejectedWithReasons"] = [];
  const judgeSections: ImageJudgeSection[] = [];

  for (const { section, sectionIndex } of requests) {
    const query = section.imageQuery;
    const candidateMap = new Map<string, CommonsImageCandidate>();
    const searchQueries = [
      query,
      section.heading,
      [section.heading, meaningfulWords(section.body)]
        .filter(Boolean)
        .join(" "),
    ].filter(
      (value, index, all) =>
        Boolean(value.trim()) &&
        all.findIndex(
          (candidate) =>
            candidate.toLocaleLowerCase() === value.toLocaleLowerCase(),
        ) === index,
    );

    for (const searchQuery of searchQueries) {
      if (candidateMap.size >= 8) break;
      try {
        const result = await searchCommonsCandidates(
          searchQuery,
          8 - candidateMap.size,
        );
        for (const candidate of result.candidates)
          if (!candidateMap.has(candidate.id))
            candidateMap.set(candidate.id, candidate);
        for (const rejected of result.rejected)
          rejectedWithReasons.push({
            sectionIndex,
            query,
            candidateId: rejected.candidateId,
            title: rejected.title,
            reason: rejected.reason,
          });
      } catch (error) {
        rejectedWithReasons.push({
          sectionIndex,
          query,
          candidateId: null,
          title: null,
          reason: `Candidate search failed for '${searchQuery}': ${error instanceof Error ? error.message : String(error)}`,
        });
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

  const judged = await judgeImageCandidates(config, judgeSections);
  const images = new Map<string, RealImage>();
  let fetched = 0;

  for (const section of judgeSections) {
    const decision = judged.decisions.find(
      (item) => item.sectionIndex === section.sectionIndex,
    );
    const chosen = decision?.chosenCandidate
      ? section.candidates.find(
          (candidate) => candidate.id === decision.chosenCandidate,
        )
      : undefined;

    for (const candidate of section.candidates) {
      if (chosen?.id === candidate.id) continue;
      rejectedWithReasons.push({
        sectionIndex: section.sectionIndex,
        query: section.query,
        candidateId: candidate.id,
        title: candidate.title,
        reason: decision?.reason
          ? `Not selected by image judge: ${decision.reason}`
          : "Not selected by image judge.",
      });
    }

    if (!chosen) {
      rejectedWithReasons.push({
        sectionIndex: section.sectionIndex,
        query: section.query,
        candidateId: null,
        title: null,
        reason:
          decision?.reason ||
          "No candidate met the qualitative relevance bar.",
      });
      continue;
    }

    try {
      const image = await downloadCommonsCandidate(chosen);
      images.set(section.query, image);
      fetched++;
      log("info", "artifact.image_judged_retrieved", {
        query: section.query,
        sectionIndex: section.sectionIndex,
        candidateId: chosen.id,
        title: chosen.title,
      });
    } catch (error) {
      rejectedWithReasons.push({
        sectionIndex: section.sectionIndex,
        query: section.query,
        candidateId: chosen.id,
        title: chosen.title,
        reason: `Chosen candidate download failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      log("warn", "artifact.image_chosen_download_failed", {
        query: section.query,
        sectionIndex: section.sectionIndex,
        candidateId: chosen.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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

const imageDataUri=(image:RealImage)=>`data:${image.mime};base64,${image.bytes.toString("base64")}`;
const isSourcesHeading=(heading:string)=>/^(sources|references|bibliography|works cited)$/i.test(heading.trim());
const short=(value:string,max:number)=>value.length<=max?value:`${value.slice(0,Math.max(1,max-1)).trimEnd()}…`;

function noteParagraphs(
  notes: string | undefined,
  sources: string[],
): string[] {
  const paragraphs = (notes ?? "")
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (sources.length) {
    paragraphs.push("[Sources]");
    paragraphs.push(...sources.map((source) => `- ${source}`));
  }
  return paragraphs;
}

function addNotesParagraphs(slide: any, paragraphs: string[]): void {
  const clean = paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean);
  if (clean.length) slide.addNotes(clean.join("\r\n\r\n"));
}

async function pptx(config:Config,plan:ArtifactPlan,prompt="",jobId=""):Promise<BuiltFile>{
  const originalContentSections=plan.sections.filter(section=>!isSourcesHeading(section.heading));
  const collectedImages=await collectImages(
    config,
    {...plan,sections:originalContentSections},
    prompt,
    10,
  );
  const images=collectedImages.images;
  const reconciled=reconcilePresentationPlan(
    {...plan,sections:originalContentSections},
    new Set(images.keys()),
  );
  const contentSections=reconciled.plan.sections;
  const placedImageQueries=new Set<string>();
  const usedActivityTemplates=new Set<string>();
  const p=new PptxGenJS(); p.layout="LAYOUT_WIDE"; p.author="Agent Díaz"; p.subject=plan.title; p.title=plan.title;
  p.theme={headFontFace:"Aptos Display",bodyFontFace:"Aptos"};
  const bg="F7F3EA",ink="17202A",gold="C99A2E",navy="17324D",blue="2F739C",muted="5A6772",white="FFFFFF",pale="E7EEF2";
  const sourceChunks=plan.sources.length?Array.from({length:Math.ceil(plan.sources.length/8)},(_,index)=>plan.sources.slice(index*8,index*8+8)):[];
  const totalSlides=1+contentSections.length+sourceChunks.length;
  const addFooter=(slide:any,index:number)=>{
    slide.addShape(p.ShapeType.line,{x:.72,y:7.02,w:11.9,h:0,line:{color:"D5CEC0",pt:.6}});
    slide.addText("AGENT DÍAZ",{x:.75,y:7.09,w:1.6,h:.18,fontSize:8,bold:true,charSpacing:1.4,color:muted,margin:0});
    slide.addText(String(index).padStart(2,"0"),{x:11.95,y:7.06,w:.62,h:.22,fontSize:9,bold:true,color:muted,align:"right",margin:0});
  };
  const addHeading=(slide:any,heading:string,kicker?:string)=>{
    if(kicker)slide.addText(kicker.toUpperCase(),{x:.72,y:.34,w:2.2,h:.22,fontSize:9,bold:true,charSpacing:1.5,color:gold,margin:0});
    slide.addText(short(heading,92),{x:.72,y:.62,w:11.8,h:.72,fontSize:28,bold:true,color:navy,margin:0,breakLine:false,fit:"shrink"});
  };
  const addNarrative=(slide:any,section:ArtifactPlan["sections"][number],box:{x:number;y:number;w:number;h:number},dark=false)=>{
    const color=dark?white:ink,secondary=dark?"E8EEF3":muted;
    if(section.body)slide.addText(short(section.body,460),{x:box.x,y:box.y,w:box.w,h:Math.min(1.45,box.h*.35),fontSize:section.bullets.length?18:24,bold:!section.bullets.length,color,margin:0,breakLine:false,fit:"shrink",valign:"mid"});
    if(section.bullets.length)slide.addText(section.bullets.slice(0,5).map((text,index)=>({text:short(text,180),options:{bullet:{indent:18},breakLine:index<section.bullets.slice(0,5).length-1}})),{x:box.x,y:box.y+1.42,w:box.w,h:Math.max(1,box.h-1.42),fontSize:17,color:secondary,margin:0,paraSpaceAfter:9,breakLine:false,fit:"shrink",valign:"top"});
  };
  const addPhoto=(slide:any,image:RealImage,box:{x:number;y:number;w:number;h:number})=>{
    slide.addShape(p.ShapeType.roundRect,{x:box.x-.04,y:box.y-.04,w:box.w+.08,h:box.h+.08,rectRadius:.08,fill:{color:white},line:{color:white},shadow:{type:"outer",color:"000000",opacity:.16,blur:2,angle:45,distance:1}});
    slide.addImage({data:imageDataUri(image),x:box.x,y:box.y,w:box.w,h:box.h,sizing:{type:"cover",w:box.w,h:box.h},altText:image.title});
  };
  const placePhoto=(slide:any,section:ArtifactPlan["sections"][number],image:RealImage,box:{x:number;y:number;w:number;h:number},captionBox?:{x:number;y:number;w:number;h:number})=>{
    addPhoto(slide,image,box);
    if(section.imageQuery)placedImageQueries.add(section.imageQuery);
    const caption=captionBox??{x:box.x,y:box.y+box.h+.08,w:box.w,h:.18};
    slide.addText(short(`${image.title} · ${image.creator} · ${image.license}`,180),{x:caption.x,y:caption.y,w:caption.w,h:caption.h,fontSize:6.6,color:muted,margin:0,fit:"shrink",align:"right"});
  };
  const addRenderedChart=async(
    slide:any,
    section:ArtifactPlan["sections"][number],
    image?:RealImage,
  )=>{
    const chart=section.chart!,png=await chartPng(chart);
    slide.addText(short(chart.title,120),{x:.82,y:1.42,w:11.4,h:.36,fontSize:17,bold:true,color:navy,margin:0,fit:"shrink"});
    const chartW=image?7.55:8.65;
    slide.addImage({data:`data:image/png;base64,${png.toString("base64")}`,x:.82,y:1.92,w:chartW,h:4.72,altText:chart.title});
    const cardX=image?8.62:9.72,cardW=image?3.72:2.82;
    slide.addShape(p.ShapeType.roundRect,{x:cardX,y:2.06,w:cardW,h:image?1.62:2.15,rectRadius:.06,fill:{color:pale},line:{color:pale}});
    slide.addText(short(section.body,260),{x:cardX+.22,y:2.3,w:cardW-.44,h:image?1.1:1.55,fontSize:image?14.5:16,bold:true,color:navy,margin:0,fit:"shrink",valign:"mid"});
    if(image)placePhoto(slide,section,image,{x:8.72,y:4.02,w:3.48,h:1.92},{x:8.72,y:6.02,w:3.48,h:.18});
    if(chart.sourceNote)slide.addText(short(chart.sourceNote,180),{x:.84,y:6.62,w:image?7.5:8.7,h:.22,fontSize:8,color:muted,margin:0,fit:"shrink"});
  };
  const addNativeDiagram=(
    slide:any,
    section:ArtifactPlan["sections"][number],
    image?:RealImage,
  )=>{
    const diagram=section.diagram!,nodes=diagram.nodes.slice(0,8);
    const availableW=image?8.55:11.5;
    const columns=Math.min(image?3:4,nodes.length),rows=Math.ceil(nodes.length/columns),boxW=image?2.35:2.55,boxH=1.05,gapX=.38,gapY=.72,startX=.82+(availableW-(columns*boxW+(columns-1)*gapX))/2,startY=2.05;
    slide.addText(short(diagram.title,120),{x:.82,y:1.42,w:image?8.55:11.4,h:.36,fontSize:17,bold:true,color:navy,align:"center",margin:0,fit:"shrink"});
    for(let index=0;index<nodes.length-1;index++){
      const row=Math.floor(index/columns),col=index%columns,nextRow=Math.floor((index+1)/columns),nextCol=(index+1)%columns;
      const x=startX+col*(boxW+gapX),y=startY+row*(boxH+gapY),nx=startX+nextCol*(boxW+gapX),ny=startY+nextRow*(boxH+gapY);
      if(row===nextRow)slide.addShape(p.ShapeType.line,{x:x+boxW,y:y+boxH/2,w:gapX,h:0,line:{color:blue,pt:2.2,endArrowType:"triangle"}});
      else slide.addShape(p.ShapeType.line,{x:x+boxW/2,y:y+boxH,w:nx+boxW/2-(x+boxW/2),h:ny-y-boxH,line:{color:blue,pt:2.2,endArrowType:"triangle"}});
    }
    nodes.forEach((node,index)=>{const row=Math.floor(index/columns),col=index%columns,x=startX+col*(boxW+gapX),y=startY+row*(boxH+gapY);slide.addShape(p.ShapeType.roundRect,{x,y,w:boxW,h:boxH,rectRadius:.05,fill:{color:index%2?pale:"F1E5C5"},line:{color:gold,pt:1.2},shadow:{type:"outer",color:"000000",opacity:.1,blur:1,angle:45,distance:.5}});slide.addText(short(node,52),{x:x+.18,y:y+.16,w:boxW-.36,h:boxH-.32,fontSize:17,bold:true,color:navy,align:"center",valign:"mid",margin:0,fit:"shrink"});});
    if(diagram.caption||section.body)slide.addText(short(diagram.caption||section.body,320),{x:1.0,y:rows===1?4.34:5.55,w:image?8.15:11.1,h:.72,fontSize:17,color:muted,align:"center",margin:0,fit:"shrink"});
    if(image)placePhoto(slide,section,image,{x:9.58,y:1.92,w:2.85,h:3.1},{x:9.58,y:5.14,w:2.85,h:.18});
  };
  const addNativeTable=(
    slide:any,
    section:ArtifactPlan["sections"][number],
    image?:RealImage,
  )=>{
    const table=section.table!,headers=table.headers.map(text=>({text,options:{bold:true,color:white,fill:{color:navy},margin:.08}})),rows=table.rows.slice(0,image?12:16).map((row,rowIndex)=>row.map(text=>({text:short(text,160),options:{fill:{color:rowIndex%2?"F2F5F6":white},color:ink,margin:.07}})));
    slide.addText(short(table.title,120),{x:.78,y:1.4,w:image?8.3:11.6,h:.36,fontSize:17,bold:true,color:navy,margin:0,fit:"shrink"});
    slide.addTable([headers,...rows],{x:.78,y:1.88,w:image?8.25:11.78,h:4.86,border:{type:"solid",color:"CCD4D9",pt:.7},fontFace:"Aptos",fontSize:image?10.4:11,rowH:.32,margin:.06,valign:"middle",autoFit:false});
    if(image){
      placePhoto(slide,section,image,{x:9.35,y:1.92,w:2.92,h:2.55},{x:9.35,y:4.56,w:2.92,h:.18});
      slide.addShape(p.ShapeType.roundRect,{x:9.35,y:4.92,w:2.92,h:1.24,rectRadius:.05,fill:{color:pale},line:{color:pale}});
      slide.addText(short(section.body,220),{x:9.58,y:5.12,w:2.46,h:.78,fontSize:13.5,bold:true,color:navy,margin:0,fit:"shrink",valign:"mid"});
    }
  };
  const addActivitySlide=(
    slide:any,
    section:ArtifactPlan["sections"][number],
    image?:RealImage,
  )=>{
    const activity=section.activity!;
    const photoBox=image?{x:10.0,y:1.48,w:2.25,h:1.42}:null;
    const placeActivityPhoto=()=>{
      if(image&&photoBox)
        placePhoto(slide,section,image,photoBox,{x:10.0,y:2.97,w:2.25,h:.16});
    };

    if(activity.type==="four_corners"){
      usedActivityTemplates.add("four-corners-quadrants");
      slide.addText(short(section.body,260),{x:.88,y:1.38,w:image?8.75:11.55,h:.54,fontSize:19,bold:true,color:navy,align:"center",margin:0,fit:"shrink"});
      const labels=activity.cornerLabels.slice(0,4),colors=["F1E5C5","E7EEF2","E4EFE6","F3E4DF"];
      labels.forEach((label,index)=>{
        const column=index%2,row=Math.floor(index/2),x=.92+column*(image?4.48:6.02),y=2.08+row*1.54;
        slide.addText(label,{x,y,w:image?4.05:5.5,h:1.14,shape:p.ShapeType.roundRect,rectRadius:.06,fill:{color:colors[index]!},line:{color:index%2?blue:gold,pt:1.4},fontSize:image?19:22,bold:true,color:navy,align:"center",valign:"mid",margin:.16,fit:"shrink"});
      });
      slide.addText(activity.directions.map((text,index)=>({text:`${index+1}. ${short(text,130)}`,options:{breakLine:index<activity.directions.length-1}})),{x:.92,y:5.22,w:image?5.85:7.35,h:.82,fontSize:13,color:ink,margin:.12,fit:"shrink"});
      slide.addText(activity.sentenceFrames.slice(0,3).map((text,index)=>({text:short(text,130),options:{bullet:{indent:14},breakLine:index<Math.min(3,activity.sentenceFrames.length)-1}})),{x:image?6.98:8.52,y:5.12,w:image?2.6:3.8,h:1.03,shape:p.ShapeType.roundRect,fill:{color:navy},line:{color:navy},fontSize:12.5,bold:true,color:white,margin:.18,fit:"shrink"});
      placeActivityPhoto();
      return "four-corners-quadrants";
    }

    if(activity.type==="speed_dating"){
      usedActivityTemplates.add("speed-dating-rotation");
      slide.addText(`${activity.durationMinutes} MIN\nROTATIONS`,{x:.88,y:1.46,w:2.15,h:1.08,shape:p.ShapeType.roundRect,fill:{color:navy},line:{color:navy},fontSize:20,bold:true,color:white,align:"center",valign:"mid",margin:.12});
      slide.addText(activity.directions.slice(0,5).map((text,index)=>({text:`${index+1}. ${short(text,115)}`,options:{breakLine:index<Math.min(5,activity.directions.length)-1}})),{x:.92,y:2.72,w:2.86,h:2.35,fontSize:14,color:ink,margin:.08,fit:"shrink"});
      const promptRight=image?9.55:12.12,promptW=(promptRight-4.02-.38)/2;
      activity.prompts.slice(0,6).forEach((text,index)=>{
        const column=index%2,row=Math.floor(index/2),x=4.02+column*(promptW+.38),y=1.48+row*1.28;
        slide.addText([{text:String(index+1).padStart(2,"0"),options:{bold:true,color:gold,breakLine:true}},{text:short(text,150),options:{bold:true,color:navy}}],{x,y,w:promptW,h:1.02,shape:p.ShapeType.roundRect,fill:{color:index%2?"EEF3F5":"F7EED7"},line:{color:index%2?blue:gold,pt:1},fontSize:13.5,margin:.14,fit:"shrink"});
      });
      slide.addText(activity.sentenceFrames.slice(0,4).map((text,index)=>({text:short(text,140),options:{bullet:{indent:14},breakLine:index<Math.min(4,activity.sentenceFrames.length)-1}})),{x:4.02,y:5.46,w:image?5.55:8.1,h:.74,shape:p.ShapeType.roundRect,fill:{color:navy},line:{color:navy},fontSize:13,bold:true,color:white,margin:.14,fit:"shrink"});
      placeActivityPhoto();
      return "speed-dating-rotation";
    }

    if(activity.type==="guided_practice"){
      usedActivityTemplates.add("guided-step-rail");
      slide.addText(short(section.body,280),{x:.9,y:1.42,w:image?8.75:11.4,h:.56,fontSize:19,bold:true,color:navy,margin:0,fit:"shrink"});
      activity.directions.slice(0,5).forEach((text,index)=>{
        const y=2.16+index*.72;
        slide.addText(String(index+1).padStart(2,"0"),{x:.92,y,w:.52,h:.44,fontSize:16,bold:true,color:white,align:"center",valign:"mid",shape:p.ShapeType.ellipse,fill:{color:blue},line:{color:blue},margin:0});
        slide.addText(short(text,125),{x:1.62,y:y-.02,w:3.25,h:.48,fontSize:14.2,color:ink,margin:0,fit:"shrink",valign:"mid"});
      });
      activity.prompts.slice(0,6).forEach((text,index)=>{
        const column=index%2,row=Math.floor(index/2),x=5.15+column*(image?2.2:3.25),y=2.06+row*1.18;
        slide.addText(short(text,135),{x,y,w:image?1.95:2.95,h:.92,shape:p.ShapeType.roundRect,fill:{color:index%2?"F7EED7":"EEF3F5"},line:{color:index%2?gold:blue,pt:1},fontSize:13.5,bold:true,color:navy,margin:.14,fit:"shrink",valign:"mid"});
      });
      if(activity.sentenceFrames.length)slide.addText(activity.sentenceFrames.slice(0,3).map((text,index)=>({text:short(text,120),options:{breakLine:index<Math.min(3,activity.sentenceFrames.length)-1}})),{x:5.15,y:5.63,w:image?4.2:6.3,h:.64,shape:p.ShapeType.roundRect,fill:{color:navy},line:{color:navy},fontSize:12.5,bold:true,color:white,margin:.12,fit:"shrink"});
      placeActivityPhoto();
      return "guided-step-rail";
    }

    if(activity.type==="discussion"){
      usedActivityTemplates.add("discussion-prompt-cards");
      slide.addText(short(section.body,300),{x:.92,y:1.42,w:image?8.75:11.35,h:.56,fontSize:19,bold:true,color:navy,align:"center",margin:0,fit:"shrink"});
      activity.prompts.slice(0,6).forEach((text,index)=>{
        const column=index%2,row=Math.floor(index/2),x=.98+column*(image?4.3:5.75),y=2.16+row*1.16;
        const w=image?3.92:5.36;
        slide.addText(short(text,150),{x,y,w,h:.86,shape:p.ShapeType.roundRect,fill:{color:index%2?"EEF3F5":"F7EED7"},line:{color:index%2?blue:gold,pt:1.1},fontSize:14.5,bold:true,color:navy,margin:.15,fit:"shrink",valign:"mid"});
      });
      slide.addText(activity.directions.slice(0,4).map((text,index)=>({text:`${index+1}. ${short(text,120)}`,options:{breakLine:index<Math.min(4,activity.directions.length)-1}})),{x:.98,y:5.78,w:image?5.2:6.5,h:.58,fontSize:11.8,color:muted,margin:0,fit:"shrink"});
      if(activity.sentenceFrames.length)slide.addText(activity.sentenceFrames.slice(0,3).map((text,index)=>({text:short(text,120),options:{bullet:{indent:12},breakLine:index<Math.min(3,activity.sentenceFrames.length)-1}})),{x:image?6.5:7.75,y:5.54,w:image?3.0:4.4,h:.78,shape:p.ShapeType.roundRect,fill:{color:navy},line:{color:navy},fontSize:12.2,bold:true,color:white,margin:.13,fit:"shrink"});
      placeActivityPhoto();
      return "discussion-prompt-cards";
    }

    usedActivityTemplates.add("independent-checklist");
    slide.addText(short(section.body,300),{x:.92,y:1.42,w:image?8.75:11.4,h:.56,fontSize:19,bold:true,color:navy,margin:0,fit:"shrink"});
    slide.addShape(p.ShapeType.roundRect,{x:.98,y:2.12,w:3.3,h:3.72,rectRadius:.06,fill:{color:pale},line:{color:blue,pt:1}});
    slide.addText("CHECKLIST",{x:1.24,y:2.4,w:2.72,h:.28,fontSize:11,bold:true,charSpacing:1.4,color:blue,margin:0});
    slide.addText(activity.directions.slice(0,6).map((text,index)=>({text:`☐ ${short(text,135)}`,options:{breakLine:index<Math.min(6,activity.directions.length)-1}})),{x:1.24,y:2.88,w:2.72,h:2.4,fontSize:13.8,color:ink,margin:0,fit:"shrink"});
    activity.prompts.slice(0,6).forEach((text,index)=>{
      const y=2.12+index*.67;
      slide.addText(short(text,165),{x:4.62,y,w:image?4.85:7.35,h:.53,shape:p.ShapeType.roundRect,fill:{color:index%2?"FFFFFF":"F7EED7"},line:{color:index%2?"D6DEE3":gold,pt:.8},fontSize:13.5,bold:true,color:navy,margin:.12,fit:"shrink",valign:"mid"});
    });
    if(activity.sentenceFrames.length)slide.addText(activity.sentenceFrames.slice(0,3).map((text,index)=>({text:short(text,120),options:{breakLine:index<Math.min(3,activity.sentenceFrames.length)-1}})),{x:4.62,y:6.1,w:image?4.85:7.35,h:.42,fontSize:11.5,bold:true,color:blue,margin:0,fit:"shrink"});
    placeActivityPhoto();
    return "independent-checklist";
  };
  const title=p.addSlide(); title.background={color:navy};
  title.addShape(p.ShapeType.rect,{x:0,y:0,w:.18,h:7.5,fill:{color:gold},line:{color:gold}});
  title.addShape(p.ShapeType.arc,{x:9.15,y:.35,w:3.65,h:3.65,rotate:18,fill:{color:gold,transparency:78},line:{color:gold,transparency:100}});
  title.addText("VISUAL BRIEF",{x:.82,y:1.06,w:2.8,h:.24,fontSize:10,bold:true,charSpacing:2,color:gold,margin:0});
  title.addText(short(plan.title,130),{x:.82,y:1.55,w:10.6,h:1.65,fontFace:"Aptos Display",fontSize:42,bold:true,color:white,margin:0,breakLine:false,fit:"shrink",valign:"middle"});
  if(plan.subtitle)title.addText(short(plan.subtitle,220),{x:.85,y:3.62,w:8.9,h:.92,fontSize:20,color:"DDE6ED",margin:0,fit:"shrink"});
  addNotesParagraphs(title,["Opening slide"]);
  for(const [index,section] of contentSections.entries()){
    const slide=p.addSlide(),slideNumber=index+2;slide.background={color:bg};
    slide.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:.1,fill:{color:gold},line:{color:gold}});
    addHeading(slide,section.heading,`Part ${String(index+1).padStart(2,"0")}`);
    const image=section.imageQuery?images.get(section.imageQuery):undefined;
    if(section.activity)addActivitySlide(slide,section,image);
    else if(section.chart)await addRenderedChart(slide,section,image);
    else if(section.table)addNativeTable(slide,section,image);
    else if(section.diagram)addNativeDiagram(slide,section,image);
    else if(image){
      const fullBleed=index%4===2;
      if(fullBleed){
        slide.addImage({data:imageDataUri(image),x:0,y:0,w:13.333,h:7.5,sizing:{type:"cover",w:13.333,h:7.5},altText:image.title});
        if(section.imageQuery)placedImageQueries.add(section.imageQuery);
        slide.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:7.5,fill:{color:navy,transparency:22},line:{color:navy,transparency:100}});
        slide.addShape(p.ShapeType.rect,{x:.66,y:.66,w:6.15,h:5.62,fill:{color:navy,transparency:12},line:{color:white,transparency:100}});
        slide.addText(short(section.heading,92),{x:.98,y:1.05,w:5.55,h:1.05,fontSize:34,bold:true,color:white,margin:0,fit:"shrink"});
        addNarrative(slide,section,{x:1,y:2.3,w:5.3,h:3.35},true);
        slide.addText(short(`${image.title} · ${image.creator} · ${image.license}`,180),{x:7.05,y:7.12,w:5.5,h:.16,fontSize:6.5,color:white,align:"right",margin:0,fit:"shrink"});
      }else{
        const imageLeft=index%2===1,imageBox={x:imageLeft ? .72 : 7.02,y:1.5,w:5.58,h:4.92},textBox={x:imageLeft ? 6.72 : .78,y:1.66,w:5.45,h:4.7};
        placePhoto(slide,section,image,imageBox,{x:imageBox.x,y:6.5,w:imageBox.w,h:.2});addNarrative(slide,section,textBox);
      }
    }else{
      slide.addText(String(index+1).padStart(2,"0"),{x:.76,y:1.55,w:2.1,h:1.3,fontSize:74,bold:true,color:"E4D7B3",margin:0});
      slide.addShape(p.ShapeType.line,{x:3.05,y:1.92,w:0,h:4.15,line:{color:gold,pt:2}});
      addNarrative(slide,section,{x:3.52,y:1.67,w:8.55,h:4.65});
    }
    addFooter(slide,slideNumber);
    const noteSources=[
      ...(image&&section.imageQuery&&placedImageQueries.has(section.imageQuery)?[image.sourceUrl]:[]),
      ...(section.chart?.sourceNote?[section.chart.sourceNote]:[]),
    ];
    addNotesParagraphs(slide,noteParagraphs(section.speakerNotes,noteSources));
  }

  const unplacedFetched=[...images.keys()].filter(query=>!placedImageQueries.has(query));
  if(unplacedFetched.length)
    throw new ArtifactPipelineError(
      "BUILD",
      `Presentation layout discarded fetched images: ${unplacedFetched.join(", ")}`,
      {ruleOrPart:"pptx-image-placement"},
    );
  title.addText(
    `${contentSections.length} ideas · ${placedImageQueries.size} licensed visuals`,
    {x:.85,y:6.72,w:4.8,h:.22,fontSize:9,bold:true,charSpacing:.8,color:"B9C8D3",margin:0},
  );

  for(const [chunkIndex,chunk] of sourceChunks.entries()){
    const slide=p.addSlide(),slideNumber=2+contentSections.length+chunkIndex;slide.background={color:bg};
    addHeading(slide,sourceChunks.length>1?`Sources ${chunkIndex+1} of ${sourceChunks.length}`:"Sources","Evidence trail");
    chunk.forEach((source,index)=>{const y=1.48+index*.66;slide.addText(String(chunkIndex*8+index+1).padStart(2,"0"),{x:.78,y,w:.42,h:.23,fontSize:10,bold:true,color:gold,margin:0});slide.addText(short(source.title,180),{x:1.35,y:y-.02,w:4.15,h:.28,fontSize:13,bold:true,color:navy,margin:0,fit:"shrink"});slide.addText(short(source.url,150),{x:5.7,y:y-.02,w:6.45,h:.3,fontSize:10,color:blue,margin:0,fit:"shrink",hyperlink:{url:source.url}});});
    addFooter(slide,slideNumber);
    addNotesParagraphs(slide,noteParagraphs("",chunk.map(source=>source.url)));
  }
  const name=`${slug(plan.title)}.pptx`, target=safeJoin(config.artifactDir,name);
  const raw=Buffer.from(await p.write({outputType:"nodebuffer"}) as ArrayBuffer); if(raw.length<5000)throw new Error("PPTX validation failed: output too small");
  atomicWrite(target,raw);
  const validationReceipt=await validateBuiltArtifact(
    "presentation",
    prompt,
    reconciled.plan,
    target,
    jobId ? { root: path.join(config.storageRoot, "diagnostics"), jobId } : undefined,
  );
  collectedImages.metrics.placed=placedImageQueries.size;
  const enrichedReceipt=validationReceipt as ArtifactValidationReceipt & {
    images:ImageResolutionReceipt;
    presentation:PresentationBuildReceipt;
  };
  enrichedReceipt.images=collectedImages.metrics;
  enrichedReceipt.presentation={
    placedAssets:placedImageQueries.size,
    activityTemplates:[...usedActivityTemplates].sort(),
    reconciliations:reconciled.reconciliations,
    titleCounts:{
      contentSlides:contentSections.length,
      licensedVisuals:placedImageQueries.size,
    },
  };
  return{name,mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",path:target,size:raw.length,validationReceipt};
}

async function docx(config:Config,plan:ArtifactPlan,prompt="",kind:Extract<JobKind,"document"|"analysis"|"research">="document",jobId=""):Promise<BuiltFile>{
  const contentSections=plan.sections.filter(section=>!isSourcesHeading(section.heading));
  const collectedImages=await collectImages(
    config,
    {...plan,sections:contentSections},
    prompt,
    10,
  );
  const images=collectedImages.images;
  const placedImageQueries=new Set<string>();
  const noBorder={style:BorderStyle.NONE,size:0,color:"FFFFFF"};
  const cellBorders={top:noBorder,bottom:{style:BorderStyle.SINGLE,size:4,color:"D9E0E4"},left:noBorder,right:noBorder,insideHorizontal:noBorder,insideVertical:noBorder};
  const tableWidths=(headers:string[],rows:string[][])=>{
    const weights=headers.map((header,column)=>Math.min(44,Math.max(8,header.length,...rows.map(row=>(row[column]||"").length)))),minimum=720,remaining=9360-minimum*weights.length,total=weights.reduce((sum,value)=>sum+value,0),widths=weights.map(weight=>minimum+Math.floor(remaining*weight/total));
    widths[widths.length-1]!+=9360-widths.reduce((sum,value)=>sum+value,0);return widths;
  };
  const imageDimensions=(image:RealImage,maxWidth=560,maxHeight=320)=>{const scale=Math.min(maxWidth/image.width,maxHeight/image.height);return{width:Math.max(1,Math.round(image.width*scale)),height:Math.max(1,Math.round(image.height*scale))}};
  const documentTruncations:DocumentBuildReceipt["truncations"]=[];
  const renderedActivityTypes=new Set<string>();
  let activitiesRendered=0;
  const addActivityToDocument=(section:ArtifactPlan["sections"][number])=>{
    const activity=section.activity;
    if(!activity)return;
    activitiesRendered++;
    renderedActivityTypes.add(activity.type);
    children.push(
      new Paragraph({spacing:{before:220,after:90},keepNext:true,children:[
        new TextRun({text:`Activity · ${activity.type.replace(/_/g," ")} · ${activity.durationMinutes} min`,bold:true,size:22,color:"C99A2E",allCaps:true}),
      ]}),
      new Paragraph({spacing:{after:80},children:[new TextRun({text:"Directions",bold:true,size:20,color:"17324D"})]}),
    );
    activity.directions.forEach((value,index)=>children.push(
      new Paragraph({spacing:{after:70},indent:{left:360,hanging:220},children:[
        new TextRun({text:`${index+1}. `,bold:true,size:18,color:"2F739C"}),
        new TextRun({text:value,size:18,color:"17202A"}),
      ]}),
    ));
    if(activity.type==="four_corners"){
      children.push(new Paragraph({spacing:{before:120,after:90},keepNext:true,children:[new TextRun({text:"Four Corners",bold:true,size:20,color:"17324D"})]}));
      const labels=[...activity.cornerLabels];
      const cells=Array.from({length:4},(_,index)=>new TableCell({
        width:{size:4680,type:WidthType.DXA},
        verticalAlign:VerticalAlign.CENTER,
        shading:{type:ShadingType.CLEAR,fill:index%2?"E7EEF2":"F7EED7",color:"auto"},
        borders:cellBorders,
        children:[new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:180,after:180},children:[
          new TextRun({text:labels[index]??"",bold:true,size:22,color:"17324D"}),
        ]})],
      }));
      children.push(new Table({
        width:{size:9360,type:WidthType.DXA},
        columnWidths:[4680,4680],
        layout:TableLayoutType.FIXED,
        rows:[
          new TableRow({children:[cells[0]!,cells[1]!]}),
          new TableRow({children:[cells[2]!,cells[3]!]}),
        ],
        borders:cellBorders,
      }));
    }
    if(activity.prompts.length){
      children.push(new Paragraph({spacing:{before:140,after:80},keepNext:true,children:[new TextRun({text:"Prompts",bold:true,size:20,color:"17324D"})]}));
      activity.prompts.forEach((value)=>children.push(
        new Paragraph({text:value,numbering:{reference:"activity-prompts",level:0},style:"BodyText"}),
      ));
    }
    if(activity.sentenceFrames.length){
      children.push(new Paragraph({spacing:{before:140,after:80},keepNext:true,children:[new TextRun({text:"Sentence frames",bold:true,size:20,color:"17324D"})]}));
      activity.sentenceFrames.forEach((value)=>children.push(
        new Paragraph({spacing:{after:70},children:[new TextRun({text:value,italics:true,size:18,color:"2F739C"})]}),
      ));
    }
  };
  const children:Array<Paragraph|Table>=[
    new Paragraph({spacing:{before:1760,after:160},children:[new TextRun({text:plan.title,bold:true,size:60,color:"17324D",font:"Calibri"})],alignment:AlignmentType.CENTER}),
    new Paragraph({border:{bottom:{style:BorderStyle.SINGLE,size:18,color:"C99A2E",space:1}},spacing:{after:360}}),
    ...(plan.subtitle?[new Paragraph({spacing:{after:620},children:[new TextRun({text:plan.subtitle,italics:true,size:30,color:"5A6772",font:"Calibri"})],alignment:AlignmentType.CENTER})]:[]),
    new Paragraph({spacing:{before:460,after:80},children:[new TextRun({text:"Prepared by Agent Díaz",bold:true,size:18,color:"C99A2E",allCaps:true,characterSpacing:20})],alignment:AlignmentType.CENTER}),
    new Paragraph({spacing:{after:900},children:[new TextRun({text:new Date().toLocaleDateString("en-CA",{year:"numeric",month:"long",day:"numeric"}),size:18,color:"5A6772"})],alignment:AlignmentType.CENTER}),
    new Paragraph({pageBreakBefore:true,text:""}),
  ];
  for(const [index,section] of contentSections.entries()){
    const imageStartsPage=index>0&&!!section.imageQuery&&images.has(section.imageQuery);
    children.push(
      new Paragraph({pageBreakBefore:imageStartsPage,style:"DiazHeading1",keepNext:true,border:{bottom:{style:BorderStyle.SINGLE,size:8,color:"C99A2E",space:6}},children:[new TextRun({text:section.heading,bold:true,color:"2E74B5",size:32,font:"Calibri"})]}),
      new Paragraph({keepNext:true,children:[new TextRun({text:section.body,size:22,color:"17202A",font:"Calibri"})]}),
    );
    for(const bullet of section.bullets)children.push(new Paragraph({text:bullet,numbering:{reference:"artifact-bullets",level:0},style:"BodyText"}));
    if(section.table){
      const sourceRows=section.table.rows,widths=tableWidths(section.table.headers,sourceRows);
      children.push(new Paragraph({spacing:{before:80,after:80},children:[new TextRun({text:section.table.title,bold:true,size:23,color:"17324D"})]}));
      const header=new TableRow({tableHeader:true,children:section.table.headers.map((header,column)=>new TableCell({width:{size:widths[column]!,type:WidthType.DXA},shading:{type:ShadingType.CLEAR,fill:"F2F4F7",color:"auto"},verticalAlign:VerticalAlign.CENTER,borders:cellBorders,children:[new Paragraph({spacing:{before:70,after:70},children:[new TextRun({text:header,bold:true,color:"17324D",size:18})]})]}))});
      const rows=sourceRows.map(row=>new TableRow({children:row.map((value,column)=>new TableCell({width:{size:widths[column]!,type:WidthType.DXA},shading:{type:ShadingType.CLEAR,fill:"FFFFFF",color:"auto"},verticalAlign:VerticalAlign.CENTER,borders:cellBorders,children:[new Paragraph({spacing:{before:60,after:60},children:[new TextRun({text:value,size:17,color:"17202A"})]})]}))}));
      children.push(new Table({width:{size:9360,type:WidthType.DXA},indent:{size:120,type:WidthType.DXA},columnWidths:widths,margins:{top:80,bottom:80,left:120,right:120},layout:TableLayoutType.FIXED,rows:[header,...rows],borders:cellBorders}));
    }
    if(section.chart){
      const png=await chartPng(section.chart);
      children.push(new Paragraph({spacing:{before:180,after:80},children:[new ImageRun({data:png,transformation:{width:560,height:314},type:"png",altText:{title:section.chart.title,description:section.chart.sourceNote||section.chart.title,name:section.chart.title}})],alignment:AlignmentType.CENTER}));
      if(section.chart.sourceNote)children.push(new Paragraph({spacing:{after:140},children:[new TextRun({text:`Source: ${section.chart.sourceNote}`,italics:true,size:16,color:"5A6772"})],alignment:AlignmentType.CENTER}));
    }else if(section.diagram){
      const png=await diagramPng(section.diagram);
      children.push(new Paragraph({spacing:{before:180,after:120},children:[new ImageRun({data:png,transformation:{width:560,height:235},type:"png",altText:{title:section.diagram.title,description:section.diagram.caption||section.diagram.title,name:section.diagram.title}})],alignment:AlignmentType.CENTER}));
    }else if(section.imageQuery&&images.has(section.imageQuery)){
      placedImageQueries.add(section.imageQuery);
      const image=images.get(section.imageQuery)!,dimensions=imageDimensions(image);
      children.push(
        new Paragraph({spacing:{before:220,after:80},children:[new ImageRun({data:image.bytes,transformation:dimensions,type:image.extension as "jpg"|"png",altText:{title:image.title,description:`${image.title} by ${image.creator}`,name:image.title}})],alignment:AlignmentType.CENTER}),
        new Paragraph({spacing:{after:140},children:[new TextRun({text:`${image.title} — ${image.creator} · ${image.license}`,italics:true,size:15,color:"5A6772"})],alignment:AlignmentType.CENTER}),
      );
    }
    addActivityToDocument(section);
  }
  if(plan.sources.length){
    children.push(new Paragraph({pageBreakBefore:true,style:"DiazHeading1",children:[new TextRun({text:"Sources",bold:true,color:"17324D",size:34})]}));
    plan.sources.forEach((source,index)=>children.push(new Paragraph({spacing:{after:110},indent:{left:360,hanging:360},children:[new TextRun({text:`${index+1}. ${source.title}. `,bold:true,size:17,color:"17324D"}),new TextRun({text:source.url,size:16,color:"2F739C"})]})));
  }
  const d=new Document({
    creator:"Agent Díaz",title:plan.title,description:plan.subtitle,
    styles:{
      default:{document:{run:{font:"Calibri",size:22,color:"17202A"},paragraph:{spacing:{after:120,line:264}}}},
      paragraphStyles:[
        {id:"DiazHeading1",name:"Diaz Heading 1",basedOn:"Normal",next:"Normal",quickFormat:true,run:{font:"Calibri",size:32,bold:true,color:"2E74B5"},paragraph:{spacing:{before:320,after:160},outlineLevel:0,keepNext:true}},
        {id:"BodyText",name:"Body Text",basedOn:"Normal",quickFormat:true,run:{font:"Calibri",size:22,color:"17202A"},paragraph:{spacing:{after:160,line:280}}},
      ],
    },
    numbering:{config:[
      {reference:"artifact-bullets",levels:[{level:0,format:LevelFormat.BULLET,text:"•",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360},spacing:{after:160,line:280}},run:{font:"Calibri",size:22,color:"17202A"}}}]},
      {reference:"activity-prompts",levels:[{level:0,format:LevelFormat.BULLET,text:"◆",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360},spacing:{after:120,line:260}},run:{font:"Calibri",size:20,color:"17324D"}}}]},
    ]},
    sections:[{properties:{titlePage:true,page:{margin:{top:1440,right:1440,bottom:1440,left:1440,header:708,footer:708}}},headers:{first:new Header({children:[new Paragraph("")]}),default:new Header({children:[new Paragraph({border:{bottom:{style:BorderStyle.SINGLE,size:5,color:"D9E0E4",space:4}},children:[new TextRun({text:short(plan.title,85),bold:true,size:16,color:"5A6772",font:"Calibri"})]})]})},footers:{first:new Footer({children:[new Paragraph("")]}),default:new Footer({children:[new Paragraph({border:{top:{style:BorderStyle.SINGLE,size:5,color:"D9E0E4",space:4}},children:[new TextRun({text:"AGENT DÍAZ  ·  ",bold:true,size:14,color:"C99A2E",font:"Calibri"}),new TextRun({children:[PageNumber.CURRENT],size:14,color:"5A6772",font:"Calibri"})],alignment:AlignmentType.RIGHT})]})},children}],
  });
  const buf=await Packer.toBuffer(d); if(buf.length<3000)throw new Error("DOCX validation failed: output too small");
  const name=`${slug(plan.title)}.docx`,target=safeJoin(config.artifactDir,name);
  atomicWrite(target,buf);
  const validationReceipt=await validateBuiltArtifact(
    kind,
    prompt,
    plan,
    target,
    jobId ? { root: path.join(config.storageRoot, "diagnostics"), jobId } : undefined,
  );
  collectedImages.metrics.placed=placedImageQueries.size;
  const enrichedReceipt=validationReceipt as ArtifactValidationReceipt & {
    images:ImageResolutionReceipt;
    document:DocumentBuildReceipt;
  };
  enrichedReceipt.images=collectedImages.metrics;
  enrichedReceipt.document={
    activitiesRendered,
    activityTypes:[...renderedActivityTypes].sort(),
    truncations:documentTruncations,
  };
  return{name,mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",path:target,size:buf.length,validationReceipt};
}

async function website(config:Config,plan:ArtifactPlan,prompt="",jobId=""):Promise<BuiltFile>{
  const css=`:root{--ink:#17202a;--gold:#c99a2e;--paper:#f7f3ea;--navy:#17324d;--blue:#2f739c;--white:#fff;--muted:#5a6772}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:Inter,Aptos,system-ui,sans-serif;color:var(--ink);background:var(--paper);line-height:1.65}nav{position:sticky;top:0;z-index:5;display:flex;gap:1.35rem;align-items:center;padding:1rem 6vw;background:#101d29f7;color:white;box-shadow:0 3px 18px #0003;backdrop-filter:blur(12px)}nav strong{margin-right:auto;letter-spacing:.04em}nav a{color:white;text-decoration:none;font-weight:650}nav a[aria-current=page]{color:#f1c65b;border-bottom:2px solid}.hero{isolation:isolate;position:relative;overflow:hidden;background-color:var(--navy);background-position:center;background-size:cover;color:white;padding:clamp(5rem,10vw,8rem) 6vw;border-top:8px solid var(--gold)}.hero:before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,#10283df2 0%,#10283dc9 52%,#10283d52 100%)}.hero .eyebrow{text-transform:uppercase;letter-spacing:.18em;color:#f1c65b;font-size:.78rem;font-weight:800}.hero h1{font-size:clamp(2.8rem,6vw,5.7rem);letter-spacing:-.04em;line-height:.96;margin:.55rem 0 1rem;max-width:15ch}.hero p{font-size:clamp(1.05rem,2vw,1.3rem);max-width:56ch;color:#e0e9f0}main{max-width:1180px;margin:auto;padding:2rem 6vw 4rem}section{padding:clamp(3rem,6vw,5.5rem) 0;border-bottom:1px solid #d9d2c2}section.with-photo{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,.92fr);gap:clamp(2rem,5vw,5rem);align-items:center}.with-photo.flip .copy{order:2}.with-photo.flip .photo{order:1}.copy{min-width:0}h2{color:var(--navy);font-size:clamp(2rem,4vw,3.25rem);letter-spacing:-.035em;line-height:1.05;margin:.2rem 0 1.3rem}p{font-size:1.08rem}li{margin:.55rem 0}a{color:#815e09}.photo{margin:0;background:white;padding:.65rem;border-radius:20px;box-shadow:0 18px 55px #12202b22;transform:rotate(.35deg)}.flip .photo{transform:rotate(-.35deg)}.photo img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;border-radius:14px}.photo figcaption{font-size:.75rem;line-height:1.35;color:var(--muted);padding:.65rem .3rem .15rem}.viz,.table-wrap{grid-column:1/-1;margin:2rem 0 0}.viz svg{width:100%;height:auto;display:block;box-shadow:0 15px 45px #12202b1b;border-radius:18px}.table{overflow:auto;background:white;border-radius:14px;box-shadow:0 12px 35px #12202b14}table{border-collapse:collapse;width:100%;min-width:560px}th,td{padding:.9rem 1rem;border-bottom:1px solid #dbe2e6;text-align:left}th{background:var(--navy);color:white}footer{padding:2.4rem 6vw;background:#101d29;color:#ccd6df}footer a{color:#f1c65b}@media(max-width:760px){nav{align-items:flex-start;flex-wrap:wrap}.hero{padding-top:4rem}nav strong{width:100%}section.with-photo{display:block}.with-photo.flip .copy,.with-photo.flip .photo{order:initial}.photo{margin-top:2rem;transform:none!important}}`;
  const contentSections=plan.sections.filter(section=>!isSourcesHeading(section.heading));
  const thirds=[0,1,2].map(i=>contentSections.filter((_,j)=>j%3===i));
  const pages=plan.pages??[
    {slug:"index",title:"Home",description:plan.subtitle,sectionHeadings:thirds[0]!.map(s=>s.heading)},
    {slug:"insights",title:"Insights",description:"Key evidence and findings",sectionHeadings:thirds[1]!.map(s=>s.heading)},
    {slug:"resources",title:"Resources",description:"Practical details and references",sectionHeadings:thirds[2]!.map(s=>s.heading)}
  ];
  const collectedImages=await collectImages(config,plan,prompt,12);
  const images=collectedImages.images;
  const placedImageQueries=new Set<string>();
  const fileName=(page:(typeof pages)[number])=>page.slug==="index"?"index.html":`${page.slug}.html`;
  const nav=(active:string)=>`<nav aria-label="Primary"><strong>${escapeHtml(plan.title)}</strong>${pages.map(p=>`<a href="${fileName(p)}"${p.slug===active?' aria-current="page"':""}>${escapeHtml(p.title)}</a>`).join("")}<a href="attributions.html"${active==="attributions"?' aria-current="page"':""}>Credits</a></nav>`;
  const renderSection=(s:ArtifactPlan["sections"][number],index:number)=>{const img=s.imageQuery?images.get(s.imageQuery):undefined;if(img&&s.imageQuery)placedImageQueries.add(s.imageQuery);return `<section class="${img?`with-photo${index%2?" flip":""}`:""}"><div class="copy"><h2>${escapeHtml(s.heading)}</h2><p>${escapeHtml(s.body)}</p>${s.bullets.length?`<ul>${s.bullets.map(b=>`<li>${escapeHtml(b)}</li>`).join("")}</ul>`:""}</div>${img?`<figure class="photo"><img src="${imageDataUri(img)}" alt="${escapeHtml(img.title)}" loading="lazy"><figcaption>${escapeHtml(img.title)} — ${escapeHtml(img.creator)} · ${escapeHtml(img.license)} · <a href="${escapeHtml(img.sourceUrl)}">source</a></figcaption></figure>`:""}${s.table?`<figure class="table-wrap"><figcaption>${escapeHtml(s.table.title)}</figcaption><div class="table"><table><thead><tr>${s.table.headers.map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${s.table.rows.map(r=>`<tr>${r.map(v=>`<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></figure>`:""}${s.chart?`<figure class="viz">${chartSvg(s.chart)}</figure>`:""}${s.diagram?`<figure class="viz">${diagramSvg(s.diagram)}</figure>`:""}</section>`};
  const fallbackHero=[...images.values()][0];
  const shell=(title:string,description:string,active:string,body:string,heroImage=fallbackHero)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)} · ${escapeHtml(plan.title)}</title><style>${css}</style></head><body>${nav(active)}<header class="hero"${heroImage?` style="background-image:url('${imageDataUri(heroImage)}')"`:""}><div class="eyebrow">Agent Díaz field guide</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></header><main>${body}</main><footer>Created with Agent Díaz · <a href="attributions.html">Sources and image credits</a></footer></body></html>`;
  const htmlPages=pages.map(page=>{const wanted=new Set(page.sectionHeadings),sections=contentSections.filter(s=>wanted.has(s.heading)),pageHero=sections.map(s=>s.imageQuery?images.get(s.imageQuery):undefined).find((image):image is RealImage=>!!image);return {name:fileName(page),html:shell(page.title,page.description,page.slug,sections.map(renderSection).join(""),pageHero)}});
  const refs=`<section><h2>Research sources</h2>${plan.sources.length?`<ol>${plan.sources.map(s=>`<li><a href="${escapeHtml(s.url)}" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`).join("")}</ol>`:"<p>No external research sources were used.</p>"}</section><section><h2>Image credits</h2>${images.size?`<ol>${[...images.values()].map(i=>`<li>${escapeHtml(i.title)} — ${escapeHtml(i.creator)}, ${escapeHtml(i.license)}. <a href="${escapeHtml(i.sourceUrl)}">Wikimedia Commons source</a></li>`).join("")}</ol>`:"<p>No photographs were requested for this build.</p>"}</section>`;
  htmlPages.push({name:"attributions.html",html:shell("Sources & credits","Research references and licenses for every bundled photograph.","attributions",refs)});
  const home=htmlPages.find(p=>p.name==="index.html");if(home)htmlPages.push({name:"OPEN_ME_FIRST.html",html:home.html});
  const stream=new PassThrough(),chunks:Buffer[]=[];stream.on("data",c=>chunks.push(Buffer.from(c)));const done=new Promise<Buffer>((resolve,reject)=>{stream.on("end",()=>resolve(Buffer.concat(chunks)));stream.on("error",reject)});const zip=archiver("zip",{zlib:{level:9}});zip.on("error",e=>stream.destroy(e));zip.pipe(stream);for(const p of htmlPages)zip.append(p.html,{name:p.name});await zip.finalize();const buf=await done;if(buf.length<1500)throw new Error("Website ZIP validation failed");const name=`${slug(plan.title)}_website.zip`,target=safeJoin(config.artifactDir,name);atomicWrite(target,buf);const validationReceipt=await validateBuiltArtifact(
    "website",
    prompt,
    plan,
    target,
    jobId ? { root: path.join(config.storageRoot, "diagnostics"), jobId } : undefined,
  );collectedImages.metrics.placed=placedImageQueries.size;(validationReceipt as ArtifactValidationReceipt & {images:ImageResolutionReceipt}).images=collectedImages.metrics;return{name,mime:"application/zip",path:target,size:buf.length,validationReceipt};
}

export async function buildArtifact(
  config: Config,
  kind: JobKind,
  plan: ArtifactPlan,
  prompt = "",
  jobId = "",
): Promise<BuiltFile> {
  if (kind === "presentation") return pptx(config, plan, prompt, jobId);
  if (kind === "document" || kind === "analysis" || kind === "research")
    return docx(config, plan, prompt, kind, jobId);
  if (kind === "website") return website(config, plan, prompt, jobId);
  throw new ArtifactPipelineError(
    "BUILD",
    `No deterministic builder for ${kind}`,
    { ruleOrPart: "builder-dispatch" },
  );
}
