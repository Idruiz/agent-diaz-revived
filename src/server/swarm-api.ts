import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ArtifactPlanSchema, type ArtifactPlan, type JobKind } from '../shared/contracts.js';
import { buildArtifact } from './builders.js';
import { log } from './log.js';
import { withArtifactRunLog, readArtifactRunLog } from './artifact-run-log.js';
import { createFullStudioBridge, type StudioKind } from './swarm-studio.js';
import type { AgentRunner } from './openai-agent.js';

/**
 * Machine-to-machine artifact transport. Separate authentication and job ledger
 * from the owner's browser sessions and conversations. Existing Diaz routes and
 * deterministic builders are left unchanged.
 *
 * Configure SWARM_DIAZ_API_KEY on Render using a >=32-byte random secret.
 * The corresponding Cloudflare tool must hold that value as a Worker secret.
 */
const MAX_QUEUE = 20;
const MAX_PAYLOAD_BYTES = 160_000;
const ACCEPTED_KINDS = ['presentation', 'document', 'website', 'research', 'analysis'] as const;
const BaseRequest = {requestId:z.string().uuid(),kind:z.enum(ACCEPTED_KINDS)};
const StudioRequest = z.object({
  ...BaseRequest,inputMode:z.literal('studio').default('studio'),
  prompt:z.string().trim().min(2).max(30000),
  modelMode:z.enum(['balanced','deep']).default('deep')
}).strict();
const PlanRequest = z.object({
  ...BaseRequest,inputMode:z.literal('plan'),
  plan:ArtifactPlanSchema,prompt:z.string().trim().max(30000).default('')
}).strict();
const RequestSchema=z.union([StudioRequest,PlanRequest]);

type Kind = (typeof ACCEPTED_KINDS)[number];
type Request = z.infer<typeof RequestSchema>;
type JobRow = { id: string; kind: Kind; status: string; progress: number; message: string; error: string | null; artifact_id: string | null; created_at: string; updated_at: string; };
type ArtifactRow = { id: string; job_id: string; name: string; mime: string; size: number; sha256: string; path: string; receipt_json: string; };
const now = () => new Date().toISOString();
const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);
const sha256 = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const safeID = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
const secret = (process.env.SWARM_DIAZ_API_KEY ?? '').trim();
const maxConcurrency = 1;

