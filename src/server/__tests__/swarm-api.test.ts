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
beforeAll(async()=>{
 const {createSwarmArtifactApi}=await import("../swarm-api.js");
 const config=loadConfig({NODE_ENV:"test",OPENAI_API_KEY:"test-api-key",ADMIN_PASSWORD:"test-password-over-16-chars",STORAGE_DIR:root});
 fs.mkdirSync(config.artifactDir,{recursive:true});
 db=openDatabase(config);
 const app=express();
 app.use(express.json({limit:"1mb"}));
 app.use("/api/swarm/v1",createSwarmArtifactApi(config,db).router);
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
   expect(r.json.inputModes).toEqual(["plan"]);
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
