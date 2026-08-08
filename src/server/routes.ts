import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { AgentRunner } from "./openai-agent.js";
import { CreateJobSchema, CreateConversationSchema, ApprovalDecisionSchema } from "../shared/contracts.js";
import { safeJoin } from "./files.js";
import { skills } from "./skills.js";

export function apiRoutes(config:Config,db:Db,runner:AgentRunner,auth:ReturnType<typeof import("./auth.js").createAuth>):Router{
  const r=Router();r.use(auth.verifyOrigin);
  r.post("/login",(req,res)=>{const password=String(req.body?.password||"");if(!auth.login(password,res))return res.status(401).json({error:"Invalid credentials"});res.json({ok:true});});
  r.post("/logout",auth.requireAuth,(req,res)=>{auth.logout(req,res);res.json({ok:true});});
  r.get("/session",(req,res)=>auth.requireAuth(req,res,()=>res.json({authenticated:true})));
  r.use(auth.requireAuth);
  r.get("/skills",(_req,res)=>res.json(skills.map(({instructions,...publicSkill})=>publicSkill)));
  r.get("/conversations",(_req,res)=>res.json(db.listConversations()));
  r.post("/conversations",async(req,res,next)=>{try{const p=CreateConversationSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:"Invalid conversation"});const c=db.createConversation(crypto.randomUUID(),p.data.title||"New conversation");const archived=db.archiveOverflow();for(const old of archived)await runner.compactConversation(old.id);res.status(201).json(c);}catch(e){next(e)}});
  r.get("/conversations/:id",(req,res)=>{const c=db.getConversation(req.params.id);if(!c)return res.status(404).json({error:"Conversation not found"});res.json({...c,messages:db.listMessages(c.id)});});
  const upload=multer({storage:multer.diskStorage({destination:config.uploadDir,filename:(_req,file,cb)=>cb(null,`${crypto.randomUUID()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g,"_")}`)}),limits:{fileSize:config.MAX_UPLOAD_MB*1024*1024,files:10}});
  r.post("/uploads",upload.array("files",10),async(req,res,next)=>{try{const rows=[];for(const f of (req.files as Express.Multer.File[]||[])){const openaiFileId=await runner.upload({path:f.path,name:f.originalname});const id=crypto.randomUUID();db.addUpload({id,name:f.originalname,mime:f.mimetype,size:f.size,path:f.path,openaiFileId});rows.push({id,name:f.originalname,mime:f.mimetype,size:f.size});}res.status(201).json(rows);}catch(e){next(e);}});
  r.get("/jobs",(_req,res)=>res.json(db.listJobs()));
  r.post("/jobs",(req,res)=>{const parsed=CreateJobSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:"Invalid job",details:parsed.error.issues});if(!parsed.data.conversationId)return res.status(400).json({error:"conversationId is required"});const active=db.raw.prepare("SELECT 1 FROM jobs WHERE conversation_id=? AND status IN ('queued','running','waiting_approval','building')").get(parsed.data.conversationId);if(active)return res.status(409).json({error:"This conversation already has an active task"});const j=db.createJob({id:crypto.randomUUID(),kind:parsed.data.kind,prompt:parsed.data.prompt,conversationId:parsed.data.conversationId,fileIds:parsed.data.fileIds});runner.start(j.id);res.status(202).json(j);});
  r.get("/jobs/:id",(req,res)=>{const j=db.getJob(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});res.json({...j,artifacts:db.listArtifacts(j.id),approvals:db.listApprovals(j.id)});});
  r.post("/jobs/:id/retry",(req,res)=>{const original=db.getJob(req.params.id);if(!original)return res.status(404).json({error:"Job not found"});if(!["failed","cancelled"].includes(original.status))return res.status(409).json({error:"Only failed or cancelled tasks can be retried"});const active=db.raw.prepare("SELECT 1 FROM jobs WHERE conversation_id=? AND status IN ('queued','running','waiting_approval','building')").get(original.conversationId);if(active)return res.status(409).json({error:"This conversation already has an active task"});const row=db.raw.prepare("SELECT file_ids_json fileIdsJson FROM jobs WHERE id=?").get(original.id) as {fileIdsJson:string};const j=db.createJob({id:crypto.randomUUID(),kind:original.kind,prompt:original.prompt,conversationId:original.conversationId,fileIds:JSON.parse(row.fileIdsJson),recordUserMessage:false});runner.start(j.id);res.status(202).json(j);});
  r.post("/jobs/:id/cancel",async(req,res)=>{const j=db.getJob(req.params.id);if(!j)return res.status(404).json({error:"Job not found"});await runner.cancel(j.id);res.json({ok:true});});
  r.get("/artifacts",(_req,res)=>res.json(db.listArtifacts()));
  r.get("/artifacts/:id/download",(req,res)=>{const a=db.getArtifact(req.params.id);if(!a)return res.status(404).json({error:"Artifact not found"});const target=safeJoin(config.artifactDir,a.name);if(path.resolve(a.path)!==target||!fs.existsSync(target))return res.status(404).json({error:"Artifact bytes missing"});res.download(target,a.name);});
  r.get("/approvals",(_req,res)=>res.json(db.listApprovals()));
  r.post("/approvals/:id",async(req,res,next)=>{try{const p=ApprovalDecisionSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:"Invalid approval decision"});if(p.data.editedArguments)return res.status(400).json({error:"Editing MCP arguments is not supported; approve the exact request or reject it"});await runner.continueApproval(req.params.id,p.data.decision);res.json({ok:true});}catch(e){next(e)}});
  return r;
}
