import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { JobKind, JobStatus, JobView, ConversationView, MessageView } from "../shared/contracts.js";

export interface Db {
  raw: Database.Database;
  close(): void;
  createSession(id: string, hash: string, expiresAt: string): void;
  getSession(hash: string): { id: string; expiresAt: string } | undefined;
  deleteSession(hash: string): void;
  createJob(input: { id: string; kind: JobKind; prompt: string; conversationId: string; fileIds: string[]; recordUserMessage?: boolean }): JobView;
  getJob(id: string): JobView | undefined;
  listJobs(limit?: number): JobView[];
  updateJob(id: string, patch: Partial<Pick<JobView, "status" | "progress" | "message" | "outputText" | "error">> & { providerResponseId?: string | null }): void;
  getProviderResponseId(id: string): string | null;
  addArtifact(row: { id: string; jobId: string; name: string; mime: string; size: number; path: string }): void;
  listArtifacts(jobId?: string): Array<{ id: string; jobId: string; name: string; mime: string; size: number; createdAt: string }>;
  getArtifact(id: string): { id: string; jobId: string; name: string; mime: string; size: number; path: string } | undefined;
  addUpload(row: { id: string; name: string; mime: string; size: number; path: string; openaiFileId: string }): void;
  getUploads(ids: string[]): Array<{ id: string; name: string; mime: string; path: string; openaiFileId: string }>;
  createApproval(row: { id: string; jobId: string; tool: string; summary: string; argumentsJson: string; providerItemId:string; providerResponseId:string }): void;
  listApprovals(jobId?: string): Array<{ id: string; jobId: string; tool: string; summary: string; arguments: unknown; status: string; createdAt: string }>;
  decideApproval(id: string, status: "approved" | "rejected", argumentsJson?: string): void;
  getApproval(id:string):{id:string;jobId:string;status:string;providerItemId:string;providerResponseId:string}|undefined;
  createConversation(id:string,title:string): ConversationView;
  listConversations(): ConversationView[];
  getConversation(id:string): ConversationView|undefined;
  addMessage(row:{id:string;conversationId:string;role:"user"|"assistant";content:string;jobId?:string|null}):void;
  listMessages(conversationId:string):MessageView[];
  archiveOverflow(): ConversationView[];
  setConversationSummary(id:string,summary:string):void;
  listArchiveSummaries(limit?:number):Array<{title:string;summary:string;updatedAt:string}>;
}

function mapJob(r: any): JobView {
  return { id:r.id, kind:r.kind, status:r.status, prompt:r.prompt, progress:r.progress, message:r.message,
    outputText:r.output_text, error:r.error, createdAt:r.created_at, updatedAt:r.updated_at, conversationId:r.conversation_id };
}

function mapConversation(r:any):ConversationView{return{id:r.id,title:r.title,status:r.status,summary:r.summary,createdAt:r.created_at,updatedAt:r.updated_at,messageCount:Number(r.message_count??0)}}