export function createSwarmArtifactApi(config: Config, db: Db, runner?:Pick<AgentRunner,'start'|'cancel'>) {
  const router = Router();
  const active = new Set<string>();
  const studio = createFullStudioBridge(config,db,runner);
  const modeFor = (id:string):'studio'|'plan' => {
    const row=db.raw.prepare("SELECT json_extract(payload_json,'$.inputMode') mode FROM swarm_artifact_jobs WHERE id=?")
      .get(id) as {mode?:'studio'|'plan'}|undefined;
    return row?.mode==='studio'?'studio':'plan';
  };
  let scheduled = false;
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS swarm_artifact_jobs(
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      error TEXT,
      artifact_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS swarm_artifact_files(
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES swarm_artifact_jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      path TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_swarm_jobs_status ON swarm_artifact_jobs(status, created_at);
  `);

  const queryJob = db.raw.prepare('SELECT id,kind,status,progress,message,error,artifact_id,created_at,updated_at FROM swarm_artifact_jobs WHERE id=?');
  const queryPayload = db.raw.prepare('SELECT payload_json FROM swarm_artifact_jobs WHERE id=?');
  const queryArtifact = db.raw.prepare('SELECT * FROM swarm_artifact_files WHERE job_id=?');
  const writeState = db.raw.prepare('UPDATE swarm_artifact_jobs SET status=?,progress=?,message=?,error=?,updated_at=? WHERE id=?');
  const update = (id: string, status: string, progress: number, message: string, error: string | null = null) =>
    writeState.run(status, progress, message.slice(0, 400), error?.slice(0, 2000) ?? null, now(), id);
  const published = (job: JobRow) => {
    const mode=modeFor(job.id);
    if(mode==='studio')studio.sync(job.id,job.kind);
    const current=queryJob.get(job.id) as JobRow;
    const artifact = queryArtifact.get(job.id) as ArtifactRow | undefined;
    return {
      jobId:current.id,kind:current.kind,status:current.status,progress:current.progress,
      inputMode:mode,
      pipeline:mode==='studio'?'standalone-full-studio':'structured-builder',
      message:current.message,error:current.error,createdAt:current.created_at,updatedAt:current.updated_at,
      artifact: artifact ? {
        id: artifact.id, name: artifact.name, mime: artifact.mime,
        size: artifact.size, sha256: artifact.sha256,
        downloadPath: `/api/swarm/v1/jobs/${job.id}/artifacts/${artifact.id}`,
        validation: JSON.parse(artifact.receipt_json),
      } : null,
    };
  };

  const authorize: RequestHandler = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (secret.length < 43) return res.status(503).json({ ok: false, error: 'SWARM_API_NOT_CONFIGURED' });
    const auth = req.get('authorization') ?? '';
    const value = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const expected = crypto.createHash('sha256').update(secret).digest();
    const supplied = crypto.createHash('sha256').update(value).digest();
    if (!value || !crypto.timingSafeEqual(expected, supplied)) {
      log('warn', 'swarm_api.auth_rejected', { requestId: res.locals.requestId, method: req.method, path: req.path });
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    next();
  };

  const runOne = async (id: string) => {
    const payloadRow = queryPayload.get(id) as { payload_json: string } | undefined;
    if (!payloadRow) throw Error('Job record missing');
    const input = PlanRequest.parse(JSON.parse(payloadRow.payload_json));
    update(id, 'running', 5, 'Starting deterministic artifact builder');
    const scratch = path.join(config.artifactDir, '.swarm-work', id);
    fs.mkdirSync(scratch, { recursive: true });
    try {
      await withArtifactRunLog(config, id, async () => {
        const built = await buildArtifact(
          { ...config, artifactDir: scratch }, input.kind as JobKind,
          input.plan as ArtifactPlan, input.prompt, id,
          event => {
            const previous = queryJob.get(id) as JobRow | undefined;
            update(id, 'running', Math.max(previous?.progress ?? 5, Math.min(98, event.progress)), event.message);
            log('info', 'swarm_api.build_progress', { jobId: id, kind: input.kind, progress: event.progress, stage: event.stage });
          },
        );
        const content = fs.readFileSync(built.path);
        const actualHash = sha256(content);
        const storedHash = built.validationReceipt.artifactSha256;
        if (storedHash && storedHash !== actualHash) throw Error('Artifact SHA-256 validation mismatch');
        const extension = path.extname(built.name).toLowerCase();
        const filename = `swarm-${id}-${actualHash.slice(0,16)}${extension}`;
        const target = path.join(config.artifactDir, filename);
        fs.renameSync(built.path, target);
        const artifactId = crypto.randomUUID();
        const stamp = now();
        db.raw.transaction(() => {
          db.raw.prepare('INSERT INTO swarm_artifact_files(id,job_id,name,mime,size,sha256,path,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(artifactId, id, filename, built.mime, content.byteLength, actualHash, target, JSON.stringify(built.validationReceipt), stamp);
          db.raw.prepare("UPDATE swarm_artifact_jobs SET status='completed',progress=100,message='Verified artifact ready',artifact_id=?,error=NULL,updated_at=? WHERE id=?")
            .run(artifactId, stamp, id);
        })();
        log('info', 'swarm_api.artifact_ready', { jobId: id, artifactId, bytes: content.byteLength, sha256: actualHash, kind: input.kind });
      });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  };

  const pump = () => {
    if (active.size >= maxConcurrency) return;
    const queued = db.raw.prepare("SELECT id FROM swarm_artifact_jobs WHERE status='queued' AND json_extract(payload_json,'$.inputMode')='plan' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
    if (!queued || active.has(queued.id)) return;
    active.add(queued.id);
    void runOne(queued.id).catch(err => {
      log('error', 'swarm_api.job_failed', { jobId: queued.id, error: errorText(err) });
      update(queued.id, 'failed', 100, 'Build failed; see error and run log', errorText(err));
    }).finally(() => { active.delete(queued.id); schedule(); });
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump(); });
  };

  router.use(authorize);
  router.get('/capabilities', (_req,res) => res.json({
    ok: true, name: 'agent-diaz-deterministic-artifacts', version: 1,
    inputModes:['studio','plan'],defaultMode:'studio',defaultModelMode:'deep',
    studioPipeline:'Same standalone evidence → AI planning → images → deterministic render and QA',
    formats: { presentation: 'pptx', document: 'docx', website: 'zip', research: 'docx', analysis: 'docx' },
    async: true, idempotency: 'requestId UUID', maxQueuedJobs: MAX_QUEUE,
  }));
  router.post('/jobs', (req,res) => {
    const size = Buffer.byteLength(JSON.stringify(req.body ?? null));
    if (size > MAX_PAYLOAD_BYTES) return res.status(413).json({ok:false,error:'PAYLOAD_TOO_LARGE'});
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ok:false,error:'INVALID_JOB',issues:parsed.error.issues});
    const input = parsed.data;
    const serialized = JSON.stringify(input);
    const hash = sha256(serialized);
    const existing = db.raw.prepare('SELECT request_hash FROM swarm_artifact_jobs WHERE id=?').get(input.requestId) as {request_hash:string} | undefined;
    if (existing) {
      if (existing.request_hash !== hash) return res.status(409).json({ok:false,error:'IDEMPOTENCY_CONFLICT'});
      const job = queryJob.get(input.requestId) as JobRow;
      schedule();
      return res.status(200).json({ok:true,replayed:true,...published(job)});
    }
    const waiting = (db.raw.prepare("SELECT COUNT(*) count FROM swarm_artifact_jobs WHERE status IN ('queued','running')").get() as {count:number}).count;
    if (waiting >= MAX_QUEUE) return res.status(429).set('Retry-After','15').json({ok:false,error:'QUEUE_FULL'});
    if(input.inputMode==='studio'&&!runner)return res.status(503).json({ok:false,error:'FULL_STUDIO_RUNNER_NOT_CONFIGURED'});
    const stamp = now();
    try {
      db.raw.transaction(()=>{
        db.raw.prepare("INSERT INTO swarm_artifact_jobs(id,kind,request_hash,payload_json,status,progress,message,created_at,updated_at) VALUES(?,?,?,?,'queued',0,'Queued',?,?)")
          .run(input.requestId,input.kind,hash,JSON.stringify(input),stamp,stamp);
        if(input.inputMode==='studio')studio.create(input);
      })();
    } catch (err) {
      if (String(err).includes('UNIQUE')) return res.status(409).json({ok:false,error:'CONCURRENT_IDEMPOTENCY_CONFLICT'});
      throw err;
    }
    log('info','swarm_api.job_created',{jobId:input.requestId,kind:input.kind,inputMode:input.inputMode});
    if(input.inputMode==='studio')studio.start(input.requestId);
    else schedule();
    return res.status(202).json({ok:true,replayed:false,...published(queryJob.get(input.requestId) as JobRow)});
  });
  router.get('/jobs/:id', (req,res) => {
    if (!safeID(req.params.id as string)) return res.status(400).json({ok:false,error:'INVALID_JOB_ID'});
    const job = queryJob.get(req.params.id) as JobRow | undefined;
    if (!job) return res.status(404).json({ok:false,error:'JOB_NOT_FOUND'});
    res.json({ok:true,...published(job)});
  });
  router.get('/jobs/:id/logs',(req,res)=>{
    if (!safeID(req.params.id as string)) return res.status(400).json({ok:false,error:'INVALID_JOB_ID'});
    if (!queryJob.get(req.params.id)) return res.status(404).json({ok:false,error:'JOB_NOT_FOUND'});
    res.type('text/plain; charset=utf-8').send(readArtifactRunLog(config,req.params.id as string) || 'No job log has been recorded yet.\n');
  });
  router.post('/jobs/:id/cancel', (req,res) => {
    if (!safeID(req.params.id as string)) return res.status(400).json({ok:false,error:'INVALID_JOB_ID'});
    const job = queryJob.get(req.params.id) as JobRow | undefined;
    if (!job) return res.status(404).json({ok:false,error:'JOB_NOT_FOUND'});
    if (job.status !== 'queued') return res.status(409).json({ok:false,error:'CANCELLATION_ONLY_SUPPORTED_WHILE_QUEUED'});
    update(job.id,'cancelled',100,'Cancelled before execution');
    res.json({ok:true,...published(queryJob.get(job.id) as JobRow)});
  });
  router.get('/jobs/:id/artifacts/:artifactId', (req,res) => {
    if (!safeID(req.params.id as string) || !safeID(req.params.artifactId as string)) return res.status(400).json({ok:false,error:'INVALID_IDENTIFIER'});
    const artifact = queryArtifact.get(req.params.id) as ArtifactRow | undefined;
    if (!artifact || artifact.id !== req.params.artifactId) return res.status(404).json({ok:false,error:'ARTIFACT_NOT_FOUND'});
    const expectedPath = path.resolve(config.artifactDir, artifact.name);
    if (path.resolve(artifact.path) !== expectedPath || !fs.existsSync(expectedPath)) return res.status(410).json({ok:false,error:'ARTIFACT_BYTES_LOST'});
    const stat = fs.statSync(expectedPath);
    if (!stat.isFile() || stat.size !== artifact.size || sha256(fs.readFileSync(expectedPath)) !== artifact.sha256) return res.status(409).json({ok:false,error:'ARTIFACT_INTEGRITY_FAILED'});
    res.download(expectedPath,artifact.name);
  });

  /** Re-queue jobs interrupted by process restart. A job never reports success unless its bytes and receipt were committed. */
  const resume = () => {
    const stale = db.raw.prepare("UPDATE swarm_artifact_jobs SET status='queued',progress=0,message='Recovered after service restart',updated_at=? WHERE status='running' AND json_extract(payload_json,'$.inputMode')='plan'").run(now());
    if (stale.changes) log('warn','swarm_api.recovered_interrupted_jobs',{count:stale.changes});
    studio.resumeStudio();
    schedule();
  };
  return { router, resume };
}
