import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import PptxGenJS from "pptxgenjs";
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Footer, PageNumber, AlignmentType, Table, TableRow, TableCell, WidthType, ImageRun } from "docx";
import archiver from "archiver";
import type { ArtifactPlan, JobKind } from "../shared/contracts.js";
import type { Config } from "./config.js";
import { atomicWrite, safeJoin } from "./files.js";
import { chartPng, chartSvg, diagramPng, diagramSvg } from "./visuals.js";
import { fetchCommonsImage, type RealImage } from "./real-images.js";

export interface BuiltFile { name:string; mime:string; path:string; size:number; }
const slug=(s:string)=>s.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,80)||"artifact";
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function collectImages(plan:ArtifactPlan,limit=10):Promise<Map<string,RealImage>>{
  const queries=[...new Set(plan.sections.map(s=>s.imageQuery).filter((q):q is string=>!!q))].slice(0,limit);
  const images=new Map<string,RealImage>();
  for(const [index,query] of queries.entries()){
    try{images.set(query,await fetchCommonsImage(query));}catch{/* A missing optional photo must not destroy an otherwise valid artifact. */}
    if(index<queries.length-1)await wait(450);
  }
  return images;
}

const imageDataUri=(image:RealImage)=>`data:${image.mime};base64,${image.bytes.toString("base64")}`;

async function pptx(config:Config,plan:ArtifactPlan):Promise<BuiltFile>{
  const images=await collectImages(plan,8);
  const p=new PptxGenJS(); p.layout="LAYOUT_WIDE"; p.author="Agent Díaz"; p.subject=plan.title; p.title=plan.title;
  p.theme={headFontFace:"Aptos Display",bodyFontFace:"Aptos"};
  const bg="F7F3EA", ink="15202B", gold="C99A2E", navy="17324D", muted="5A6772";
  const title=p.addSlide(); title.background={color:navy};
  title.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:.12,fill:{color:gold},line:{color:gold}});
  title.addText(plan.title,{x:.8,y:1.75,w:11.7,h:1.4,fontFace:"Aptos Display",fontSize:32,bold:true,color:"FFFFFF",margin:0,breakLine:false,fit:"shrink"});
  if(plan.subtitle)title.addText(plan.subtitle,{x:.82,y:3.35,w:10.8,h:.7,fontSize:16,color:"DDE6ED",margin:0,fit:"shrink"});
  for(const [i,s] of plan.sections.entries()){
    const slide=p.addSlide(); slide.background={color:bg};
    slide.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:.12,fill:{color:gold},line:{color:gold}});
    slide.addText(s.heading,{x:.65,y:.42,w:11.8,h:.65,fontSize:25,bold:true,color:navy,margin:0,fit:"shrink"});
    const lines=s.bullets.length?s.bullets:[s.body];
    const hasVisual=!!(s.chart||s.table||s.diagram);slide.addText(lines.map((t,j)=>({text:t,options:{bullet:s.bullets.length?{indent:18}:undefined,breakLine:j<lines.length-1}})),{x:.75,y:1.35,w:hasVisual?5.25:11.7,h:5.25,fontSize:hasVisual?14:17,color:ink,breakLine:false,margin:.08,paraSpaceAfter:9,fit:"shrink",valign:"top"});
    if(s.chart){const png=await chartPng(s.chart);slide.addImage({data:`data:image/png;base64,${png.toString("base64")}`,x:6.25,y:1.35,w:6.35,h:4.25});}
    else if(s.diagram){const png=await diagramPng(s.diagram);slide.addImage({data:`data:image/png;base64,${png.toString("base64")}`,x:6.15,y:1.55,w:6.45,h:3.1});}
    else if(s.table){const rows=[s.table.headers,...s.table.rows].map(row=>row.map(text=>({text})));slide.addTable(rows,{x:6.05,y:1.5,w:6.55,h:4.6,border:{type:"solid",color:"C7D0D6",pt:1},fill:{color:"FFFFFF"},color:ink,fontSize:10,margin:.05,bold:false,rowH:.4});slide.addText(s.table.title,{x:6.1,y:1.17,w:6.2,h:.25,fontSize:12,bold:true,color:navy,margin:0});}
    else if(s.imageQuery&&images.has(s.imageQuery)){const image=images.get(s.imageQuery)!;slide.addImage({data:imageDataUri(image),x:6.15,y:1.35,w:6.45,h:4.7});slide.addText(`${image.title} · ${image.creator} · ${image.license}`,{x:6.2,y:6.18,w:6.2,h:.35,fontSize:7,color:muted,fit:"shrink",margin:0});}
    slide.addText(`${i+1} / ${plan.sections.length}`,{x:11.8,y:7.08,w:.8,h:.2,fontSize:9,color:muted,align:"right",margin:0});
    if(s.speakerNotes)slide.addNotes(s.speakerNotes);
  }
  if(plan.sources.length){ const s=p.addSlide();s.background={color:bg};s.addText("Sources",{x:.65,y:.42,w:11.8,h:.6,fontSize:25,bold:true,color:navy,margin:0});s.addText(plan.sources.slice(0,18).map((x,i)=>({text:`${i+1}. ${x.title} — ${x.url}`,options:{breakLine:i<plan.sources.length-1}})),{x:.75,y:1.25,w:11.7,h:5.8,fontSize:10,color:ink,fit:"shrink",margin:.06}); }
  const name=`${slug(plan.title)}.pptx`, target=safeJoin(config.artifactDir,name);
  const buf=Buffer.from(await p.write({outputType:"nodebuffer"}) as ArrayBuffer); if(buf.length<5000)throw new Error("PPTX validation failed: output too small"); atomicWrite(target,buf);
  return{name,mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",path:target,size:buf.length};
}

