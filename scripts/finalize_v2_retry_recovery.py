from pathlib import Path

root = Path('.')

# 1) Persistent infrastructure retry marker helpers.
ledger_path = root / 'src/server/v2/revision-ledger.ts'
ledger = ledger_path.read_text()
append = r'''

export interface V2InfrastructureRetryState {
  count: number;
  ruleOrPart: string;
  message: string;
  updatedAt: string;
}

const INFRA_RETRY_FILENAME = "INFRA_RETRY.json";

export function recordV2InfrastructureRetry(
  workRoot: string,
  ruleOrPart: string,
  message: string,
): V2InfrastructureRetryState {
  fs.mkdirSync(workRoot, { recursive: true });
  const target = path.join(workRoot, INFRA_RETRY_FILENAME);
  let previous: V2InfrastructureRetryState | null = null;
  try {
    if (fs.existsSync(target))
      previous = JSON.parse(fs.readFileSync(target, "utf8")) as V2InfrastructureRetryState;
  } catch {
    previous = null;
  }
  const next: V2InfrastructureRetryState = {
    count: Math.max(0, Number(previous?.count ?? 0)) + 1,
    ruleOrPart,
    message,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function readV2InfrastructureRetry(
  workRoot: string,
): V2InfrastructureRetryState | null {
  const target = path.join(workRoot, INFRA_RETRY_FILENAME);
  try {
    if (!fs.existsSync(target)) return null;
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as V2InfrastructureRetryState;
    if (!Number.isFinite(parsed.count) || parsed.count < 1 || !parsed.ruleOrPart)
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasV2InfrastructureRetryPending(workRoot: string): boolean {
  return readV2InfrastructureRetry(workRoot) !== null;
}

export function clearV2InfrastructureRetry(workRoot: string): void {
  fs.rmSync(path.join(workRoot, INFRA_RETRY_FILENAME), { force: true });
}
'''
if 'recordV2InfrastructureRetry(' not in ledger:
    ledger += append
    ledger_path.write_text(ledger)

# 2) Convert top-level Agent SDK/provider failures to classified V2 pipeline errors,
# preserving cancellation and making an unexpected agent-loop stop retryable.
runtime_path = root / 'src/server/v2/artifact-agent-runtime.ts'
runtime = runtime_path.read_text()
old_run = '''    const result = await run(\n      agent,\n      `Open REQUEST.md and complete the ${input.kind} request. Use the workspace, research/code tools as needed, and iterate build_and_validate_artifact until it passes. Finish only by calling accept_validated_artifact.`,\n      {\n        maxTurns: null,\n        signal: input.signal,\n        sandbox: {\n          client: sandboxRuntime.client,\n          concurrencyLimits: {\n            manifestEntries: 4,\n            localDirFiles: 12,\n          },\n          archiveLimits: {},\n        },\n      },\n    );\n\n    if (!acceptedBuildId)\n      throw new ArtifactPipelineError(\n        "BUILD",\n        "Agent Díaz V2 ended without accepting a validated artifact.",\n        { ruleOrPart: "agent-v2-acceptance" },\n      );\n'''
new_run = '''    let result: any;\n    try {\n      result = await run(\n        agent,\n        `Open REQUEST.md and complete the ${input.kind} request. Use the workspace, research/code tools as needed, and iterate build_and_validate_artifact until it passes. Finish only by calling accept_validated_artifact.`,\n        {\n          maxTurns: null,\n          signal: input.signal,\n          sandbox: {\n            client: sandboxRuntime.client,\n            concurrencyLimits: {\n              manifestEntries: 4,\n              localDirFiles: 12,\n            },\n            archiveLimits: {},\n          },\n        },\n      );\n    } catch (error: any) {\n      if (input.signal?.aborted || error?.name === "AbortError") throw error;\n      if (error instanceof ArtifactPipelineError) throw error;\n      const failure = classifyV2BuildFailure(error);\n      throw new ArtifactPipelineError(\n        failure.failureClass,\n        `Agent Díaz V2 runtime failure: ${failure.message}`,\n        { ruleOrPart: failure.ruleOrPart, cause: error },\n      );\n    }\n\n    if (!acceptedBuildId)\n      throw new ArtifactPipelineError(\n        "INFRA",\n        "Agent Díaz V2 agent loop ended without accepting a validated artifact; the run will resume from its revision ledger.",\n        { ruleOrPart: "agent-v2-agent-loop-ended" },\n      );\n'''
if new_run not in runtime:
    assert old_run in runtime, 'runtime run() anchor not found'
    runtime = runtime.replace(old_run, new_run, 1)
