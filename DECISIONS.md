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