async function docx(config:Config,plan:ArtifactPlan):Promise<BuiltFile>{
  const images=await collectImages(plan,8);
  const children:Paragraph[]=[new Paragraph({text:plan.title,heading:HeadingLevel.TITLE,alignment:AlignmentType.CENTER}),...(plan.subtitle?[new Paragraph({children:[new TextRun({text:plan.subtitle,italics:true,color:"5A6772"})],alignment:AlignmentType.CENTER})]:[])];
  for(const s of plan.sections){children.push(new Paragraph({text:s.heading,heading:HeadingLevel.HEADING_1}),new Paragraph({text:s.body}));for(const b of s.bullets)children.push(new Paragraph({text:b,bullet:{level:0}}));if(s.table){children.push(new Paragraph({children:[new TextRun({text:s.table.title,bold:true})]}),new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:[new TableRow({children:s.table.headers.map(h=>new TableCell({children:[new Paragraph({children:[new TextRun({text:h,bold:true})]})]}))}),...s.table.rows.map(row=>new TableRow({children:row.map(v=>new TableCell({children:[new Paragraph(v)]}))}))]}) as any);}if(s.chart){const png=await chartPng(s.chart);children.push(new Paragraph({children:[new ImageRun({data:png,transformation:{width:620,height:347},type:"png"})],alignment:AlignmentType.CENTER}));}else if(s.diagram){const png=await diagramPng(s.diagram);children.push(new Paragraph({children:[new ImageRun({data:png,transformation:{width:620,height:260},type:"png"})],alignment:AlignmentType.CENTER}));}else if(s.imageQuery&&images.has(s.imageQuery)){const image=images.get(s.imageQuery)!;children.push(new Paragraph({children:[new ImageRun({data:image.bytes,transformation:{width:620,height:400},type:image.extension as "jpg"|"png"})],alignment:AlignmentType.CENTER}),new Paragraph({children:[new TextRun({text:`${image.title} — ${image.creator} · ${image.license}`,italics:true,color:"5A6772"})],alignment:AlignmentType.CENTER}));}}
  if(plan.sources.length){children.push(new Paragraph({text:"Sources",heading:HeadingLevel.HEADING_1}));plan.sources.forEach(x=>children.push(new Paragraph({text:`${x.title}. ${x.url}`})));}
  const d=new Document({creator:"Agent Díaz",title:plan.title,sections:[{properties:{},footers:{default:new Footer({children:[new Paragraph({children:[new TextRun("Agent Díaz  •  "),new TextRun({children:[PageNumber.CURRENT]})],alignment:AlignmentType.CENTER})]})},children}]});
  const buf=await Packer.toBuffer(d); if(buf.length<3000)throw new Error("DOCX validation failed: output too small"); const name=`${slug(plan.title)}.docx`,target=safeJoin(config.artifactDir,name);atomicWrite(target,buf);
  return{name,mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",path:target,size:buf.length};
}

