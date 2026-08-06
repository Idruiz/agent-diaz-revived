import fs from "node:fs";
import OpenAI from "openai";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { ArtifactPlanSchema, type JobKind } from "../shared/contracts.js";
import { buildArtifact } from "./builders.js";
import { log } from "./log.js";
import { getSkillForKind } from "./skills.js";

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

function artifactInstructions(kind:JobKind):string{
  return `Create a complete ${kind} plan. Use web search when current or factual claims benefit from verification. For analysis, use the python tool on every uploaded dataset and base all numerical claims on executed results. Return JSON only with: title, subtitle, sections[{heading,body,bullets,speakerNotes, optional imageQuery, optional table{title,headers,rows}, optional chart{title,type:bar|line|pie|donut,labels,series[{name,values}],unit,sourceNote}, optional diagram{title,nodes,caption}}], optional pages[{slug,title,description,sectionHeadings}], sources[{title,url}]. Every material factual claim must be supported. Never invent numbers. Use 7-12 sections for presentations and 5-14 otherwise. Include at least two meaningful visual elements across tables, charts, or diagrams when the evidence supports them. Do not add decorative charts without real data. Body and bullets must contain finished content, not directions or placeholders.${kind==="website"?" A website MUST define 3-6 pages with unique lowercase slugs (use index for the home page), assign every section heading to a page, and give at least four sections concrete imageQuery values for relevant documentary photographs. Do not request logos, illustrations, AI images, text-heavy graphics, or identifiable private people.":""}`;
}

function validateArtifactPlan(kind:JobKind,plan:any,minVisuals:number):void{
  const visualCount=plan.sections.filter((s:any)=>s.table||s.chart||s.diagram||s.imageQuery).length;
  if(visualCount<minVisuals)throw new Error(`Artifact plan validation failed: expected at least ${minVisuals} meaningful visuals, received ${visualCount}`);
  if(kind==="website"){
    if(!plan.pages||plan.pages.length<3)throw new Error("Website plan validation failed: at least three pages are required");
    const headings=new Set(plan.sections.map((s:any)=>s.heading));
    const assigned=new Set(plan.pages.flatMap((p:any)=>p.sectionHeadings));
    for(const heading of headings)if(!assigned.has(heading))throw new Error(`Website plan validation failed: section '${heading}' is not assigned to a page`);
    if(plan.sections.filter((s:any)=>s.imageQuery).length<4)throw new Error("Website plan validation failed: at least four documentary photo queries are required");
  }
}

export class AgentRunner {
  private client:OpenAI; private active=new Set<string>();
  constructor(private config:Config,private db:Db){this.client=new OpenAI({apiKey:config.OPENAI_API_KEY});}

  async upload(file:{path:string;name:string}):Promise<string>{const out=await this.client.files.create({file:fs.createReadStream(file.path),purpose:"assistants"});return out.id;}

  async compactConversation(conversationId:string):Promise<void>{
    const conversation=this.db.getConversation(conversationId);if(!conversation||conversation.summary)return;
    const messages=this.db.listMessages(conversationId);
    if(!messages.length){this.db.setConversationSummary(conversationId,"No conversation content was recorded.");return;}
    const transcript=messages.map(m=>`${m.role.toUpperCase()}: ${m.content}`).join("\n\n").slice(0,120_000);
    try{
      const response=await this.client.responses.create({model:this.config.OPENAI_FAST_MODEL,store:false,instructions:"Compact this completed conversation into durable archival memory. Preserve decisions, user preferences, facts, named entities, constraints, unfinished work, artifact names, and outcomes. Remove greetings, repetition, and incidental wording. Do not invent anything. Return concise plain text with a maximum of 900 words.",input:transcript} as any);
      const summary=response.output_text?.trim();if(!summary)throw new Error("Empty archive summary");this.db.setConversationSummary(conversationId,summary);
    }catch(e){
      const fallback=messages.slice(-12).map(m=>`${m.role}: ${m.content.replace(/\s+/g," ").slice(0,500)}`).join("\n");
      this.db.setConversationSummary(conversationId,`Automatic semantic compaction was unavailable. Durable extract:\n${fallback}`);log("warn","conversation.compaction_fallback",{conversationId,error:e instanceof Error?e.message:"unknown"});
    }
  }

