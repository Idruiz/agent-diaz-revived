import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import PptxGenModule from "pptxgenjs";
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Footer, Header, PageNumber, AlignmentType, Table, TableRow, TableCell, WidthType, ImageRun, ShadingType, BorderStyle, VerticalAlign, TableLayoutType, LevelFormat } from "docx";
import archiver from "archiver";
import type { ArtifactPlan, JobKind } from "../shared/contracts.js";
import type { Config } from "./config.js";
import { atomicWrite, safeJoin } from "./files.js";
import { chartPng, chartSvg, diagramPng, diagramSvg } from "./visuals.js";
import { fetchCommonsImage, type RealImage } from "./real-images.js";
import { log } from "./log.js";

const PptxGenJS=((PptxGenModule as any).default??PptxGenModule) as typeof PptxGenModule;

export interface BuiltFile { name:string; mime:string; path:string; size:number; }
const slug=(s:string)=>s.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,80)||"artifact";
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function collectImages(plan:ArtifactPlan,limit=10):Promise<Map<string,RealImage>>{
  const queries=[...new Set(plan.sections.map(s=>s.imageQuery).filter((q):q is string=>!!q))].slice(0,limit);
  const images=new Map<string,RealImage>(),failed:string[]=[];
  for(let start=0;start<queries.length;start+=2){
    await Promise.all(queries.slice(start,start+2).map(async(query,offset)=>{
      const index=start+offset;
      try{
        images.set(query,await fetchCommonsImage(query));
        log("info","artifact.image_retrieved",{query,index:index+1,total:queries.length});
      }catch(error){
        failed.push(query);
        log("warn","artifact.image_retrieval_failed",{query,error:error instanceof Error?error.message:String(error)});
      }
    }));
    if(start+2<queries.length)await wait(800);
  }
  for(const query of failed){
    if(images.has(query))continue;
    await wait(1200);
    try{
      images.set(query,await fetchCommonsImage(query));
      log("info","artifact.image_retry_retrieved",{query,total:queries.length});
    }catch(error){
      log("warn","artifact.image_retry_failed",{query,error:error instanceof Error?error.message:String(error)});
    }
  }
  return images;
}

const imageDataUri=(image:RealImage)=>`data:${image.mime};base64,${image.bytes.toString("base64")}`;
const isSourcesHeading=(heading:string)=>/^(sources|references|bibliography|works cited)$/i.test(heading.trim());
const short=(value:string,max:number)=>value.length<=max?value:`${value.slice(0,Math.max(1,max-1)).trimEnd()}…`;

function noteBlock(notes:string|undefined,sources:string[]):string{
  return [notes?.trim(),sources.length?`[Sources]\n${sources.map(source=>`- ${source}`).join("\n")}`:""]
    .filter(Boolean)
    .join("\n\n");
}

