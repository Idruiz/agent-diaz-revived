# Agent Díaz Artifact Overhaul — Decision Log

## 2026-09-02 — Branch naming tool constraint
DECISION: Use `codex/overhaul-artifact-pipeline` instead of the requested `overhaul/artifact-pipeline`.
REASON: The repository write tool rejected creation of the requested branch name twice and accepted the assistant-owned `codex/` namespace. The branch starts from exact main SHA `fa29f91ac3ebb3fa6b99a58628f75927597ce038`. Main and Render remain untouched.

## Deferred
None.

## Step 1 — Failure taxonomy, fingerprint, budget, diagnostics
DECISION: Persist artifact orchestration state in `jobs.artifact_run_state_json`.
REASON: LLM-call budgets and fingerprints must survive a service restart rather than resetting in memory.

DECISION: Set the artifact LLM-call budget to 6 and wall-time budget to 20 minutes.
REASON: The overhaul specification requires visible bounded spend and wall time. Six is the requested default cap; 20 minutes leaves room for Office validation while preventing unbounded jobs.

DECISION: BUILD and ASSET failures get one deterministic same-plan retry and never trigger a plan-repair LLM call.
REASON: A builder/package or retrieval failure is not evidence that the plan content is wrong. Repeating the same fingerprint twice stops the identical loop.

DECISION: INFRA failures set job status `blocked`, expose `blocked: infrastructure`, and use production-only exponential retry without an LLM call.
REASON: Missing/timeout renderers and validator/provider infrastructure are operational failures. Test environments suppress timers to keep regression tests deterministic.

DECISION: A blocked infrastructure retry resumes from the structure/build phase when a provider response already exists.
REASON: Reinterpreting a stored structure response as evidence would spend another LLM call and corrupt phase semantics.

DECISION: Failed BUILD packages remain at the build path and are copied with JSON metadata to `storage/diagnostics/<jobId>/`.
REASON: The previous deletion destroyed forensic evidence. No diagnostic copy is published as an artifact.

DECISION: Update the legacy “requires regeneration” test to assert the typed `BUILD` failure and retained specimen.
REASON: The old string and deletion expectation encoded the behavior Step 1 intentionally replaces; the test remains and now asserts the stronger failure contract.

DECISION: Touch `src/shared/contracts.ts` only to add the canonical `blocked` job state.
REASON: The execution order names the job-status enum under `db.ts`, but this repository stores the canonical enum in `src/shared/contracts.ts`; no other contract behavior changed.

## Deferred
- Step 2 will replace first-error plan validation with normalization plus batched `PLAN_CONTENT` violations.

## Step 2 — NORMALIZE and plan-gate deletion
DECISION: Provider structured-output schema accepts 1–30 presentation sections; deterministic NORMALIZE owns the 11-section maximum.
REASON: Provider rejection prevents computable excess-section reconciliation and wastes an LLM round trip.

DECISION: A presentation below seven content sections remains a mandatory PLAN_CONTENT violation, while excess sections are deterministically merged.
REASON: Missing substantive content cannot be invented safely by code; excess content can be reconciled without model judgment.

DECISION: Duplicate image queries, duplicate requirement IDs, unknown requirement IDs, missing chart sourceNote, and excess sections are code-owned normalizations.
REASON: These are computable structural defects and must not consume plan-repair calls.

DECISION: Short speaker notes are retained and recorded as warnings rather than hard failures.
REASON: Character count is not a reliable proxy for teaching quality and the spec explicitly removes the note-length gate.

DECISION: Remove the language-specific CULTURE_RE content scan and use prompt-to-mandatory-requirement coverage instead.
REASON: Culture must be represented as an extracted user requirement, not inferred from English/French keyword occurrence in arbitrary slide copy.

DECISION: PLAN_CONTENT validation returns a batched list and permits at most two plan-repair LLM calls; after that only non-mandatory score-like violations may be downgraded into receipt normalizations.
REASON: Mandatory missing content still needs model judgment, while visual-count targets and similar quality scores must not cause an unbounded repair loop.

DECISION: Interpret Step 2's §4 deletion requirement as the plan-gate subset owned by Step 2. Remaining §4 deletions stay in their explicitly scheduled steps: image-count throw and honey special case in Step 3, DOCX post-serialization repair in Step 5, website split/base64 duplication in Step 6.
REASON: The autonomous order simultaneously restricts Step 2 file scope to plan/quality/contracts/tests and assigns those later deletions to Steps 3/5/6. Touching them in Step 2 would violate the file-scope rail and combine steps.

DECISION: Raise the parameterized deterministic builder test timeout from 5s to 15s.
REASON: The full validation suite now runs more concurrent Office/render work; the test body and assertions are unchanged and the prior 5s boundary became timing-sensitive in CI.

## Deferred
- Step 3: remove image-count throws and the honey/bee special case while replacing image retrieval with candidate filtering plus one artifact-level judgment call.
- Step 5: remove `repairDocumentBuffer()` and post-serialization DOCX XML editing.
- Step 6: remove hard-coded website page splitting and repeated base64 image embedding.
