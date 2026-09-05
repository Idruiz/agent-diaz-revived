from pathlib import Path

p = Path('src/server/openai-agent.ts')
text = p.read_text()

old = '''    } catch (e: any) {\n      const message = e instanceof Error ? e.message : "Unknown job failure";\n      const current = this.db.getJob(jobId);\n      if (current?.status === "cancelled") {\n        log("info", "job.cancelled_preserved", { jobId, kind: current.kind });\n        return;\n      }\n      const artifactKinds = [\n'''
new = '''    } catch (e: any) {\n      const message = e instanceof Error ? e.message : "Unknown job failure";\n      if (String(this.db.getJob(jobId)?.status ?? "") === "cancelled") {\n        log("info", "job.cancelled_preserved", { jobId });\n        return;\n      }\n      const current = this.db.getJob(jobId);\n      const artifactKinds = [\n'''
assert old in text, 'cancellation guard anchor missing'
text = text.replace(old, new, 1)

old = '''          const v2Enabled =\n            process.env.AGENT_RUNTIME !== "legacy" &&\n            (this.config.NODE_ENV !== "test" || process.env.AGENT_RUNTIME === "v2");\n'''
new = '''          const v2Enabled = process.env.AGENT_RUNTIME !== "legacy";\n'''
assert old in text, 'v2Enabled anchor missing'
text = text.replace(old, new, 1)

p.write_text(text)
print('V2 retry recovery TypeScript narrowing fix applied')