async function pptx(config:Config,plan:ArtifactPlan):Promise<BuiltFile>{
  const contentSections=plan.sections.filter(section=>!isSourcesHeading(section.heading));
  const images=await collectImages({...plan,sections:contentSections},10);
  const requestedImages=contentSections.filter(section=>section.imageQuery).length;
  if(requestedImages>=3&&images.size<Math.min(3,requestedImages))
    throw new Error(`Presentation photography validation failed: retrieved ${images.size} of ${requestedImages} requested licensed images`);
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
  const addNativeChart=(slide:any,section:ArtifactPlan["sections"][number])=>{
    const chart=section.chart!,type=chart.type==="donut"?"doughnut":chart.type;
    slide.addText(short(chart.title,120),{x:.82,y:1.42,w:11.4,h:.36,fontSize:17,bold:true,color:navy,margin:0,fit:"shrink"});
    slide.addChart(type,chart.series.map(series=>({name:series.name,labels:chart.labels,values:series.values})),{
      x:.82,y:1.92,w:8.65,h:4.72,
      chartColors:[gold,blue,"70A37F","C8664F","8067A8"],
      showLegend:chart.series.length>1||["pie","donut"].includes(chart.type),
      legendPos:"b",legendFontFace:"Aptos",legendFontSize:11,
      showValue:true,showPercent:["pie","donut"].includes(chart.type),
      dataLabelPosition:["pie","donut"].includes(chart.type)?"bestFit":"outEnd",
      dataLabelColor:navy,dataLabelFontFace:"Aptos",dataLabelFontSize:11,dataLabelFontBold:true,
      catAxisLabelFontFace:"Aptos",catAxisLabelFontSize:12,catAxisLabelColor:navy,
      valAxisLabelFontFace:"Aptos",valAxisLabelFontSize:10,valAxisLabelColor:muted,
      valGridLine:{color:"DCE2E6",size:.7},catAxisLineColor:"BAC4CA",valAxisLineColor:"BAC4CA",
      chartArea:{fill:{color:bg,transparency:100},border:{color:bg,transparency:100}},
      plotArea:{fill:{color:white,transparency:100},border:{color:white,transparency:100}},
      showTitle:false,
    });
    slide.addShape(p.ShapeType.roundRect,{x:9.72,y:2.06,w:2.82,h:2.15,rectRadius:.06,fill:{color:pale},line:{color:pale}});
    slide.addText(short(section.body,260),{x:9.98,y:2.34,w:2.3,h:1.55,fontSize:16,bold:true,color:navy,margin:0,fit:"shrink",valign:"mid"});
    if(chart.sourceNote)slide.addText(short(chart.sourceNote,180),{x:.84,y:6.62,w:8.7,h:.22,fontSize:8,color:muted,margin:0,fit:"shrink"});
  };
  const addNativeDiagram=(slide:any,section:ArtifactPlan["sections"][number])=>{
    const diagram=section.diagram!,nodes=diagram.nodes.slice(0,8),columns=Math.min(4,nodes.length),rows=Math.ceil(nodes.length/columns),boxW=2.55,boxH=1.05,gapX=.42,gapY=.75,startX=(13.333-(columns*boxW+(columns-1)*gapX))/2,startY=2.05;
    slide.addText(short(diagram.title,120),{x:.82,y:1.42,w:11.4,h:.36,fontSize:17,bold:true,color:navy,align:"center",margin:0,fit:"shrink"});
    for(let index=0;index<nodes.length-1;index++){
      const row=Math.floor(index/columns),col=index%columns,nextRow=Math.floor((index+1)/columns),nextCol=(index+1)%columns;
      const x=startX+col*(boxW+gapX),y=startY+row*(boxH+gapY),nx=startX+nextCol*(boxW+gapX),ny=startY+nextRow*(boxH+gapY);
      if(row===nextRow)slide.addShape(p.ShapeType.line,{x:x+boxW,y:y+boxH/2,w:gapX,h:0,line:{color:blue,pt:2.2,endArrowType:"triangle"}});
      else slide.addShape(p.ShapeType.line,{x:x+boxW/2,y:y+boxH,w:nx+boxW/2-(x+boxW/2),h:ny-y-boxH,line:{color:blue,pt:2.2,endArrowType:"triangle"}});
    }
    nodes.forEach((node,index)=>{const row=Math.floor(index/columns),col=index%columns,x=startX+col*(boxW+gapX),y=startY+row*(boxH+gapY);slide.addShape(p.ShapeType.roundRect,{x,y,w:boxW,h:boxH,rectRadius:.05,fill:{color:index%2?pale:"F1E5C5"},line:{color:gold,pt:1.2},shadow:{type:"outer",color:"000000",opacity:.1,blur:1,angle:45,distance:.5}});slide.addText(short(node,52),{x:x+.18,y:y+.16,w:boxW-.36,h:boxH-.32,fontSize:17,bold:true,color:navy,align:"center",valign:"mid",margin:0,fit:"shrink"});});
    if(diagram.caption||section.body)slide.addText(short(diagram.caption||section.body,320),{x:1.2,y:rows===1?4.34:5.62,w:10.9,h:.72,fontSize:18,color:muted,align:"center",margin:0,fit:"shrink"});
  };
  const addNativeTable=(slide:any,section:ArtifactPlan["sections"][number])=>{
    const table=section.table!,headers=table.headers.map(text=>({text,options:{bold:true,color:white,fill:{color:navy},margin:.08}})),rows=table.rows.slice(0,16).map((row,rowIndex)=>row.map(text=>({text:short(text,160),options:{fill:{color:rowIndex%2?"F2F5F6":white},color:ink,margin:.07}})));
    slide.addText(short(table.title,120),{x:.78,y:1.4,w:11.6,h:.36,fontSize:17,bold:true,color:navy,margin:0,fit:"shrink"});
    slide.addTable([headers,...rows],{x:.78,y:1.88,w:11.78,h:4.86,border:{type:"solid",color:"CCD4D9",pt:.7},fontFace:"Aptos",fontSize:11,rowH:.32,margin:.06,valign:"middle",autoFit:false});
  };
  const title=p.addSlide(); title.background={color:navy};
  title.addShape(p.ShapeType.rect,{x:0,y:0,w:.18,h:7.5,fill:{color:gold},line:{color:gold}});
  title.addShape(p.ShapeType.arc,{x:9.15,y:.35,w:3.65,h:3.65,rotate:18,fill:{color:gold,transparency:78},line:{color:gold,transparency:100}});
  title.addText("VISUAL BRIEF",{x:.82,y:1.06,w:2.8,h:.24,fontSize:10,bold:true,charSpacing:2,color:gold,margin:0});
  title.addText(short(plan.title,130),{x:.82,y:1.55,w:10.6,h:1.65,fontFace:"Aptos Display",fontSize:42,bold:true,color:white,margin:0,breakLine:false,fit:"shrink",valign:"middle"});
  if(plan.subtitle)title.addText(short(plan.subtitle,220),{x:.85,y:3.62,w:8.9,h:.92,fontSize:20,color:"DDE6ED",margin:0,fit:"shrink"});
  title.addText(`${contentSections.length} ideas · ${images.size} licensed visuals`,{x:.85,y:6.72,w:4.8,h:.22,fontSize:9,bold:true,charSpacing:.8,color:"B9C8D3",margin:0});
  title.addNotes(noteBlock("Opening slide",[]));
  for(const [index,section] of contentSections.entries()){
    const slide=p.addSlide(),slideNumber=index+2;slide.background={color:bg};
    slide.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:.1,fill:{color:gold},line:{color:gold}});
    addHeading(slide,section.heading,`Part ${String(index+1).padStart(2,"0")}`);
    const image=section.imageQuery?images.get(section.imageQuery):undefined;
    if(section.chart)addNativeChart(slide,section);
    else if(section.table)addNativeTable(slide,section);
    else if(section.diagram)addNativeDiagram(slide,section);
    else if(image){
      const fullBleed=index%4===2;
      if(fullBleed){
        slide.addImage({data:imageDataUri(image),x:0,y:0,w:13.333,h:7.5,sizing:{type:"cover",w:13.333,h:7.5},altText:image.title});
        slide.addShape(p.ShapeType.rect,{x:0,y:0,w:13.333,h:7.5,fill:{color:navy,transparency:22},line:{color:navy,transparency:100}});
        slide.addShape(p.ShapeType.rect,{x:.66,y:.66,w:6.15,h:5.62,fill:{color:navy,transparency:12},line:{color:white,transparency:100}});
        slide.addText(short(section.heading,92),{x:.98,y:1.05,w:5.55,h:1.05,fontSize:34,bold:true,color:white,margin:0,fit:"shrink"});
        addNarrative(slide,section,{x:1,y:2.3,w:5.3,h:3.35},true);
        slide.addText(short(`${image.title} · ${image.creator} · ${image.license}`,180),{x:7.05,y:7.12,w:5.5,h:.16,fontSize:6.5,color:white,align:"right",margin:0,fit:"shrink"});
      }else{
        const imageLeft=index%2===1,imageBox={x:imageLeft ? .72 : 7.02,y:1.5,w:5.58,h:4.92},textBox={x:imageLeft ? 6.72 : .78,y:1.66,w:5.45,h:4.7};
        addPhoto(slide,image,imageBox);addNarrative(slide,section,textBox);
        slide.addText(short(`${image.title} · ${image.creator} · ${image.license}`,180),{x:imageBox.x,y:6.5,w:imageBox.w,h:.2,fontSize:6.8,color:muted,margin:0,fit:"shrink"});
      }
    }else{
      slide.addText(String(index+1).padStart(2,"0"),{x:.76,y:1.55,w:2.1,h:1.3,fontSize:74,bold:true,color:"E4D7B3",margin:0});
      slide.addShape(p.ShapeType.line,{x:3.05,y:1.92,w:0,h:4.15,line:{color:gold,pt:2}});
      addNarrative(slide,section,{x:3.52,y:1.67,w:8.55,h:4.65});
    }
    addFooter(slide,slideNumber);
    const noteSources=[...(image?[image.sourceUrl]:[]),...(section.chart?.sourceNote?[section.chart.sourceNote]:[])];
    const notes=noteBlock(section.speakerNotes,noteSources);if(notes)slide.addNotes(notes);
  }
  for(const [chunkIndex,chunk] of sourceChunks.entries()){
    const slide=p.addSlide(),slideNumber=2+contentSections.length+chunkIndex;slide.background={color:bg};
    addHeading(slide,sourceChunks.length>1?`Sources ${chunkIndex+1} of ${sourceChunks.length}`:"Sources","Evidence trail");
    chunk.forEach((source,index)=>{const y=1.48+index*.66;slide.addText(String(chunkIndex*8+index+1).padStart(2,"0"),{x:.78,y,w:.42,h:.23,fontSize:10,bold:true,color:gold,margin:0});slide.addText(short(source.title,180),{x:1.35,y:y-.02,w:4.15,h:.28,fontSize:13,bold:true,color:navy,margin:0,fit:"shrink"});slide.addText(short(source.url,150),{x:5.7,y:y-.02,w:6.45,h:.3,fontSize:10,color:blue,margin:0,fit:"shrink",hyperlink:{url:source.url}});});
    addFooter(slide,slideNumber);slide.addNotes(noteBlock("",chunk.map(source=>source.url)));
  }
  const name=`${slug(plan.title)}.pptx`, target=safeJoin(config.artifactDir,name);
  const buf=Buffer.from(await p.write({outputType:"nodebuffer"}) as ArrayBuffer); if(buf.length<5000)throw new Error("PPTX validation failed: output too small"); atomicWrite(target,buf);
  return{name,mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",path:target,size:buf.length};
}

