import fs from "node:fs";

function replaceOnce(file, needle, replacement) {
  const source = fs.readFileSync(file, "utf8");
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${file}: expected exactly one anchor, found ${count}`);
  fs.writeFileSync(file, source.replace(needle, replacement));
}

fs.writeFileSync(
  "src/server/artifact-run-log.ts",
  `import { AsyncLocalStorage } from "node:async_hooks";\nimport fs from "node:fs";\nimport path from "node:path";\nimport type { Config } from "./config.js";\n\ntype ArtifactLogContext = { jobId: string; filePath: string };\nconst artifactLogStorage = new AsyncLocalStorage<ArtifactLogContext>();\n\nfunction safeJobId(jobId: string): string {\n  return jobId.replace(/[^a-zA-Z0-9_-]/g, "_");\n}\n\nexport function artifactRunLogPath(config: Config, jobId: string): string {\n  return path.join(config.dataDir, "artifact-run-logs", \\`${safeJobId(jobId)}.jsonl\\`);\n}\n\nexport async function withArtifactRunLog<T>(\n  config: Config,\n  jobId: string,\n  fn: () => Promise<T>,\n): Promise<T> {\n  const filePath = artifactRunLogPath(config, jobId);\n  fs.mkdirSync(path.dirname(filePath), { recursive: true });\n  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "", "utf8");\n  return artifactLogStorage.run({ jobId, filePath }, fn);\n}\n\nexport function currentArtifactJobId(): string | null {\n  return artifactLogStorage.getStore()?.jobId ?? null;\n}\n\nexport function appendCurrentArtifactLog(line: string): void {\n  const context = artifactLogStorage.getStore();\n  if (!context) return;\n  try {\n    fs.appendFileSync(context.filePath, \\`${line}\\n\\`, "utf8");\n  } catch (error) {\n    console.error(\n      JSON.stringify({\n        ts: new Date().toISOString(),\n        level: "error",\n        event: "artifact.run_log_write_failed",\n        jobId: context.jobId,\n        error: error instanceof Error ? error.message : String(error),\n      }),\n    );\n  }\n}\n\nexport function readArtifactRunLog(config: Config, jobId: string): string {\n  const filePath = artifactRunLogPath(config, jobId);\n  if (!fs.existsSync(filePath)) return "";\n  return fs.readFileSync(filePath, "utf8");\n}\n`,
);

fs.writeFileSync(
  "src/server/log.ts",
  `import { appendCurrentArtifactLog, currentArtifactJobId } from "./artifact-run-log.js";\n\nexport type Level = "info" | "warn" | "error";\n\nfunction clean(value: unknown): unknown {\n  if (typeof value === "string") return value.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_KEY]");\n  if (Array.isArray(value)) return value.map(clean);\n  if (value && typeof value === "object") {\n    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) =>\n      [k, /token|secret|authorization|password|api.?key/i.test(k) ? "[REDACTED]" : clean(v)]));\n  }\n  return value;\n}\n\nexport function log(level: Level, event: string, data: Record<string, unknown> = {}): void {\n  const artifactJobId = currentArtifactJobId();\n  const entry = {\n    ts: new Date().toISOString(),\n    level,\n    event,\n    ...(artifactJobId && !("jobId" in data) ? { jobId: artifactJobId } : {}),\n    ...clean(data) as object,\n  };\n  const line = JSON.stringify(entry);\n  appendCurrentArtifactLog(line);\n  if (level === "error") console.error(line);\n  else if (level === "warn") console.warn(line);\n  else console.log(line);\n}\n`,
);

replaceOnce(
  "src/server/openai-agent.ts",
  `import { log } from "./log.js";`,
  `import { log } from "./log.js";\nimport { withArtifactRunLog } from "./artifact-run-log.js";`,
);
replaceOnce(
  "src/server/openai-agent.ts",
  `  private async run(jobId: string): Promise<void> {\n    const job = this.db.getJob(jobId);`,
  `  private async run(jobId: string): Promise<void> {\n    const job = this.db.getJob(jobId);\n    if (!job) return;\n    const isArtifact = [\n      "research",\n      "analysis",\n      "presentation",\n      "document",\n      "website",\n    ].includes(job.kind);\n    if (!isArtifact) return this.runInternal(jobId);\n    return withArtifactRunLog(this.config, jobId, async () => {\n      log("info", "artifact.run_log_started", {\n        jobId,\n        kind: job.kind,\n        status: job.status,\n      });\n      try {\n        await this.runInternal(jobId);\n      } finally {\n        const finalJob = this.db.getJob(jobId);\n        log("info", "artifact.run_log_finished", {\n          jobId,\n          kind: job.kind,\n          status: finalJob?.status ?? "missing",\n          progress: finalJob?.progress ?? null,\n          error: finalJob?.error ?? null,\n        });\n      }\n    });\n  }\n\n  private async runInternal(jobId: string): Promise<void> {\n    const job = this.db.getJob(jobId);`,
);