runtime_path.write_text(runtime)

# 3) AgentRunner: restart retryable blocked V2 jobs after process restarts, schedule
# transient V2 infra retries without the legacy run-state object, and never let a
# cancellation race be overwritten as failure.
agent_path = root / 'src/server/openai-agent.ts'
agent = agent_path.read_text()
import_anchor = 'import { runV2ArtifactRuntime } from "./v2/artifact-agent-runtime.js";\n'
import_block = '''import {\n  clearV2InfrastructureRetry,\n  hasV2InfrastructureRetryPending,\n  recordV2InfrastructureRetry,\n} from "./v2/revision-ledger.js";\n'''
if import_block not in agent:
    assert import_anchor in agent, 'openai-agent V2 import anchor not found'
    agent = agent.replace(import_anchor, import_anchor + import_block, 1)

old_resume = '''  resume(): void {\n    for (const j of this.db\n      .listJobs(100)\n      .filter(\n        (j) =>\n          j.kind !== "chat" &&\n          ["queued", "running", "building"].includes(j.status),\n      ))\n      this.start(j.id);\n  }\n'''
new_resume = '''  resume(): void {\n    const v2Enabled = process.env.AGENT_RUNTIME !== "legacy";\n    for (const j of this.db\n      .listJobs(100)\n      .filter((j) => {\n        if (j.kind === "chat") return false;\n        if (["queued", "running", "building"].includes(j.status)) return true;\n        if (!v2Enabled || j.status !== "blocked") return false;\n        return hasV2InfrastructureRetryPending(\n          path.join(this.config.artifactDir, ".agent-v2", j.id),\n        );\n      })) {\n      if (j.status === "blocked")\n        log("warn", "agent_v2.infrastructure_retry_resumed_after_restart", {\n          jobId: j.id,\n          kind: j.kind,\n        });\n      this.start(j.id);\n    }\n  }\n'''
if new_resume not in agent:
    assert old_resume in agent, 'resume() anchor not found'
    agent = agent.replace(old_resume, new_resume, 1)

catch_anchor = '''    } catch (e: any) {\n      const message = e instanceof Error ? e.message : "Unknown job failure";\n      const current = this.db.getJob(jobId);\n      const artifactKinds = [\n'''
catch_new = '''    } catch (e: any) {\n      const message = e instanceof Error ? e.message : "Unknown job failure";\n      const current = this.db.getJob(jobId);\n      if (current?.status === "cancelled") {\n        log("info", "job.cancelled_preserved", { jobId, kind: current.kind });\n        return;\n      }\n      const artifactKinds = [\n'''
if catch_new not in agent:
    assert catch_anchor in agent, 'outer catch cancellation anchor not found'
    agent = agent.replace(catch_anchor, catch_new, 1)

old_retry = '''        if (\n          blocked &&\n          e.ruleOrPart !== "agent-v2-configuration" &&\n          this.config.NODE_ENV !== "test"\n        ) {\n          const state = this.db.getArtifactRunState(jobId);\n          if (!state) return;\n          const latest = state?.attempts.at(-1);\n          const duplicateCount = latest\n            ? state!.attempts.filter(\n                (attempt) => attempt.fingerprint === latest.fingerprint,\n              ).length\n            : 1;\n          if (duplicateCount < 2) {\n            const delayMs = Math.min(\n              60_000,\n              5000 * 2 ** Math.max(0, duplicateCount - 1),\n            );\n            log("warn", "artifact.infrastructure_retry_scheduled", {\n              jobId,\n              delayMs,\n              fingerprint: latest?.fingerprint ?? null,\n            });\n            setTimeout(() => this.start(jobId), delayMs);\n          }\n        }\n'''
new_retry = '''        if (blocked && this.config.NODE_ENV !== "test") {\n          const v2Enabled =\n            process.env.AGENT_RUNTIME !== "legacy" &&\n            (this.config.NODE_ENV !== "test" || process.env.AGENT_RUNTIME === "v2");\n          const v2WorkRoot = path.join(\n            this.config.artifactDir,\n            ".agent-v2",\n            jobId,\n          );\n          if (v2Enabled) {\n            if (e.ruleOrPart === "agent-v2-configuration") {\n              clearV2InfrastructureRetry(v2WorkRoot);\n              log("error", "agent_v2.configuration_blocked_no_retry", {\n                jobId,\n                ruleOrPart: e.ruleOrPart,\n                error: message,\n              });\n            } else {\n              const retryState = recordV2InfrastructureRetry(\n                v2WorkRoot,\n                e.ruleOrPart,\n                message,\n              );\n              const delayMs = Math.min(\n                60_000,\n                5000 * 2 ** Math.min(4, Math.max(0, retryState.count - 1)),\n              );\n              this.db.updateJob(jobId, {\n                status: "blocked",\n                message: `blocked: infrastructure; automatic retry ${retryState.count} scheduled`,\n                error: message,\n              });\n              log("warn", "agent_v2.infrastructure_retry_scheduled", {\n                jobId,\n                delayMs,\n                retryCount: retryState.count,\n                ruleOrPart: e.ruleOrPart,\n              });\n              setTimeout(() => this.start(jobId), delayMs);\n            }\n          } else {\n            const state = this.db.getArtifactRunState(jobId);\n            const latest = state?.attempts.at(-1);\n            const duplicateCount = latest\n              ? state!.attempts.filter(\n                  (attempt) => attempt.fingerprint === latest.fingerprint,\n                ).length\n              : 1;\n            if (duplicateCount < 2) {\n              const delayMs = Math.min(\n                60_000,\n                5000 * 2 ** Math.max(0, duplicateCount - 1),\n              );\n              log("warn", "artifact.infrastructure_retry_scheduled", {\n                jobId,\n                delayMs,\n                fingerprint: latest?.fingerprint ?? null,\n              });\n              setTimeout(() => this.start(jobId), delayMs);\n            }\n          }\n        }\n'''
if new_retry not in agent:
    assert old_retry in agent, 'infra retry block anchor not found'
    agent = agent.replace(old_retry, new_retry, 1)