async function docx(config:Config,plan:ArtifactPlan):Promise<BuiltFile>{
  const contentSections=plan.sections.filter(section=>!isSourcesHeading(section.heading));
  const images=await collectImages({...plan,sections:contentSections},10);
  const requestedImages=contentSections.filter(section=>section.imageQuery).length;
  if(requestedImages>0&&images.size<Math.min(requestedImages,1))
    throw new Error(`Document photography validation failed: retrieved ${images.size} of ${requestedImages} requested licensed images`);
  const noBorder={style:BorderStyle.NONE,size:0,color:"FFFFFF"};
  const cellBorders={top:noBorder,bottom:{style:BorderStyle.SINGLE,size:4,color:"D9E0E4"},left:noBorder,right:noBorder,insideHorizontal:noBorder,insideVertical:noBorder};
  const tableWidths=(headers:string[],rows:string[][])=>{
    const weights=headers.map((header,column)=>Math.min(44,Math.max(8,header.length,...rows.map(row=>(row[column]||"").length)))),minimum=720,remaining=9360-minimum*weights.length,total=weights.reduce((sum,value)=>sum+value,0),widths=weights.map(weight=>minimum+Math.floor(remaining*weight/total));
    widths[widths.length-1]!+=9360-widths.reduce((sum,value)=>sum+value,0);return widths;
  };
  const imageDimensions=(image:RealImage,maxWidth=560,maxHeight=320)=>{const scale=Math.min(maxWidth/image.width,maxHeight/image.height);return{width:Math.max(1,Math.round(image.width*scale)),height:Math.max(1,Math.round(image.height*scale))}};
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
      new Paragraph({pageBreakBefore:imageStartsPage,heading:HeadingLevel.HEADING_1,keepNext:true,border:{bottom:{style:BorderStyle.SINGLE,size:8,color:"C99A2E",space:6}},children:[new TextRun({text:section.heading,bold:true,color:"2E74B5",size:32,font:"Calibri"})]}),
      new Paragraph({keepNext:true,children:[new TextRun({text:section.body,size:22,color:"17202A",font:"Calibri"})]}),
    );
    for(const bullet of section.bullets.slice(0,10))children.push(new Paragraph({text:bullet,numbering:{reference:"artifact-bullets",level:0},style:"BodyText"}));
    if(section.table){
      const sourceRows=section.table.rows.slice(0,24),widths=tableWidths(section.table.headers,sourceRows);
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
      const image=images.get(section.imageQuery)!,dimensions=imageDimensions(image);
      children.push(
        new Paragraph({spacing:{before:220,after:80},children:[new ImageRun({data:image.bytes,transformation:dimensions,type:image.extension as "jpg"|"png",altText:{title:image.title,description:`${image.title} by ${image.creator}`,name:image.title}})],alignment:AlignmentType.CENTER}),
        new Paragraph({spacing:{after:140},children:[new TextRun({text:`${image.title} — ${image.creator} · ${image.license}`,italics:true,size:15,color:"5A6772"})],alignment:AlignmentType.CENTER}),
      );
    }
  }
  if(plan.sources.length){
    children.push(new Paragraph({pageBreakBefore:true,heading:HeadingLevel.HEADING_1,children:[new TextRun({text:"Sources",bold:true,color:"17324D",size:34})]}));
    plan.sources.forEach((source,index)=>children.push(new Paragraph({spacing:{after:110},indent:{left:360,hanging:360},children:[new TextRun({text:`${index+1}. ${source.title}. `,bold:true,size:17,color:"17324D"}),new TextRun({text:source.url,size:16,color:"2F739C"})]})));
  }
  const d=new Document({
    creator:"Agent Díaz",title:plan.title,description:plan.subtitle,
    styles:{
      default:{document:{run:{font:"Calibri",size:22,color:"17202A"},paragraph:{spacing:{after:120,line:264}}}},
      paragraphStyles:[
        {id:"Heading1",name:"Heading 1",basedOn:"Normal",next:"Normal",quickFormat:true,run:{font:"Calibri",size:32,bold:true,color:"2E74B5"},paragraph:{spacing:{before:320,after:160},outlineLevel:0,keepNext:true}},
        {id:"Heading2",name:"Heading 2",basedOn:"Normal",next:"Normal",quickFormat:true,run:{font:"Calibri",size:26,bold:true,color:"2E74B5"},paragraph:{spacing:{before:240,after:120},outlineLevel:1,keepNext:true}},
        {id:"BodyText",name:"Body Text",basedOn:"Normal",quickFormat:true,run:{font:"Calibri",size:22,color:"17202A"},paragraph:{spacing:{after:160,line:280}}},
      ],
    },
    numbering:{config:[{reference:"artifact-bullets",levels:[{level:0,format:LevelFormat.BULLET,text:"•",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360},spacing:{after:160,line:280}},run:{font:"Calibri",size:22,color:"17202A"}}}]}]},
    sections:[{properties:{titlePage:true,page:{margin:{top:1440,right:1440,bottom:1440,left:1440,header:708,footer:708}}},headers:{first:new Header({children:[new Paragraph("")]}),default:new Header({children:[new Paragraph({border:{bottom:{style:BorderStyle.SINGLE,size:5,color:"D9E0E4",space:4}},children:[new TextRun({text:short(plan.title,85),bold:true,size:16,color:"5A6772",font:"Calibri"})]})]})},footers:{first:new Footer({children:[new Paragraph("")]}),default:new Footer({children:[new Paragraph({border:{top:{style:BorderStyle.SINGLE,size:5,color:"D9E0E4",space:4}},children:[new TextRun({text:"AGENT DÍAZ  ·  ",bold:true,size:14,color:"C99A2E",font:"Calibri"}),new TextRun({children:[PageNumber.CURRENT],size:14,color:"5A6772",font:"Calibri"})],alignment:AlignmentType.RIGHT})]})},children}],
  });
  const buf=await Packer.toBuffer(d); if(buf.length<3000)throw new Error("DOCX validation failed: output too small"); const name=`${slug(plan.title)}.docx`,target=safeJoin(config.artifactDir,name);atomicWrite(target,buf);
  return{name,mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",path:target,size:buf.length};
}

