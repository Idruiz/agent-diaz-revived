import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {Config} from "./config.js";
import type {Db} from "./db.js";
import {modelProfileFor, type AgentRunner} from "./openai-agent.js";
import {log} from "./log.js";

export type StudioKind="presentation"|"document"|"research"|"analysis"|"website";
export type StudioMode="balanced"|"deep";
export interface StudioRequest {
  requestId:string;
  kind:StudioKind;
  prompt:string;
  modelMode:StudioMode;
}
type StudioStatus="queued"|"running"|"completed"|"failed"|"cancelled";
const FORMAT:Record<StudioKind,string>={
  presentation:".pptx",document:".docx",research:".docx",analysis:".docx",website:".zip"
};
const MAX_BYTES=30*1024*1024; // The registered SWARM gateway currently accepts 30 MiB.
const stamp=()=>new Date().toISOString();
const errorString=(e:unknown)=>e instanceof Error?e.message:String(e);

/**
 * Reuse the exact standalone AgentRunner evidence/research/AI visual planning/
 * quality gates and deterministic build. A different API entrypoint does NOT
 * mean a diminished presentation engine.
 *
 * Service-created conversations get isolated job IDs; the owner UI and its
 * existing jobs, histories, sessions, and routes are not changed by this module.
 */
export function createFullStudioBridge(config:Config,db:Db,runner?:Pick<AgentRunner,"start"|"cancel">){
  const write=db.raw.prepare("UPDATE swarm_artifact_jobs SET status=?,progress=?,message=?,error=?,updated_at=? WHERE id=?");
  const set=(id:string,status:StudioStatus,progress:number,message:string,error:string|null=null)=>
    write.run(status,progress,message.slice(0,400),error?.slice(0,2000)??null,stamp(),id);

  const create=(input:StudioRequest)=>{
    if(!runner)throw Error("FULL_STUDIO_RUNNER_NOT_CONFIGURED");
    const conversationId=crypto.randomUUID();
    const profile=modelProfileFor(input.modelMode);
    db.createConversation(conversationId,"SWARM Studio - "+input.kind);
    db.setConversationMode(conversationId,profile.mode);
    db.createJob({
      id:input.requestId,kind:input.kind,prompt:input.prompt,
      conversationId,fileIds:[],modelMode:profile.mode,model:profile.model,
      reasoningEffort:profile.reasoningEffort,persona:"diaz"
    });
    log("info","swarm_api.full_studio_native_job_created",{
      jobId:input.requestId,kind:input.kind,modelMode:input.modelMode
    });
  };

  const start=(id:string)=>{
    if(!runner)throw Error("FULL_STUDIO_RUNNER_NOT_CONFIGURED");
    runner.start(id);
  };

  /** Materialize standalone output into the same authenticated API that the
   * Cloudflare registry already retrieves and independently SHA-checks. */
  const sync=(id:string,kind:StudioKind)=>{
    const row=db.raw.prepare("SELECT status FROM swarm_artifact_jobs WHERE id=?").get(id) as {status:StudioStatus}|undefined;
    if(!row||["completed","failed","cancelled"].includes(row.status))return;
    const native=db.getJob(id);
    if(!native){
      set(id,"failed",100,"Studio native job missing","STUDIO_NATIVE_JOB_MISSING");
      return;
    }
    if(native.status==="completed"){
      try{
        const expectedExt=FORMAT[kind];
        const available=db.listArtifacts(id);
        const match=available.find(f=>f.name.toLowerCase().endsWith(expectedExt));
        if(!match)throw Error("NATIVE_STUDIO_COMPLETED_WITHOUT_EXPECTED_ARTIFACT");
        const file=db.getArtifact(match.id);
        if(!file)throw Error("NATIVE_STUDIO_ARTIFACT_RECORD_MISSING");
        const root=path.resolve(config.artifactDir),src=path.resolve(file.path);
        if(!src.startsWith(root+path.sep))throw Error("ARTIFACT_OUTSIDE_STORAGE_ROOT");
        if(!fs.existsSync(src))throw Error("NATIVE_STUDIO_FILE_MISSING");
        const bytes=fs.readFileSync(src);
        if(!bytes.length||bytes.length>MAX_BYTES)throw Error("STUDIO_OUTPUT_EXCEEDS_CURRENT_GATEWAY_LIMIT");
        if(match.size!==bytes.length)throw Error("NATIVE_STUDIO_SIZE_MISMATCH");
        const digest=crypto.createHash("sha256").update(bytes).digest("hex");
        if(file.receipt?.artifactSha256 && file.receipt.artifactSha256!==digest)
          throw Error("NATIVE_STUDIO_SHA256_MISMATCH");
        if(expectedExt===".pptx"&&(bytes[0]!==0x50||bytes[1]!==0x4b))
          throw Error("NOT_A_VALID_PPTX_CONTAINER");
        const original=db.raw.prepare("SELECT id FROM swarm_artifact_files WHERE job_id=?").get(id) as {id:string}|undefined;
        if(original){
          set(id,"completed",100,"Full Studio artifact ready");
          return;
        }
        const filename="swarm-"+id+"-"+digest.slice(0,16)+expectedExt;
        const output=path.join(root,filename);
        fs.copyFileSync(src,output);
        const artifactId=crypto.randomUUID();
        const receipt=file.receipt??{artifactSha256:digest,origin:"native-full-studio",nativeArtifactId:file.id};
        db.raw.transaction(()=>{
          db.raw.prepare("INSERT INTO swarm_artifact_files(id,job_id,name,mime,size,sha256,path,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(artifactId,id,filename,file.mime,bytes.length,digest,output,JSON.stringify(receipt),stamp());
          db.raw.prepare("UPDATE swarm_artifact_jobs SET status='completed',progress=100,message=?,error=NULL,artifact_id=?,updated_at=? WHERE id=?")
            .run("Full Studio artifact independently verified",artifactId,stamp(),id);
        })();
        log("info","swarm_api.full_studio_artifact_published",{jobId:id,kind,bytes:bytes.length,sha256:digest,studioNativePipeline:true});
      }catch(e){
        const reason=errorString(e);
        log("error","swarm_api.full_studio_publish_failed",{jobId:id,kind,error:reason});
        set(id,"failed",100,"Full Studio artifact verification failed",reason);
      }
      return;
    }
    if(native.status==="failed"||native.status==="cancelled"){
      set(id,native.status,100,"Full Studio "+native.status,native.error||native.message);
      return;
    }
    if(native.status==="waiting_approval"){
      set(id,"failed",100,"Standalone Studio needs interactive approval","INTERACTIVE_APPROVAL_UNSUPPORTED_FOR_M2M");
      if(runner)void runner.cancel(id).catch(e=>log("error","swarm_api.cancel_error",{jobId:id,error:errorString(e)}));
      return;
    }
    const progress=Math.max(1,Math.min(99,native.progress));
    const blocked=native.status==="blocked";
    set(id,"running",progress,"Full Studio: "+native.message,blocked?(native.error||"PROVIDER_RETRYING"):null);
  };

  const resumeStudio=()=>{
    const queued=db.raw.prepare("SELECT id FROM swarm_artifact_jobs WHERE status IN ('queued','running') AND json_extract(payload_json,'$.inputMode')='studio' ORDER BY created_at").all() as {id:string}[];
    for(const {id} of queued){
      const native=db.getJob(id);
      if(native&&!["completed","failed","cancelled"].includes(native.status))start(id);
      else {
        const row=db.raw.prepare("SELECT kind FROM swarm_artifact_jobs WHERE id=?").get(id) as {kind:StudioKind};
        sync(id,row.kind);
      }
    }
  };
  return {create,start,sync,resumeStudio};
}
