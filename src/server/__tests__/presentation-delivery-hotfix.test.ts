import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const buildArtifactMock = vi.hoisted(() => vi.fn());
vi.mock("../builders", () => ({ buildArtifact: buildArtifactMock }));

import { openDatabase } from "../db";
import {
  AgentRunner,
  artifactFailureFingerprint,
  modelProfileFor,
} from "../openai-agent";
import { ArtifactPipelineError } from "../artifact-quality";
import type { Config } from "../config";

const roots: string[] = [];
afterEach(() => {
  buildArtifactMock.mockReset();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-delivery-hotfix-"));
  roots.push(root);
  const config = {
    root,
    storageRoot: root,
    dataDir: path.join(root, "data"),
    artifactDir: path.join(root, "artifacts"),
    uploadDir: path.join(root, "uploads"),
    NODE_ENV: "test",
    PORT: 3000,
    BASE_URL: "http://localhost:3000",
    OPENAI_API_KEY: crypto.randomUUID(),
    ADMIN_PASSWORD: crypto.randomUUID(),
    OPENAI_MODEL: "gpt-5.6",
    OPENAI_FAST_MODEL: "gpt-5.6-terra",
    OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
    STORAGE_DIR: "",
    SESSION_DAYS: 7,
    MAX_UPLOAD_MB: 25,
    IMAGE_PROVIDER: "wikimedia",
    MCP_SERVER_URL: "",
    MCP_SERVER_LABEL: "workspace",
    MCP_AUTHORIZATION: "",
  } satisfies Config;
  fs.mkdirSync(config.artifactDir, { recursive: true });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  return { config, db: openDatabase(config) };
}

function validPresentationPlan() {
  return {
    title: "Bounded presentation delivery",
    subtitle: "Regression fixture",
    requirements: [
      {
        id: "R1",
        text: "Create a complete presentation",
        mandatory: true,
      },
    ],
    sections: Array.from({ length: 7 }, (_, index) => ({
      heading: `Section ${index + 1}`,
      body:
        `Finished audience-facing explanation for section ${index + 1}. ` +
        "This sentence deliberately contains enough concrete content for deterministic output coverage.",
      bullets: [
        "Complete supporting point with finished content",
        "Second supporting point with finished content",
      ],
      speakerNotes:
        "Presenter note with enough detail to support delivery and classroom use.",
      requirementIds: ["R1"],
      layout: "standard",
      ...(index < 4
        ? { imageQuery: `documentary classroom scene ${index + 1}` }
        : {}),
    })),
    sources: [],
  };
}

describe("presentation delivery hotfix", () => {
  it("treats regenerated package SHAs as evidence, not distinct retry identities", () => {
    const base = {
      failureClass: "BUILD" as const,
      ruleOrPart: "pptx-layout",
      planSha: "same-plan",
      strategy: "same-plan-build",
    };
    expect(
      artifactFailureFingerprint({ ...base, packageSha: "package-a" }),
    ).toBe(
      artifactFailureFingerprint({ ...base, packageSha: "package-b" }),
    );
    expect(
      artifactFailureFingerprint({ ...base, packageSha: "package-a" }),
    ).not.toBe(
      artifactFailureFingerprint({
        ...base,
        ruleOrPart: "different-rule",
        packageSha: "package-a",
      }),
    );
  });

  it("never allows a same-plan deterministic build failure to reach attempt 6", async () => {
    const { config, db } = harness();
    const conversation = db.createConversation(
      crypto.randomUUID(),
      "Bounded presentation build",
    );
    const job = db.createJob({
      id: crypto.randomUUID(),
      kind: "presentation",
      prompt: "Create a complete presentation",
      conversationId: conversation.id,
      fileIds: [],
      ...modelProfileFor("balanced"),
    });
    db.addMessage({
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      role: "user",
      content: job.prompt,
      jobId: job.id,
    });
    db.updateJob(job.id, {
      providerResponseId: "resp_structure",
      status: "building",
      progress: 82,
      message: "Building and validating artifact",
    });

    const planText = JSON.stringify(validPresentationPlan());
    const retrieve = vi.fn(async () => ({
      id: "resp_structure",
      status: "completed",
      output_text: planText,
      output: [],
    }));
    const runner = new AgentRunner(config, db);
    (runner as any).client = { responses: { retrieve } };

    buildArtifactMock
      .mockRejectedValueOnce(
        new ArtifactPipelineError(
          "BUILD",
          "Deterministic build failed with package A",
          { ruleOrPart: "pptx-test", packageSha: "package-a" },
        ),
      )
      .mockRejectedValueOnce(
        new ArtifactPipelineError(
          "BUILD",
          "Deterministic build failed with package B",
          { ruleOrPart: "pptx-test", packageSha: "package-b" },
        ),
      );

    await (runner as any).run(job.id);

    expect(buildArtifactMock).toHaveBeenCalledTimes(2);
    expect(db.getJob(job.id)).toMatchObject({
      status: "failed",
      progress: 91,
    });
    expect(db.getJob(job.id)?.message).toBe("Artifact stopped: build");
    expect(db.getJob(job.id)?.error).toMatch(
      /Same-plan build retry budget exhausted after 2 attempts/,
    );
    const runState = db.getArtifactRunState(job.id)!;
    expect(runState.attempts).toHaveLength(2);
    expect(runState.attempts[0]!.fingerprint).toBe(
      runState.attempts[1]!.fingerprint,
    );
    db.close();
  }, 5_000);
});