async function website(config:Config,plan:ArtifactPlan):Promise<BuiltFile>{
  const css=`:root{--ink:#17202a;--gold:#c99a2e;--paper:#f7f3ea;--navy:#17324d;--blue:#2f739c;--white:#fff;--muted:#5a6772}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:Inter,Aptos,system-ui,sans-serif;color:var(--ink);background:var(--paper);line-height:1.65}nav{position:sticky;top:0;z-index:5;display:flex;gap:1.35rem;align-items:center;padding:1rem 6vw;background:#101d29f7;color:white;box-shadow:0 3px 18px #0003;backdrop-filter:blur(12px)}nav strong{margin-right:auto;letter-spacing:.04em}nav a{color:white;text-decoration:none;font-weight:650}nav a[aria-current=page]{color:#f1c65b;border-bottom:2px solid}.hero{isolation:isolate;position:relative;overflow:hidden;background-color:var(--navy);background-position:center;background-size:cover;color:white;padding:clamp(5rem,10vw,8rem) 6vw;border-top:8px solid var(--gold)}.hero:before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,#10283df2 0%,#10283dc9 52%,#10283d52 100%)}.hero .eyebrow{text-transform:uppercase;letter-spacing:.18em;color:#f1c65b;font-size:.78rem;font-weight:800}.hero h1{font-size:clamp(2.8rem,6vw,5.7rem);letter-spacing:-.04em;line-height:.96;margin:.55rem 0 1rem;max-width:15ch}.hero p{font-size:clamp(1.05rem,2vw,1.3rem);max-width:56ch;color:#e0e9f0}main{max-width:1180px;margin:auto;padding:2rem 6vw 4rem}section{padding:clamp(3rem,6vw,5.5rem) 0;border-bottom:1px solid #d9d2c2}section.with-photo{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,.92fr);gap:clamp(2rem,5vw,5rem);align-items:center}.with-photo.flip .copy{order:2}.with-photo.flip .photo{order:1}.copy{min-width:0}h2{color:var(--navy);font-size:clamp(2rem,4vw,3.25rem);letter-spacing:-.035em;line-height:1.05;margin:.2rem 0 1.3rem}p{font-size:1.08rem}li{margin:.55rem 0}a{color:#815e09}.photo{margin:0;background:white;padding:.65rem;border-radius:20px;box-shadow:0 18px 55px #12202b22;transform:rotate(.35deg)}.flip .photo{transform:rotate(-.35deg)}.photo img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;border-radius:14px}.photo figcaption{font-size:.75rem;line-height:1.35;color:var(--muted);padding:.65rem .3rem .15rem}.viz,.table-wrap{grid-column:1/-1;margin:2rem 0 0}.viz svg{width:100%;height:auto;display:block;box-shadow:0 15px 45px #12202b1b;border-radius:18px}.table{overflow:auto;background:white;border-radius:14px;box-shadow:0 12px 35px #12202b14}table{border-collapse:collapse;width:100%;min-width:560px}th,td{padding:.9rem 1rem;border-bottom:1px solid #dbe2e6;text-align:left}th{background:var(--navy);color:white}footer{padding:2.4rem 6vw;background:#101d29;color:#ccd6df}footer a{color:#f1c65b}@media(max-width:760px){nav{align-items:flex-start;flex-wrap:wrap}.hero{padding-top:4rem}nav strong{width:100%}section.with-photo{display:block}.with-photo.flip .copy,.with-photo.flip .photo{order:initial}.photo{margin-top:2rem;transform:none!important}}`;
  const contentSections=plan.sections.filter(section=>!isSourcesHeading(section.heading));
  const thirds=[0,1,2].map(i=>contentSections.filter((_,j)=>j%3===i));
  const pages=plan.pages??[
    {slug:"index",title:"Home",description:plan.subtitle,sectionHeadings:thirds[0]!.map(s=>s.heading)},
    {slug:"insights",title:"Insights",description:"Key evidence and findings",sectionHeadings:thirds[1]!.map(s=>s.heading)},
    {slug:"resources",title:"Resources",description:"Practical details and references",sectionHeadings:thirds[2]!.map(s=>s.heading)}
  ];
  const images=await collectImages(plan,12);
  const requestedPhotos=new Set(contentSections.map(s=>s.imageQuery).filter(Boolean)).size;
  if(requestedPhotos>0&&images.size<Math.min(3,requestedPhotos))throw new Error(`Website photography validation failed: retrieved ${images.size} of ${requestedPhotos} requested licensed images`);
  const fileName=(page:(typeof pages)[number])=>page.slug==="index"?"index.html":`${page.slug}.html`;
  const nav=(active:string)=>`<nav aria-label="Primary"><strong>${escapeHtml(plan.title)}</strong>${pages.map(p=>`<a href="${fileName(p)}"${p.slug===active?' aria-current="page"':""}>${escapeHtml(p.title)}</a>`).join("")}<a href="attributions.html"${active==="attributions"?' aria-current="page"':""}>Credits</a></nav>`;
  const renderSection=(s:ArtifactPlan["sections"][number],index:number)=>{const img=s.imageQuery?images.get(s.imageQuery):undefined;return `<section class="${img?`with-photo${index%2?" flip":""}`:""}"><div class="copy"><h2>${escapeHtml(s.heading)}</h2><p>${escapeHtml(s.body)}</p>${s.bullets.length?`<ul>${s.bullets.map(b=>`<li>${escapeHtml(b)}</li>`).join("")}</ul>`:""}</div>${img?`<figure class="photo"><img src="${imageDataUri(img)}" alt="${escapeHtml(img.title)}" loading="lazy"><figcaption>${escapeHtml(img.title)} — ${escapeHtml(img.creator)} · ${escapeHtml(img.license)} · <a href="${escapeHtml(img.sourceUrl)}">source</a></figcaption></figure>`:""}${s.table?`<figure class="table-wrap"><figcaption>${escapeHtml(s.table.title)}</figcaption><div class="table"><table><thead><tr>${s.table.headers.map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${s.table.rows.map(r=>`<tr>${r.map(v=>`<td>${escapeHtml(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></figure>`:""}${s.chart?`<figure class="viz">${chartSvg(s.chart)}</figure>`:""}${s.diagram?`<figure class="viz">${diagramSvg(s.diagram)}</figure>`:""}</section>`};
  const fallbackHero=[...images.values()][0];
  const shell=(title:string,description:string,active:string,body:string,heroImage=fallbackHero)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHtml(description)}"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)} · ${escapeHtml(plan.title)}</title><style>${css}</style></head><body>${nav(active)}<header class="hero"${heroImage?` style="background-image:url('${imageDataUri(heroImage)}')"`:""}><div class="eyebrow">Agent Díaz field guide</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></header><main>${body}</main><footer>Created with Agent Díaz · <a href="attributions.html">Sources and image credits</a></footer></body></html>`;
  const htmlPages=pages.map(page=>{const wanted=new Set(page.sectionHeadings),sections=contentSections.filter(s=>wanted.has(s.heading)),pageHero=sections.map(s=>s.imageQuery?images.get(s.imageQuery):undefined).find((image):image is RealImage=>!!image);return {name:fileName(page),html:shell(page.title,page.description,page.slug,sections.map(renderSection).join(""),pageHero)}});
  const refs=`<section><h2>Research sources</h2>${plan.sources.length?`<ol>${plan.sources.map(s=>`<li><a href="${escapeHtml(s.url)}" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`).join("")}</ol>`:"<p>No external research sources were used.</p>"}</section><section><h2>Image credits</h2>${images.size?`<ol>${[...images.values()].map(i=>`<li>${escapeHtml(i.title)} — ${escapeHtml(i.creator)}, ${escapeHtml(i.license)}. <a href="${escapeHtml(i.sourceUrl)}">Wikimedia Commons source</a></li>`).join("")}</ol>`:"<p>No photographs were requested for this build.</p>"}</section>`;
  htmlPages.push({name:"attributions.html",html:shell("Sources & credits","Research references and licenses for every bundled photograph.","attributions",refs)});
  const home=htmlPages.find(p=>p.name==="index.html");if(home)htmlPages.push({name:"OPEN_ME_FIRST.html",html:home.html});
  const stream=new PassThrough(),chunks:Buffer[]=[];stream.on("data",c=>chunks.push(Buffer.from(c)));const done=new Promise<Buffer>((resolve,reject)=>{stream.on("end",()=>resolve(Buffer.concat(chunks)));stream.on("error",reject)});const zip=archiver("zip",{zlib:{level:9}});zip.on("error",e=>stream.destroy(e));zip.pipe(stream);for(const p of htmlPages)zip.append(p.html,{name:p.name});await zip.finalize();const buf=await done;if(buf.length<1500)throw new Error("Website ZIP validation failed");const name=`${slug(plan.title)}_website.zip`,target=safeJoin(config.artifactDir,name);atomicWrite(target,buf);return{name,mime:"application/zip",path:target,size:buf.length};
}

export async function buildArtifact(config:Config,kind:JobKind,plan:ArtifactPlan):Promise<BuiltFile>{
  if(kind==="presentation")return pptx(config,plan); if(kind==="document"||kind==="analysis"||kind==="research")return docx(config,plan); if(kind==="website")return website(config,plan); throw new Error(`No deterministic builder for ${kind}`);
}
