import fs from "node:fs";

function replaceExact(path, before, after) {
  let source = fs.readFileSync(path, "utf8");
  if (!source.includes(before))
    throw new Error(`Expected block not found in ${path}: ${before.slice(0, 100)}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

// Receipt contract: provenance is attached only after AgentRunner has validated
// the structured analysis plan against executed evidence.
replaceExact(
  "src/server/artifact-quality.ts",
  'import { log } from "./log.js";\n',
  'import { log } from "./log.js";\nimport type { AnalysisNumericProvenanceReceipt } from "./artifact-provenance.js";\n',
);
replaceExact(
  "src/server/artifact-quality.ts",
  '  qualityWarnings: ArtifactNormalizationReceipt[];\n}\n',
  '  qualityWarnings: ArtifactNormalizationReceipt[];\n  analysisProvenance?: AnalysisNumericProvenanceReceipt;\n}\n',
);

// Persist only compact provenance facts in the existing JSON run state. This
// survives restarts without storing a second copy of the evidence dossier.
replaceExact(
  "src/server/db.ts",
  '  attempts: ArtifactAttemptReceipt[];\n}\n',
  '  attempts: ArtifactAttemptReceipt[];\n  evidenceNumericValues?: string[];\n  evidencePythonExecuted?: boolean;\n}\n',
);

// AgentRunner integration.
replaceExact(
  "src/server/openai-agent.ts",
  'import { compileArtifactPlan } from "./artifact-compiler.js";\n',
  'import { compileArtifactPlan } from "./artifact-compiler.js";\nimport {\n  assertAnalysisNumericProvenance,\n  completedCodeInterpreterCalls,\n  evidenceNumericValues,\n  type AnalysisNumericProvenanceReceipt,\n} from "./artifact-provenance.js";\n',
);

replaceExact(
  "src/server/openai-agent.ts",
  '      const createEvidenceResponse = async () => {\n        const instructions = [\n',
  '      const analysisHasSpreadsheet =\n        job.kind === "analysis" &&\n        this.db\n          .getUploads(this.db.getJobFileIds(jobId))\n          .some((upload) => isSpreadsheetUpload(upload.name, upload.mime));\n\n      const createEvidenceResponse = async () => {\n        const instructions = [\n',
);

replaceExact(
  "src/server/openai-agent.ts",
  '        const request = {\n          model: job.model,\n          reasoning: { effort: job.reasoningEffort, context: "all_turns" },\n          instructions,\n          input: activeMessages.map((message) => this.messageInput(message)),\n          tools: this.toolset(activeMessages, skill.tools),\n          background: true,\n',
  '        const tools = this.toolset(activeMessages, skill.tools);\n        const request = {\n          model: job.model,\n          reasoning: { effort: job.reasoningEffort, context: "all_turns" },\n          instructions,\n          input: activeMessages.map((message) => this.messageInput(message)),\n          tools,\n          ...(analysisHasSpreadsheet\n            ? {\n                tool_choice: {\n                  type: "allowed_tools",\n                  mode: "required",\n                  tools: [{ type: "code_interpreter" }],\n                },\n              }\n            : {}),\n          background: true,\n',
);

replaceExact(
  "src/server/openai-agent.ts",
  '      if (isArtifact) {\n        let structureResponse: any;\n        if (resumingStructure) {\n',
  '      if (isArtifact) {\n        let structureResponse: any;\n        const canResumeStructure =\n          resumingStructure &&\n          (job.kind !== "analysis" ||\n            Array.isArray(artifactRunState?.evidenceNumericValues));\n        if (canResumeStructure) {\n',
);

replaceExact(
  "src/server/openai-agent.ts",
  '          let evidenceResponse: any;\n          if (existingResponseId)\n            evidenceResponse = await this.client.responses.retrieve(\n              existingResponseId,\n            );\n          else {\n',
  '          let evidenceResponse: any;\n          if (existingResponseId && !resumingStructure)\n            evidenceResponse = await this.client.responses.retrieve(\n              existingResponseId,\n            );\n          else {\n',
);

replaceExact(
  "src/server/openai-agent.ts",
  '          const evidence = evidenceResponse.output_text?.trim() || "";\n          if (!evidence)\n            throw new Error("Evidence phase returned no usable content");\n          structureResponse = await createStructureResponse(evidence);\n',
  '          const evidence = evidenceResponse.output_text?.trim() || "";\n          if (!evidence)\n            throw new Error("Evidence phase returned no usable content");\n          if (job.kind === "analysis") {\n            const pythonCalls = completedCodeInterpreterCalls(evidenceResponse);\n            if (analysisHasSpreadsheet && pythonCalls < 1)\n              throw new ArtifactPipelineError(\n                "INFRA",\n                "Analysis evidence contract failed: the uploaded spreadsheet was not executed with code_interpreter",\n                { ruleOrPart: "analysis-python-evidence" },\n              );\n            if (artifactRunState) {\n              artifactRunState.evidenceNumericValues = evidenceNumericValues(\n                evidence,\n                evidenceResponse,\n              );\n              artifactRunState.evidencePythonExecuted = pythonCalls > 0;\n              persistArtifactRunState();\n            }\n            log("info", "artifact.analysis_evidence_provenance", {\n              jobId,\n              spreadsheetRequired: analysisHasSpreadsheet,\n              pythonCalls,\n              numericValues:\n                artifactRunState?.evidenceNumericValues?.length ?? 0,\n            });\n          }\n          structureResponse = await createStructureResponse(evidence);\n',
);

replaceExact(
  "src/server/openai-agent.ts",
  '          let planNormalizations: ArtifactNormalizationReceipt[] = [];\n          let repairAttempt = 0;\n          let buildAttempt = 0;\n',
  '          let planNormalizations: ArtifactNormalizationReceipt[] = [];\n          let analysisProvenance: AnalysisNumericProvenanceReceipt | null = null;\n          let repairAttempt = 0;\n          let buildAttempt = 0;\n',
);

replaceExact(
  "src/server/openai-agent.ts",
  '                plan = parsedPlan.plan;\n                planNormalizations = parsedPlan.normalizations;\n                if (repairAttempt > 0)\n',
  '                plan = parsedPlan.plan;\n                planNormalizations = parsedPlan.normalizations;\n                analysisProvenance =\n                  job.kind === "analysis"\n                    ? assertAnalysisNumericProvenance({\n                        plan,\n                        prompt: job.prompt,\n                        evidenceNumericValues:\n                          artifactRunState?.evidenceNumericValues ?? [],\n                        pythonExecuted:\n                          artifactRunState?.evidencePythonExecuted ?? null,\n                      })\n                    : null;\n                if (repairAttempt > 0)\n',
);

replaceExact(
  "src/server/openai-agent.ts",
  '              file.validationReceipt.normalizations = [\n                ...planNormalizations,\n              ];\n              const id = crypto.randomUUID();\n',
  '              file.validationReceipt.normalizations = [\n                ...planNormalizations,\n              ];\n              if (job.kind === "analysis" && analysisProvenance)\n                file.validationReceipt.analysisProvenance = analysisProvenance;\n              const id = crypto.randomUUID();\n',
);

// Golden analysis evidence now represents a real completed Python execution and
// includes every exact number later used by the structure plan.
replaceExact(
  "src/server/__tests__/artifact-golden.test.ts",
  '                output_text: [\n                  "Recorded golden evidence dossier.",\n                  sourceText(golden.plan),\n                ].join("\\n"),\n                output: [],\n',
  '                output_text: [\n                  "Recorded golden evidence dossier.",\n                  ...(golden.kind === "analysis"\n                    ? [\n                        "Executed Python findings: January 12, February 15, March 18, April 24; month-to-month changes 3, 3, 6; net increase 12.",\n                      ]\n                    : []),\n                  sourceText(golden.plan),\n                ].join("\\n"),\n                output:\n                  golden.kind === "analysis"\n                    ? [\n                        {\n                          id: "ci_golden_analysis",\n                          type: "code_interpreter_call",\n                          status: "completed",\n                          code: "# executed fixture analysis",\n                          outputs: [\n                            {\n                              type: "logs",\n                              logs: "values=12,15,18,24; changes=3,3,6; net=12",\n                            },\n                          ],\n                        },\n                      ]\n                    : [],\n',
);

replaceExact(
  "src/server/__tests__/artifact-golden.test.ts",
  '        expect(receipt.maxLlmCalls).toBe(6);\n\n        let checkpointName: string | null = null;\n',
  '        expect(receipt.maxLlmCalls).toBe(6);\n        if (golden.kind === "analysis") {\n          const evidenceRequest = create.mock.calls[0]![0] as any;\n          expect(evidenceRequest.tool_choice).toEqual({\n            type: "allowed_tools",\n            mode: "required",\n            tools: [{ type: "code_interpreter" }],\n          });\n          expect(\n            evidenceRequest.tools.find(\n              (tool: any) => tool.type === "code_interpreter",\n            )?.container?.file_ids,\n          ).toContain(`file_${golden.id}`);\n          expect(receipt.analysisProvenance).toMatchObject({\n            source: "prompt+evidence",\n            pythonExecuted: true,\n            unmatchedNumericClaims: [],\n          });\n          expect(\n            receipt.analysisProvenance.numericClaimsChecked,\n          ).toBeGreaterThan(0);\n        }\n\n        let checkpointName: string | null = null;\n',
);

// Record the new invariant in the permanent branch checkpoint.
replaceExact(
  "docs/ARTIFACT_TRUST_REBUILD_2026-09-04.md",
  '- Finished-file validation remains strict for package integrity, OOXML/Microsoft 365 schema checks (with the documented PptxGenJS notesMaster ordering exception), LibreOffice rendering, required visible-content coverage, internal website resource integrity, and deterministic artifact receipts.\n',
  '- Finished-file validation remains strict for package integrity, OOXML/Microsoft 365 schema checks (with the documented PptxGenJS notesMaster ordering exception), LibreOffice rendering, required visible-content coverage, internal website resource integrity, and deterministic artifact receipts.\n- Spreadsheet analysis forces a completed code_interpreter call during evidence gathering, persists the executed numeric evidence across restarts, and rejects any numerical claim introduced only during JSON structuring.\n',
);