  start(jobId:string):void{if(this.active.has(jobId))return;this.active.add(jobId);void this.run(jobId).finally(()=>this.active.delete(jobId));}

  resume():void{for(const j of this.db.listJobs(100).filter(j=>["queued","running","building"].includes(j.status)))this.start(j.id);}

  async cancel(jobId:string):Promise<void>{const id=this.db.getProviderResponseId(jobId);if(id){try{await this.client.responses.cancel(id);}catch{}}this.db.updateJob(jobId,{status:"cancelled",message:"Cancelled by user"});}

  private mcpTool():any{
    if(!this.config.MCP_SERVER_URL)throw new Error("MCP is not configured");
    return {type:"mcp",server_label:this.config.MCP_SERVER_LABEL,server_url:this.config.MCP_SERVER_URL,server_description:"User-authorized workspace tools. External writes require approval.",...(this.config.MCP_AUTHORIZATION?{authorization:this.config.MCP_AUTHORIZATION}:{}),require_approval:"always"};
  }

  async continueApproval(approvalId:string,decision:"approved"|"rejected"):Promise<void>{
    const approval=this.db.getApproval(approvalId);
    if(!approval)throw new Error("Approval not found");
    if(approval.status!=="pending")throw new Error("Approval was already decided");
    this.db.decideApproval(approvalId,decision);
    const decisions=this.db.raw.prepare("SELECT status,provider_item_id providerItemId,provider_response_id providerResponseId FROM approvals WHERE job_id=? ORDER BY created_at").all(approval.jobId) as Array<{status:string;providerItemId:string;providerResponseId:string}>;
    if(decisions.some(d=>d.status==="pending")){this.db.updateJob(approval.jobId,{status:"waiting_approval",message:"Waiting for the remaining approval decisions"});return;}
    const response=await this.client.responses.create({
      model:this.config.OPENAI_MODEL,
      previous_response_id:approval.providerResponseId,
      tools:[this.mcpTool()],
      input:decisions.map(d=>({type:"mcp_approval_response",approval_request_id:d.providerItemId,approve:d.status==="approved"})),
      background:true,
      store:true
    } as any);
    this.db.updateJob(approval.jobId,{providerResponseId:response.id,status:"running",progress:45,message:decision==="approved"?"Approved action is continuing":"Rejection recorded; Díaz is continuing safely"});
    this.start(approval.jobId);
  }

  private captureApproval(jobId:string,response:any):boolean{
    const requests=(response.output??[]).filter((item:any)=>item?.type==="mcp_approval_request");
    if(!requests.length)return false;
    if(this.db.listApprovals(jobId).some(a=>a.status==="pending"))return true;
    for(const item of requests){
      this.db.createApproval({id:crypto.randomUUID(),jobId,tool:`${item.server_label??"MCP"}: ${item.name??"external action"}`,summary:"An external tool wants to perform this action. Review the exact arguments before approving once.",argumentsJson:typeof item.arguments==="string"?item.arguments:JSON.stringify(item.arguments??{}),providerItemId:item.id,providerResponseId:response.id});
    }
    this.db.updateJob(jobId,{status:"waiting_approval",progress:40,message:"Waiting for your approval"});
    return true;
  }

