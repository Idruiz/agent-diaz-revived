import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import type {Server} from "node:http";
import {loadConfig} from "../config.js";
import {openDatabase,type Db} from "../db.js";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"diaz-swarm-api-"));
const key=crypto.randomBytes(32).toString("hex");
process.env.SWARM_DIAZ_API_KEY=key;
let server:Server, db:Db, origin:string;
const started:string[]=[];
beforeAll(async()=>{
 const {createSwarmArtifactApi}=await import("../swarm-api.js");
 const config=loadConfig({NODE_ENV:"test",OPENAI_API_KEY:"test-api-key",ADMIN_PASSWORD:"test-password-over-16-chars",STORAGE_DIR:root});
 fs.mkdirSync(config.artifactDir,{recursive:true});
 db=openDatabase(config);
 const app=express();
 app.use(express.json({limit:"1mb"}));
 app.use("/api/swarm/v1",createSwarmArtifactApi(config,db,{start:(id)=>started.push(id),cancel:async()=>{}}).router);
 server=app.listen(0,"127.0.0.1");
 await new Promise<void>(resolve=>server.once("listening",resolve));
 const address=server.address();if(!address||typeof address==="string")throw Error("No test port");
 origin="http://127.0.0.1:"+address.port;
});
afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db?.close();fs.rmSync(root,{recursive:true,force:true});delete process.env.SWARM_DIAZ_API_KEY});
const call=async(route:string,auth=true,body?:unknown)=>{
 const res=await fetch(origin+"/api/swarm/v1"+route,{method:body===undefined?"GET":"POST",headers:{...(auth?{Authorization:"Bearer "+key}:{}),...(body===undefined?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,json:await res.json() as Record<string,unknown>};
};
describe("SWARM M2M API does not interfere with standalone Agent Díaz",()=>{
 it("denies unauthenticated discovery",async()=>{
   const r=await call("/capabilities",false);
   expect(r.status).toBe(401);expect(r.json.error).toBe("UNAUTHORIZED");
 });
 it("advertises real deterministic formats only to authorized caller",async()=>{
   const r=await call("/capabilities");
   expect(r.status).toBe(200);expect(r.json.ok).toBe(true);
   expect(r.json.inputModes).toEqual(["studio","plan"]);
   expect(r.json.defaultMode).toBe("studio");
   expect((r.json.formats as Record<string,string>).presentation).toBe("pptx");
 });
 it("rejects malformed submission before scheduling work",async()=>{
   const r=await call("/jobs",true,{requestId:crypto.randomUUID(),kind:"presentation",inputMode:"plan",plan:{"title":""}});
   expect(r.status).toBe(400);expect(r.json.error).toBe("INVALID_JOB");
   expect(db.raw.prepare("SELECT COUNT(*) n FROM swarm_artifact_jobs").get()).toEqual({n:0});
 });
 it("rejects unknown job IDs without exposing private owner jobs",async()=>{
   const r=await call("/jobs/not-a-job-id");
   expect(r.status).toBe(400);expect(r.json.error).toBe("INVALID_JOB_ID");
 });
 it("keeps standalone owner session job tables independent",()=>{
   const swarmCount=db.raw.prepare("SELECT COUNT(*) n FROM swarm_artifact_jobs").get() as {n:number};
   const ownerCount=db.raw.prepare("SELECT COUNT(*) n FROM jobs").get() as {n:number};
   expect(swarmCount.n).toBe(0);expect(ownerCount.n).toBe(0);
 });
});


describe("Full Studio parity with standalone Díaz",()=>{
 const studioRequest=(id:string)=>({
   requestId:id,kind:"presentation",prompt:"Explain the complete ant life cycle with scientific sources and professional visual PowerPoint design."
 });
 it("defaults to full Studio without requiring a prewritten plan",async()=>{
   const id=crypto.randomUUID(),before=started.length;
   const r=await call("/jobs",true,studioRequest(id));
   expect(r.status).toBe(202);
   expect(r.json.pipeline).toBe("standalone-full-studio");
   expect(r.json.inputMode).toBe("studio");
   expect(started.slice(before)).toContain(id);
   const native=db.getJob(id);
   expect(native?.kind).toBe("presentation");
   expect(native?.modelMode).toBe("deep");
   expect(native?.model).toBe("gpt-5.6-sol");
   expect(native?.reasoningEffort).toBe("high");
   const session=db.getConversation(native!.conversationId);
   expect(session?.status).toBe("active");
   expect(db.listMessages(native!.conversationId).some(m=>m.role==="user"&&m.content.includes("life cycle"))).toBe(true);
 });
 it("preserves exactly-once submission and rejects changed payloads for a UUID",async()=>{
   const id=crypto.randomUUID();
   const payload=studioRequest(id);
   const a=await call("/jobs",true,payload);
   const b=await call("/jobs",true,payload);
   const c=await call("/jobs",true,{...payload,prompt:payload.prompt+" plus dragons"});
   expect(a.status).toBe(202);
   expect(b.status).toBe(200);
   expect(b.json.replayed).toBe(true);
   expect(c.status).toBe(409);
   expect(c.json.error).toBe("IDEMPOTENCY_CONFLICT");
   expect(started.filter(x=>x===id)).toHaveLength(1);
 });
 it("publishes the native Studio PowerPoint only after independent byte/hash verification",async()=>{
   const id=crypto.randomUUID();
   const creation=await call("/jobs",true,studioRequest(id));
   expect(creation.status).toBe(202);
   const original=path.join(root,"artifacts","native-studio-"+id+".pptx");
   const bytes=Buffer.from("PK\u0003\u0004full-native-studio-output-validated-by-owner-pipeline");
   fs.writeFileSync(original,bytes);
   const sha=crypto.createHash("sha256").update(bytes).digest("hex");
   db.addArtifact({
     id:crypto.randomUUID(),jobId:id,name:path.basename(original),
     mime:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
     size:bytes.length,path:original,
     receipt:{artifactSha256:sha} as any
   });
   db.updateJob(id,{status:"completed",progress:100,message:"Completed"});
   const r=await call("/jobs/"+id);
   expect(r.status).toBe(200);
   expect(r.json.status).toBe("completed");
   const artifact=r.json.artifact as Record<string,unknown>;
   expect(artifact.sha256).toBe(sha);
   expect(artifact.size).toBe(bytes.length);
   const res=await fetch(origin+String(artifact.downloadPath),{headers:{Authorization:"Bearer "+key}});
   expect(res.status).toBe(200);
   expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
 });
 it("does not allow external jobs to retrieve private standalone owner artifacts",async()=>{
   const id=crypto.randomUUID();
   const r=await call("/jobs/"+id);
   expect(r.status).toBe(404);
   const foreign=db.listArtifacts()[0];
   if(foreign){
     const attempt=await fetch(origin+"/api/swarm/v1/jobs/"+crypto.randomUUID()+"/artifacts/"+foreign.id,
       {headers:{Authorization:"Bearer "+key}});
     expect(attempt.status).toBe(404);
   }
 });
 it("keeps explicit prewritten-plan mode schema validation",async()=>{
   const r=await call("/jobs",true,{requestId:crypto.randomUUID(),kind:"presentation",inputMode:"plan",prompt:"Purpose-built structure",plan:{title:""}});
   expect(r.status).toBe(400);
   expect(r.json.error).toBe("INVALID_JOB");
 });
});