replaceOnce(
  "src/server/routes.ts",
  `import { log } from "./log.js";`,
  `import { log } from "./log.js";\nimport { readArtifactRunLog } from "./artifact-run-log.js";`,
);
replaceOnce(
  "src/server/routes.ts",
  `  r.post("/jobs/:id/retry", (req, res) => {`,
  `  r.get("/jobs/:id/logs", (req, res) => {\n    const j = db.getJob(req.params.id);\n    if (!j) return res.status(404).json({ error: "Job not found" });\n    if (j.kind === "chat")\n      return res.status(400).json({ error: "Run logs are available for artifact jobs only" });\n    const logs = readArtifactRunLog(config, j.id);\n    res.type("text/plain; charset=utf-8").send(\n      logs ||\n        JSON.stringify({\n          ts: new Date().toISOString(),\n          level: "info",\n          event: "artifact.run_log_empty",\n          jobId: j.id,\n          status: j.status,\n          message: "No structured artifact logs have been recorded for this run yet.",\n        }) + "\\n",\n    );\n  });\n  r.post("/jobs/:id/retry", (req, res) => {`,
);

replaceOnce(
  "src/web/api.ts",
  `  createJob: (input: {`,
  `  jobLogs: async (id: string): Promise<string> => {\n    const response = await fetch(\\`/api/jobs/\\${id}/logs\\`, {\n      headers: { Accept: "text/plain" },\n    });\n    const text = await response.text();\n    if (!response.ok) {\n      let message = text || \\`Log request failed (\\${response.status})\\`;\n      try {\n        message = JSON.parse(text).error || message;\n      } catch {}\n      throw new Error(message);\n    }\n    return text;\n  },\n  createJob: (input: {`,
);

replaceOnce(
  "src/web/main.tsx",
  `  const [skills, setSkills] = useState<SkillView[]>([]),`,
  `  const [artifactLogs, setArtifactLogs] = useState<string | null>(null);\n  const [artifactLogsBusy, setArtifactLogsBusy] = useState(false);\n  const [artifactLogsCopied, setArtifactLogsCopied] = useState(false);\n  const [skills, setSkills] = useState<SkillView[]>([]),`,
);
replaceOnce(
  "src/web/main.tsx",
  `  useEffect(() => {\n    const chatLog = chatLogRef.current;`,
  `  useEffect(() => {\n    setArtifactLogs(null);\n    setArtifactLogsCopied(false);\n  }, [selected]);\n  useEffect(() => {\n    const chatLog = chatLogRef.current;`,
);
replaceOnce(
  "src/web/main.tsx",
  `            {detail?.approvals.map((approval) => (`,
  `            {current.kind !== "chat" && (\n              <div className="artifactLogActions">\n                <button\n                  className="textButton"\n                  disabled={artifactLogsBusy}\n                  onClick={async () => {\n                    if (artifactLogs !== null) {\n                      setArtifactLogs(null);\n                      setArtifactLogsCopied(false);\n                      return;\n                    }\n                    setArtifactLogsBusy(true);\n                    setArtifactLogsCopied(false);\n                    try {\n                      setArtifactLogs(await api.jobLogs(current.id));\n                    } catch (error) {\n                      setErr((error as Error).message);\n                    } finally {\n                      setArtifactLogsBusy(false);\n                    }\n                  }}\n                >\n                  {artifactLogsBusy\n                    ? "Opening run logs…"\n                    : artifactLogs === null\n                      ? "Open / copy artifact run logs"\n                      : "Hide artifact run logs"}\n                </button>\n                {artifactLogs !== null && (\n                  <div className="artifactLogPanel">\n                    <div className="artifactLogHeader">\n                      <div>\n                        <h2>Artifact run logs</h2>\n                        <small>Complete structured log stream for this artifact job. Secrets are redacted.</small>\n                      </div>\n                      <div>\n                        <button\n                          className="textButton"\n                          disabled={artifactLogsBusy}\n                          onClick={async () => {\n                            setArtifactLogsBusy(true);\n                            try {\n                              setArtifactLogs(await api.jobLogs(current.id));\n                              setArtifactLogsCopied(false);\n                            } catch (error) {\n                              setErr((error as Error).message);\n                            } finally {\n                              setArtifactLogsBusy(false);\n                            }\n                          }}\n                        >\n                          Refresh\n                        </button>\n                        <button\n                          className="run"\n                          onClick={async () => {\n                            try {\n                              await navigator.clipboard.writeText(artifactLogs);\n                              setArtifactLogsCopied(true);\n                            } catch {\n                              setArtifactLogsCopied(false);\n                              setErr("Clipboard access was unavailable. Select the log text below and copy it manually.");\n                            }\n                          }}\n                        >\n                          {artifactLogsCopied ? "Copied" : "Copy all logs"}\n                        </button>\n                      </div>\n                    </div>\n                    <textarea\n                      className="artifactLogText"\n                      value={artifactLogs}\n                      readOnly\n                      spellCheck={false}\n                      aria-label="Artifact run logs"\n                      onFocus={(event) => event.currentTarget.select()}\n                    />\n                  </div>\n                )}\n              </div>\n            )}\n            {detail?.approvals.map((approval) => (`,
);