  private async run(jobId:string):Promise<void>{
    const job=this.db.getJob(jobId);if(!job||["completed","cancelled"].includes(job.status))return;
    try{
      this.db.updateJob(jobId,{status:"running",progress:10,message:"Agent is working"});
      let rid=this.db.getProviderResponseId(jobId);let response:any;
      if(rid){response=await this.client.responses.retrieve(rid);}else{
        const skill=getSkillForKind(job.kind);
        const uploadRows=this.db.raw.prepare("SELECT file_ids_json FROM jobs WHERE id=?").get(jobId) as any;
        const ids:string[]=JSON.parse(uploadRows.file_ids_json);const uploads=this.db.getUploads(ids);
        const tools:any[]=[];if(skill.tools.includes("web_search"))tools.push({type:"web_search"});if(skill.tools.includes("python"))tools.push({type:"code_interpreter",container:{type:"auto",file_ids:uploads.map(u=>u.openaiFileId)}});
        if(skill.tools.includes("mcp")&&this.config.MCP_SERVER_URL)tools.push(this.mcpTool());
        const artifactKinds=["research","analysis","presentation","document","website"];const instructions=["You are Agent Díaz, a careful autonomous work agent. Complete read-only work autonomously. Never claim an action succeeded without a tool result. External writes require explicit approval. State uncertainty and never fabricate evidence.",`ACTIVE SKILL: ${skill.name}\n${skill.instructions}\nValidation: ${skill.validation.join("; ")}`,...artifactKinds.includes(job.kind)?[artifactInstructions(job.kind)]:[]].join("\n\n");
        const messages=this.db.listMessages(job.conversationId);
        const archives=this.db.listArchiveSummaries(20);
        const prior=messages.filter(m=>m.jobId!==job.id).map(m=>({role:m.role,content:m.content}));
        const archiveContext=archives.length?`ARCHIVAL MEMORY FROM OLDER CONVERSATIONS (use only when relevant; never claim it was said in this conversation):\n${archives.map(a=>`[${a.title}] ${a.summary}`).join("\n\n")}`:"";
        const continuity=`Maintain continuity with every prior turn in this conversation. Answer the newest request, build on established decisions, and do not repeat an answer already given unless the user asks for repetition. If correcting an earlier answer, identify the change. ${archiveContext}`;
        response=await this.client.responses.create({model:this.config.OPENAI_MODEL,instructions:`${instructions}\n\n${continuity}`,input:[...prior,{role:"user",content:job.prompt}],tools,background:true,store:true,...(artifactKinds.includes(job.kind)?{text:{format:{type:"json_object"}}}:{})} as any);
        rid=response.id;this.db.updateJob(jobId,{providerResponseId:rid,progress:25,message:"Background response started"});
      }
      while(["queued","in_progress"].includes(response.status)){await sleep(1800);if(this.db.getJob(jobId)?.status==="cancelled")return;response=await this.client.responses.retrieve(rid!);this.db.updateJob(jobId,{progress:Math.min(75,(this.db.getJob(jobId)?.progress??25)+3),message:`Agent status: ${response.status}`});}
      if(this.captureApproval(jobId,response))return;
      if(response.status!=="completed")throw new Error(`Provider response ended with status ${response.status}`);
      const output=response.output_text?.trim()||"";
      if(["research","analysis","presentation","document","website"].includes(job.kind)){
        this.db.updateJob(jobId,{status:"building",progress:82,message:"Building and validating artifact"});
        const raw=JSON.parse(output.replace(/^```json\s*|```$/g,""));const plan=ArtifactPlanSchema.parse(raw);validateArtifactPlan(job.kind,plan,getSkillForKind(job.kind).minVisuals);const file=await buildArtifact(this.config,job.kind,plan);const id=crypto.randomUUID();this.db.addArtifact({id,jobId,name:file.name,mime:file.mime,size:file.size,path:file.path});
      }
      const userOutput=["research","analysis","presentation","document","website"].includes(job.kind)?`Completed ${job.kind} artifact: ${this.db.listArtifacts(jobId).map(a=>a.name).join(", ")}. The finished file is ready to download.`:output;
      this.db.updateJob(jobId,{status:"completed",progress:100,message:"Completed",outputText:userOutput,error:null});log("info","job.completed",{jobId,kind:job.kind});
      this.db.addMessage({id:crypto.randomUUID(),conversationId:job.conversationId,role:"assistant",content:userOutput,jobId});
    }catch(e:any){const message=e instanceof Error?e.message:"Unknown job failure";this.db.updateJob(jobId,{status:"failed",message:"Failed",error:message});log("error","job.failed",{jobId,error:message});}
  }
}