export function openDatabase(config: Config): Db {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const raw = new Database(path.join(config.dataDir, "agent-diaz.sqlite"));
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.exec(`
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL, conversation_id TEXT NOT NULL,
      file_ids_json TEXT NOT NULL, provider_response_id TEXT, progress INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
      output_text TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts(
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uploads(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL,
      openai_file_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals(
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, tool TEXT NOT NULL, summary TEXT NOT NULL,
      arguments_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT,
      provider_item_id TEXT, provider_response_id TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',summary TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id,created_at);
  `);
  const approvalColumns=(raw.prepare("PRAGMA table_info(approvals)").all() as Array<{name:string}>).map(c=>c.name);
  if(!approvalColumns.includes("provider_item_id"))raw.exec("ALTER TABLE approvals ADD COLUMN provider_item_id TEXT");
  if(!approvalColumns.includes("provider_response_id"))raw.exec("ALTER TABLE approvals ADD COLUMN provider_response_id TEXT");
  const now = () => new Date().toISOString();
  return {
    raw,
    close: () => raw.close(),
    createSession: (id, hash, expiresAt) => raw.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(id, hash, expiresAt, now()),
    getSession: hash => raw.prepare("SELECT id, expires_at expiresAt FROM sessions WHERE token_hash=? AND expires_at>?").get(hash, now()) as any,
    deleteSession: hash => { raw.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash); },
    createJob: input => {
      if(!raw.prepare("SELECT 1 FROM conversations WHERE id=? AND status='active'").get(input.conversationId)) throw new Error("Conversation is missing or archived");
      const t=now(); raw.prepare(`INSERT INTO jobs(id,kind,status,prompt,conversation_id,file_ids_json,progress,message,created_at,updated_at) VALUES(?,?,'queued',?,?,?,0,'Queued',?,?)`)
        .run(input.id,input.kind,input.prompt,input.conversationId,JSON.stringify(input.fileIds),t,t);
      if(input.recordUserMessage!==false)raw.prepare("INSERT INTO messages(id,conversation_id,role,content,job_id,created_at) VALUES(?,?,'user',?,?,?)").run(crypto.randomUUID(),input.conversationId,input.prompt,input.id,t);
      raw.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(t,input.conversationId);
      raw.prepare("UPDATE conversations SET title=? WHERE id=? AND title='New conversation'").run(input.prompt.replace(/\s+/g," ").slice(0,72),input.conversationId);
      return mapJob(raw.prepare("SELECT * FROM jobs WHERE id=?").get(input.id));
    },
    getJob: id => { const r=raw.prepare("SELECT * FROM jobs WHERE id=?").get(id); return r ? mapJob(r) : undefined; },
    listJobs: (limit=50) => raw.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit).map(mapJob),
    updateJob: (id, p) => {
      const allowed: Record<string,string>={status:"status",progress:"progress",message:"message",outputText:"output_text",error:"error",providerResponseId:"provider_response_id"};
      const pairs=Object.entries(p).filter(([,v])=>v!==undefined).map(([k])=>`${allowed[k]}=@${k}`);
      if(!pairs.length)return; raw.prepare(`UPDATE jobs SET ${pairs.join(",")}, updated_at=@updatedAt WHERE id=@id`).run({...p,id,updatedAt:now()});
    },
    getProviderResponseId: id => (raw.prepare("SELECT provider_response_id id FROM jobs WHERE id=?").get(id) as any)?.id ?? null,
    addArtifact: r => raw.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)").run(r.id,r.jobId,r.name,r.mime,r.size,r.path,now()),
    listArtifacts: jobId => (jobId?raw.prepare("SELECT id,job_id jobId,name,mime,size,created_at createdAt FROM artifacts WHERE job_id=? ORDER BY created_at DESC").all(jobId):raw.prepare("SELECT id,job_id jobId,name,mime,size,created_at createdAt FROM artifacts ORDER BY created_at DESC LIMIT 100").all()) as any,
    getArtifact: id => raw.prepare("SELECT id,job_id jobId,name,mime,size,path FROM artifacts WHERE id=?").get(id) as any,
    addUpload: r => raw.prepare("INSERT INTO uploads VALUES(?,?,?,?,?,?,?)").run(r.id,r.name,r.mime,r.size,r.path,r.openaiFileId,now()),
    getUploads: ids => ids.length ? raw.prepare(`SELECT id,name,mime,path,openai_file_id openaiFileId FROM uploads WHERE id IN (${ids.map(()=>"?").join(",")})`).all(...ids) as any : [],
    createApproval: r => raw.prepare("INSERT INTO approvals(id,job_id,tool,summary,arguments_json,status,created_at,provider_item_id,provider_response_id) VALUES(?,?,?,?,?,'pending',?,?,?)").run(r.id,r.jobId,r.tool,r.summary,r.argumentsJson,now(),r.providerItemId,r.providerResponseId),
    listApprovals: jobId => (jobId?raw.prepare("SELECT * FROM approvals WHERE job_id=? ORDER BY created_at DESC").all(jobId):raw.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100").all()).map((r:any)=>({id:r.id,jobId:r.job_id,tool:r.tool,summary:r.summary,arguments:JSON.parse(r.arguments_json),status:r.status,createdAt:r.created_at})),
    decideApproval: (id,status,args) => { raw.prepare("UPDATE approvals SET status=?, arguments_json=COALESCE(?,arguments_json), decided_at=? WHERE id=? AND status='pending'").run(status,args??null,now(),id); },
    getApproval:id=>raw.prepare("SELECT id,job_id jobId,status,provider_item_id providerItemId,provider_response_id providerResponseId FROM approvals WHERE id=?").get(id) as any,
    createConversation:(id,title)=>{const t=now();raw.prepare("INSERT INTO conversations(id,title,status,created_at,updated_at) VALUES(?,?,'active',?,?)").run(id,title,t,t);return mapConversation(raw.prepare("SELECT c.*,0 message_count FROM conversations c WHERE id=?").get(id));},
    listConversations:()=>raw.prepare("SELECT c.*,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) message_count FROM conversations c ORDER BY status='active' DESC,updated_at DESC").all().map(mapConversation),
    getConversation:id=>{const r=raw.prepare("SELECT c.*,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) message_count FROM conversations c WHERE id=?").get(id);return r?mapConversation(r):undefined},
    addMessage:r=>{const t=now();raw.prepare("INSERT INTO messages(id,conversation_id,role,content,job_id,created_at) VALUES(?,?,?,?,?,?)").run(r.id,r.conversationId,r.role,r.content,r.jobId??null,t);raw.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(t,r.conversationId)},
    listMessages:id=>raw.prepare("SELECT id,conversation_id conversationId,role,content,job_id jobId,created_at createdAt FROM messages WHERE conversation_id=? ORDER BY created_at,rowid").all(id) as MessageView[],
    archiveOverflow:()=>{const overflow=raw.prepare("SELECT c.*,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) message_count FROM conversations c WHERE status='active' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.conversation_id=c.id AND j.status IN ('queued','running','waiting_approval','building')) ORDER BY updated_at DESC LIMIT -1 OFFSET 5").all() as any[];const tx=raw.transaction(()=>{for(const c of overflow)raw.prepare("UPDATE conversations SET status='archived' WHERE id=?").run(c.id)});tx();return overflow.map(mapConversation)},
    setConversationSummary:(id,summary)=>{raw.prepare("UPDATE conversations SET summary=?,status='archived' WHERE id=?").run(summary,id)},
    listArchiveSummaries:(limit=20)=>raw.prepare("SELECT title,summary,updated_at updatedAt FROM conversations WHERE status='archived' AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT ?").all(limit) as any
  };
}