async function website(config:Config,plan:ArtifactPlan):Promise<BuiltFile>{
  const css=`:root{--ink:#17202a;--gold:#c99a2e;--paper:#f7f3ea;--navy:#17324d;--white:#fff}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;color:var(--ink);background:var(--paper);line-height:1.65}nav{position:sticky;top:0;z-index:5;display:flex;gap:1.2rem;align-items:center;padding:1rem 6vw;background:#101d29;color:white;box-shadow:0 3px 18px #0003}nav strong{margin-right:auto}nav a{color:white;text-decoration:none}nav a[aria-current=page]{color:#f1c65b;border-bottom:2px solid}.hero{background:var(--navy);color:white;padding:5rem 6vw;border-top:8px solid var(--gold)}.hero h1{font-size:clamp(2.4rem,6vw,5rem);line-height:1;margin:0;max-width:16ch}.hero p{font-size:1.2rem;max-width:55ch;color:#dce6ee}main{max-width:1120px;margin:auto;padding:3rem 6vw}section{padding:2.5rem 0;border-bottom:1px solid #d9d2c2}h2{color:var(--navy);font-size:clamp(1.7rem,3vw,2.4rem)}li{margin:.5rem 0}a{color:#815e09}figure{margin:2rem 0}.photo{background:white;padding:.65rem;border-radius:18px;box-shadow:0 10px 35px #12202b1b}.photo img{width:100%;max-height:620px;object-fit:cover;display:block;border-radius:12px}.photo figcaption{font-size:.8rem;color:#54616c;padding:.55rem .25rem 0}.viz svg{width:100%;height:auto;display:block;box-shadow:0 10px 35px #12202b1b;border-radius:18px}.table{overflow:auto;background:white;border-radius:12px;box-shadow:0 8px 25px #12202b14}table{border-collapse:collapse;width:100%;min-width:560px}th,td{padding:.8rem 1rem;border-bottom:1px solid #dbe2e6;text-align:left}th{background:var(--navy);color:white}footer{padding:2rem 6vw;background:#101d29;color:#ccd6df}footer a{color:#f1c65b}@media(max-width:720px){nav{align-items:flex-start;flex-wrap:wrap}.hero{padding-top:3rem}nav strong{width:100%}}`;
  const thirds=[0,1,2].map(i=>plan.sections.filter((_,j)=>j%3===i));
  const pages=plan.pages??[
    {slug:"index",title:"Home",description:plan.subtitle,sectionHeadings:thirds[0]!.map(s=>s.heading)},
    {slug:"insights",title:"Insights",description:"Key evidence and findings",sectionHeadings:thirds[1]!.map(s=>s.heading)},
    {slug:"resources",title:"Resources",description:"Practical details and references",sectionHeadings:thirds[2]!.map(s=>s.heading)}
  ];
  const images=await collectImages(plan,12);
  const requestedPhotos=new Set(plan.sections.map(s=>s.imageQuery).filter(Boolean)).size;
  if(requestedPhotos>0&&images.size<Math.min(3,requestedPhotos))throw new Error(`Website photography validation failed: retrieved ${images.size} of ${requestedPhotos} requested licensed images`);
  const fileName=(page:(typeof pages)[number])=>page.slug==="index"?"index.html":`${page.slug}.html`;
  const nav=(active:string)=>`<nav aria-label="Primary"><strong>${escapeHtml(plan.title)}</strong>${pages.map(p=>`<a href="${fileName(p)}"${p.slug===active?' aria-current="page"':""}>${escapeHtml(p.title)}</a>`).join("")}<a href="attributions.html"${active==="attributions"?' aria-current="page"':""}>Credits</a></nav>`;
  const renderSection=(s:ArtifactPlan["sections"][number])=>{const img=s.imageQuery?images.get(s.imageQuery):undefined;return `<section><h2>${escapeHtml(s.heading)}</h2>${img?`<figure class="photo"><img src="${imageDataUri(img)}" alt="${escapeHtml(img.title)}" loading="lazy"><figcaption>${escapeHtml(img.title)} — ${escapeHtml(img.creator)} · ${escapeHtml(img.license)} · <a href="${escapeHtml(img.sourceUrl)}">source</a></figcaption></figure>`:""}<p>${escapeHtml(s.body)}</p>${s.bullets.length?`<ul>${s.bullets.map(b=>`<li>${escapeHtml(b)}</li>`).join("")}</ul>`:""}${s.table?`<figure><figcaption>${escapeHtml(s.table.title)}</figcaption><div class="table"><table><thead><tr>${s.table.headers.map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${s.table.rows.map(r=>`<tr>${r.map(v=>`<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></figure>`:""}${s.chart?`<figure class="viz">${chartSvg(s.chart)}</figure>`:""}${s.diagram?`<figure class="viz">${diagramSvg(s.diagram)}</figure>`:""}</section>`};
  const shell=(title:string,description:string,active:string,body:string)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)} · ${escapeHtml(plan.title)}</title><style>${css}</style></head><body>${nav(active)}<header class="hero"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></header><main>${body}</main><footer>Created with Agent Díaz · <a href="attributions.html">Sources and image credits</a></footer></body></html>`;
  const htmlPages=pages.map(page=>{const wanted=new Set(page.sectionHeadings);const sections=plan.sections.filter(s=>wanted.has(s.heading));return {name:fileName(page),html:shell(page.title,page.description,page.slug,sections.map(renderSection).join(""))}});
  const refs=`<section><h2>Research sources</h2>${plan.sources.length?`<ol>${plan.sources.map(s=>`<li><a href="${escapeHtml(s.url)}" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`).join("")}</ol>`:"<p>No external research sources were used.</p>"}</section><section><h2>Image credits</h2>${images.size?`<ol>${[...images.values()].map(i=>`<li>${escapeHtml(i.title)} — ${escapeHtml(i.creator)}, ${escapeHtml(i.license)}. <a href="${escapeHtml(i.sourceUrl)}">Wikimedia Commons source</a></li>`).join("")}</ol>`:"<p>No photographs were requested for this build.</p>"}</section>`;
  htmlPages.push({name:"attributions.html",html:shell("Sources & credits","Research references and licenses for every bundled photograph.","attributions",refs)});
  const home=htmlPages.find(p=>p.name==="index.html");if(home)htmlPages.push({name:"OPEN_ME_FIRST.html",html:home.html});
  const stream=new PassThrough(),chunks:Buffer[]=[];stream.on("data",c=>chunks.push(Buffer.from(c)));const done=new Promise<Buffer>((resolve,reject)=>{stream.on("end",()=>resolve(Buffer.concat(chunks)));stream.on("error",reject)});const zip=archiver("zip",{zlib:{level:9}});zip.on("error",e=>stream.destroy(e));zip.pipe(stream);for(const p of htmlPages)zip.append(p.html,{name:p.name});await zip.finalize();const buf=await done;if(buf.length<1500)throw new Error("Website ZIP validation failed");const name=`${slug(plan.title)}_website.zip`,target=safeJoin(config.artifactDir,name);atomicWrite(target,buf);return{name,mime:"application/zip",path:target,size:buf.length};
}

export async function buildArtifact(config:Config,kind:JobKind,plan:ArtifactPlan):Promise<BuiltFile>{
  if(kind==="presentation")return pptx(config,plan); if(kind==="document"||kind==="analysis"||kind==="research")return docx(config,plan); if(kind==="website")return website(config,plan); throw new Error(`No deterministic builder for ${kind}`);
}