fs.appendFileSync(
  "src/web/styles.css",
  `\n.artifactLogActions {\n  display: grid;\n  gap: 0.65rem;\n}\n.artifactLogPanel {\n  background: #0b1a24;\n  border: 1px solid #345469;\n  border-radius: 14px;\n  padding: 1rem;\n  display: grid;\n  gap: 0.8rem;\n}\n.artifactLogHeader {\n  display: flex;\n  justify-content: space-between;\n  align-items: flex-start;\n  gap: 1rem;\n}\n.artifactLogHeader h2 {\n  margin: 0 0 0.25rem;\n  font-size: 1rem;\n}\n.artifactLogHeader small {\n  color: #8fa4b1;\n}\n.artifactLogHeader > div:last-child {\n  display: flex;\n  align-items: center;\n  gap: 0.65rem;\n  flex-wrap: wrap;\n  justify-content: flex-end;\n}\n.artifactLogHeader .run {\n  padding: 0.55rem 0.8rem;\n}\n.artifactLogText {\n  width: 100%;\n  min-height: 360px;\n  max-height: 60vh;\n  resize: vertical;\n  border: 1px solid #244255;\n  border-radius: 10px;\n  background: #061018;\n  color: #d9e5eb;\n  padding: 0.85rem;\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 0.78rem;\n  line-height: 1.45;\n  white-space: pre;\n}\n@media (max-width: 720px) {\n  .artifactLogHeader {\n    display: grid;\n  }\n  .artifactLogHeader > div:last-child {\n    justify-content: flex-start;\n  }\n  .artifactLogText {\n    min-height: 300px;\n  }\n}\n`,
);

replaceOnce(
  "src/server/__tests__/agent.test.ts",
  `          if (request.tools?.length)\n            return {\n              id: \\`resp_\\${kind}_evidence\\`,\n              status: "completed",\n              output_text:\n                "Verified evidence dossier with complete findings and https://example.com/verified-source.",\n              output: [],\n            };`,
  `          if (request.tools?.length)\n            return {\n              id: \\`resp_\\${kind}_evidence\\`,\n              status: "completed",\n              output_text:\n                kind === "analysis"\n                  ? "Verified evidence dossier from executed Python: A=10, B=20, C=30. https://example.com/verified-source."\n                  : "Verified evidence dossier with complete findings and https://example.com/verified-source.",\n              output:\n                kind === "analysis"\n                  ? [\n                      {\n                        type: "code_interpreter_call",\n                        status: "completed",\n                        outputs: [{ type: "logs", logs: "A=10\\nB=20\\nC=30" }],\n                      },\n                    ]\n                  : [],\n            };`,
);

fs.writeFileSync(
  "src/server/__tests__/artifact-run-log.test.ts",
  `import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nimport { afterEach, describe, expect, it } from "vitest";\nimport type { Config } from "../config";\nimport { log } from "../log";\nimport { readArtifactRunLog, withArtifactRunLog } from "../artifact-run-log";\n\nconst roots: string[] = [];\nafterEach(() => {\n  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });\n});\n\ndescribe("artifact run logs", () => {\n  it("captures the complete structured stream for one artifact job and keeps secrets redacted", async () => {\n    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-artifact-log-"));\n    roots.push(root);\n    const config = { dataDir: root } as Config;\n\n    await withArtifactRunLog(config, "job-logs-1", async () => {\n      log("info", "artifact.first", { value: 42, apiKey: "top-secret" });\n      await Promise.resolve();\n      log("warn", "artifact.second", { detail: "still here" });\n    });\n\n    const text = readArtifactRunLog(config, "job-logs-1");\n    const lines = text.trim().split("\\n").map((line) => JSON.parse(line));\n    expect(lines).toHaveLength(2);\n    expect(lines[0]).toMatchObject({\n      event: "artifact.first",\n      jobId: "job-logs-1",\n      value: 42,\n      apiKey: "[REDACTED]",\n    });\n    expect(lines[1]).toMatchObject({\n      event: "artifact.second",\n      jobId: "job-logs-1",\n      detail: "still here",\n    });\n    expect(text).not.toContain("top-secret");\n  });\n});\n`,
);

console.log("Artifact run logs UI migration applied.");