agent_path.write_text(agent)

# 4) Expand V2 tests with persistent blocked-retry marker coverage.
test_path = root / 'src/server/__tests__/agent-v2-runtime.test.ts'
test = test_path.read_text()
old_import = '''  appendV2RevisionEntry,\n  listV2RecoveryFiles,\n  writeV2AttemptPlan,\n} from "../v2/revision-ledger.js";\n'''
new_import = '''  appendV2RevisionEntry,\n  clearV2InfrastructureRetry,\n  hasV2InfrastructureRetryPending,\n  listV2RecoveryFiles,\n  readV2InfrastructureRetry,\n  recordV2InfrastructureRetry,\n  writeV2AttemptPlan,\n} from "../v2/revision-ledger.js";\n'''
if new_import not in test:
    assert old_import in test, 'test revision import anchor not found'
    test = test.replace(old_import, new_import, 1)

insert_before = '\n});\n'
new_test = r'''

  it("persists transient infrastructure retry state across process restarts", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-v2-infra-retry-"));
    try {
      expect(hasV2InfrastructureRetryPending(temp)).toBe(false);
      const first = recordV2InfrastructureRetry(
        temp,
        "agent-v2-mcp-connect",
        "503 from remote MCP",
      );
      expect(first.count).toBe(1);
      expect(hasV2InfrastructureRetryPending(temp)).toBe(true);
      const second = recordV2InfrastructureRetry(
        temp,
        "agent-v2-mcp-connect",
        "503 from remote MCP",
      );
      expect(second.count).toBe(2);
      expect(readV2InfrastructureRetry(temp)?.count).toBe(2);
      clearV2InfrastructureRetry(temp);
      expect(hasV2InfrastructureRetryPending(temp)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
'''
if 'persists transient infrastructure retry state across process restarts' not in test:
    assert test.endswith(insert_before), 'test suite closing anchor not found'
    test = test[:-len(insert_before)] + new_test + insert_before

test_path.write_text(test)

# 5) Document the final blocked-retry semantics.
arch_path = root / 'AGENT_DIAZ_V2_ARCHITECTURE.md'
arch = arch_path.read_text()
paragraph = r'''

Transient V2 control-plane failures are also restart-safe. A provider, hosted-sandbox, or MCP outage writes an `INFRA_RETRY.json` marker beside the revision ledger, schedules capped exponential retry, and leaves the job `blocked` only while the external dependency is unavailable. `AgentRunner.resume()` recognizes that marker after a process restart and restarts the job automatically. Permanent `agent-v2-configuration` failures deliberately clear the marker and remain blocked until deployment configuration is corrected, preventing a bad configuration from becoming an infinite retry loop. User cancellation is terminal and cannot be overwritten by a racing failure handler.
'''
if 'INFRA_RETRY.json' not in arch:
    arch += paragraph
    arch_path.write_text(arch)

print('V2 retry recovery patch applied')
