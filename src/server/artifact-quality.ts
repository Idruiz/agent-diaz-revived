import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { validateFile } from "@xarsh/ooxml-validator";
import type { ArtifactPlan, JobKind } from "../shared/contracts.js";
import { log } from "./log.js";

const PLACEHOLDER_RE = /\b(?:todo|tbd|lorem ipsum|placeholder|insert (?:text|content|image)|add (?:content|details)|coming soon)\b|\[(?:insert|add|todo)[^\]]*\]/i;
const SPEED_DATING_RE = /speed[\s-]*dating/i;
const FOUR_CORNERS_RE = /(?:four|4)[\s-]*corners/i;
const TEACHING_RE = /\b(?:teach|teaching|lesson|students?|classroom|practice)\b/i;
const CULTURE_RE = /\b(?:culture|cultural|francophone|France|French society|French-speaking)\b/i;
const SCHEMA_VALIDATOR = "Open XML SDK 3.5.1 (via @xarsh/ooxml-validator 0.3.0)";
const PPTX_GENERATOR = "pptxgenjs 4.0.1";
const DOCX_GENERATOR = "docx 9.5.1";
const PPTX_NOTES_MASTER_INCIDENT = "2026-09-02 PowerPoint notesMasterIdLst ordering incident";
const KNOWN_BENIGN_NOTES_MASTER_FINDING = {
  id: "Sch_UnexpectedElementContentExpectingComplex",
  path: "/ppt/presentation.xml",
  xPath: "/p:presentation[1]",
  descriptionIncludes: "notesMasterIdLst",
} as const;

export interface DocumentRepairStats {
  drawingIdsReassigned: number;
}

export interface ArtifactValidationFinding {
  id?: string;
  path?: string;
  xPath?: string;
  description?: string;
  errorType?: string;
  reason: string;
  incident: string;
}

export type ArtifactFailureClass =
  | "PLAN_CONTENT"
  | "PLAN_NORMALIZABLE"
  | "ASSET"
  | "BUILD"
  | "INFRA";

export interface ArtifactAttemptReceipt {
  failureClass: ArtifactFailureClass;
  fingerprint: string;
  ruleOrPart: string;
  planSha: string;
  packageSha: string | null;
  strategy: string;
  diagnosticPath: string | null;
  at: string;
}

export class ArtifactPipelineError extends Error {
  readonly failureClass: ArtifactFailureClass;
  readonly ruleOrPart: string;
  readonly packageSha: string | null;
  diagnosticPath: string | null;

  constructor(
    failureClass: ArtifactFailureClass,
    message: string,
    options: {
      ruleOrPart?: string;
      packageSha?: string | null;
      diagnosticPath?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ArtifactPipelineError";
    this.failureClass = failureClass;
    this.ruleOrPart = options.ruleOrPart ?? "unknown";
    this.packageSha = options.packageSha ?? null;
    this.diagnosticPath = options.diagnosticPath ?? null;
  }
}

export interface ArtifactValidationReceipt {
  kind: JobKind;
  artifactSha256: string;
  bytes: number;
  requirements: number;
  schemaValidator: string | null;
  renderValidator: string | null;
  powerPointDesktopValidated: boolean;
  buildSha: string;
  generatorVersion: string;
  knownBenignFindings: ArtifactValidationFinding[];
  llmCalls: number;
  maxLlmCalls: number;
  wallTimeMs: number;
  attempts: ArtifactAttemptReceipt[];
}

export function asArtifactPipelineError(
  error: unknown,
  fallbackClass: ArtifactFailureClass = "BUILD",
  fallbackPart = "unknown",
): ArtifactPipelineError {
  if (error instanceof ArtifactPipelineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ArtifactPipelineError(fallbackClass, message, {
    ruleOrPart: fallbackPart,
    cause: error,
  });
}

function currentBuildSha(): string {
  return (
    process.env.RENDER_GIT_COMMIT?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    "unknown"
  );
}

function isKnownBenignFinding(error: any): boolean {
  const xPath = error?.xPath ?? error?.xpath;
  return (
    error?.id === KNOWN_BENIGN_NOTES_MASTER_FINDING.id &&
    error?.path === KNOWN_BENIGN_NOTES_MASTER_FINDING.path &&
    xPath === KNOWN_BENIGN_NOTES_MASTER_FINDING.xPath &&
    String(error?.description ?? "").includes(
      KNOWN_BENIGN_NOTES_MASTER_FINDING.descriptionIncludes,
    )
  );
}

function benignFindingReceipt(error: any): ArtifactValidationFinding {
  return {
    id: error?.id,
    path: error?.path,
    xPath: error?.xPath ?? error?.xpath,
    description: error?.description,
    errorType: error?.errorType,
    reason:
      "Raw PptxGenJS notesMasterIdLst ordering is accepted by PowerPoint Desktop; reordering it caused PowerPoint to reject the artifact.",
    incident: PPTX_NOTES_MASTER_INCIDENT,
  };
}

function allPlanText(plan: ArtifactPlan): string {
  return [
    plan.title,
    plan.subtitle,
    ...(plan.requirements ?? []).map((requirement) => requirement.text),
    ...plan.sections.flatMap((section) => [
      section.heading,
      section.body,
      ...section.bullets,
      section.speakerNotes,
      ...(section.activity?.directions ?? []),
      ...(section.activity?.prompts ?? []),
      ...(section.activity?.sentenceFrames ?? []),
      ...(section.activity?.cornerLabels ?? []),
    ]),
  ].join("\n");
}

function sectionText(section: ArtifactPlan["sections"][number]): string {
  return [
    section.heading,
    section.body,
    ...section.bullets,
    section.speakerNotes,
    ...(section.activity?.directions ?? []),
    ...(section.activity?.prompts ?? []),
    ...(section.activity?.sentenceFrames ?? []),
    ...(section.activity?.cornerLabels ?? []),
  ].join("\n");
}

function assertActivityQuality(section: ArtifactPlan["sections"][number]): void {
  const activity = section.activity;
  if (!activity) return;
  if (activity.type === "speed_dating") {
    if (activity.prompts.length < 4)
      throw new Error("Artifact quality validation failed: Speed Dating requires at least four usable prompts");
    if (activity.sentenceFrames.length < 2)
      throw new Error("Artifact quality validation failed: Speed Dating requires at least two language frames");
    if (activity.directions.length < 3)
      throw new Error("Artifact quality validation failed: Speed Dating requires setup, rotation, and response directions");
  }
  if (activity.type === "four_corners") {
    if (activity.cornerLabels.length !== 4)
      throw new Error("Artifact quality validation failed: Four Corners requires exactly four corner labels");
    if (activity.prompts.length < 1)
      throw new Error("Artifact quality validation failed: Four Corners requires a decision prompt");
    if (activity.sentenceFrames.length < 2)
      throw new Error("Artifact quality validation failed: Four Corners requires at least two discussion frames");
  }
  if (activity.type === "exit_ticket" && activity.prompts.length < 2)
    throw new Error("Artifact quality validation failed: an exit ticket requires at least two checks");
}

export function assertArtifactPlanQuality(kind: JobKind, prompt: string, plan: ArtifactPlan): void {
  const requirements = plan.requirements ?? [];
  if (prompt.trim() && (
    requirements.length === 0 ||
    requirements.every((item) => !item.mandatory) ||
    requirements.some((item) => /^deliver the requested artifact$/i.test(item.text.trim()))
  ))
    throw new Error("Artifact quality validation failed: prompt-specific mandatory requirements were not extracted");
  const serialized = allPlanText(plan);
  if (PLACEHOLDER_RE.test(serialized))
    throw new Error("Artifact quality validation failed: unfinished placeholder language is present");

  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (ids.has(requirement.id))
      throw new Error(`Artifact quality validation failed: duplicate requirement id ${requirement.id}`);
    ids.add(requirement.id);
  }
  for (const section of plan.sections) {
    for (const id of section.requirementIds ?? [])
      if (!ids.has(id))
        throw new Error(`Artifact quality validation failed: section '${section.heading}' references unknown requirement ${id}`);
    assertActivityQuality(section);
  }
  for (const requirement of requirements.filter((item) => item.mandatory)) {
    const covered = plan.sections.some((section) => (section.requirementIds ?? []).includes(requirement.id));
    if (!covered)
      throw new Error(`Artifact quality validation failed: mandatory requirement ${requirement.id} is not covered: ${requirement.text}`);
  }

  if (kind === "presentation") {
    const activityTypes = new Set(plan.sections.map((section) => section.activity?.type).filter(Boolean));
    if (SPEED_DATING_RE.test(prompt) && !activityTypes.has("speed_dating"))
      throw new Error("Artifact quality validation failed: the prompt explicitly requires a Speed Dating activity slide");
    if (FOUR_CORNERS_RE.test(prompt) && !activityTypes.has("four_corners"))
      throw new Error("Artifact quality validation failed: the prompt explicitly requires a Four Corners activity slide");
    if (TEACHING_RE.test(prompt)) {
      if (!plan.sections.some((section) => section.activity))
        throw new Error("Artifact quality validation failed: a teaching deck requires active student practice");
      const usefulNotes = plan.sections.filter((section) => section.speakerNotes.trim().length >= 20).length;
      if (usefulNotes < Math.ceil(plan.sections.length / 2))
        throw new Error("Artifact quality validation failed: a teaching deck requires useful presenter notes on at least half of its slides");
    }
    if (CULTURE_RE.test(prompt) && !CULTURE_RE.test(serialized))
      throw new Error("Artifact quality validation failed: the requested cultural connection is absent");
  }

  if (kind === "website") {
    const slugs = plan.pages?.map((page) => page.slug) ?? [];
    if (slugs.length !== new Set(slugs).size)
      throw new Error("Artifact quality validation failed: website page slugs must be unique");
    if (!slugs.includes("index"))
      throw new Error("Artifact quality validation failed: website plan requires an index page");
  }
}

export function repairDocumentBuffer(input: Buffer): { buffer: Buffer; stats: DocumentRepairStats } {
  const zip = new AdmZip(input);
  const document = zip.getEntry("word/document.xml");
  if (!document) return { buffer: input, stats: { drawingIdsReassigned: 0 } };
  let nextId = 1;
  const xml = document.getData().toString("utf8").replace(
    /<wp:docPr\b([^>]*?)\bid="\d+"([^>]*)>/g,
    (_match, before: string, after: string) => `<wp:docPr${before}id="${nextId++}"${after}>`,
  );
  document.setData(Buffer.from(xml, "utf8"));
  return { buffer: zip.toBuffer(), stats: { drawingIdsReassigned: nextId - 1 } };
}

function assertRequiredEntries(zip: AdmZip, required: string[]): void {
  const names = new Set(zip.getEntries().map((entry) => entry.entryName));
  for (const name of required)
    if (!names.has(name))
      throw new Error(`Artifact package validation failed: missing required entry ${name}`);
}

function assertCleanXml(zip: AdmZip): void {
  for (const entry of zip.getEntries().filter((item) => item.entryName.endsWith(".xml"))) {
    const xml = entry.getData().toString("utf8");
    if (/(\s[\w:.-]+)="(?:NaN|undefined|null)"/.test(xml))
      throw new Error(`Artifact package validation failed: invalid serialized value in ${entry.entryName}`);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml))
      throw new Error(`Artifact package validation failed: forbidden control character in ${entry.entryName}`);
  }
}

export function assertPresentationPackage(buffer: Buffer): void {
  const zip = new AdmZip(buffer);
  assertRequiredEntries(zip, [
    "[Content_Types].xml",
    "_rels/.rels",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
  ]);
  assertCleanXml(zip);
  const slides = zip.getEntries().filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName));
  if (slides.length < 2)
    throw new Error("Presentation package validation failed: fewer than two slides");

  const presentationXml = zip
    .getEntry("ppt/presentation.xml")!
    .getData()
    .toString("utf8");
  const hasNotes = zip.getEntries().some((entry) =>
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.entryName),
  );
  if (hasNotes) {
    if (/<\/p:sldMasterIdLst>\s*<p:notesMasterIdLst\b/.test(presentationXml))
      throw new Error(
        "Presentation package validation failed: notesMasterIdLst was moved before sldIdLst; PowerPoint Desktop rejects this proven-bad form",
      );
    if (!/<\/p:sldIdLst>\s*<p:notesMasterIdLst\b/.test(presentationXml))
      throw new Error(
        "Presentation package validation failed: notesMasterIdLst is not in the proven PowerPoint-compatible native PptxGenJS position after sldIdLst",
      );
  }
}

export function assertDocumentPackage(buffer: Buffer): void {
  const zip = new AdmZip(buffer);
  assertRequiredEntries(zip, ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  assertCleanXml(zip);
  const documentXml = zip.getEntry("word/document.xml")!.getData().toString("utf8");
  if (!/<w:t[ >]/.test(documentXml))
    throw new Error("Document package validation failed: document contains no visible text");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function packageVisibleText(kind: JobKind, filePath: string): string {
  const zip = new AdmZip(filePath);
  if (kind === "presentation")
    return zip.getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
      .flatMap((entry) => [...entry.getData().toString("utf8").matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]!)))
      .join("\n");
  if (["document", "analysis", "research"].includes(kind)) {
    const xml = zip.getEntry("word/document.xml")?.getData().toString("utf8") ?? "";
    return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXml(match[1]!)).join("\n");
  }
  return zip.getEntries()
    .filter((entry) => entry.entryName.endsWith(".html"))
    .map((entry) => decodeXml(entry.getData().toString("utf8").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")))
    .join("\n");
}

export function assertWebsitePackage(filePath: string): void {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const names = new Set(entries.map((entry) => entry.entryName));
  if (!names.has("index.html") || !names.has("OPEN_ME_FIRST.html"))
    throw new Error("Website package validation failed: missing entry page");
  const htmlEntries = entries.filter((entry) => entry.entryName.endsWith(".html"));
  if (htmlEntries.length < 4)
    throw new Error("Website package validation failed: expected at least three pages plus credits");
  for (const entry of htmlEntries) {
    const html = entry.getData().toString("utf8");
    if (!/<title>[^<]+<\/title>/i.test(html) || !/<nav\b/i.test(html) || !/<main\b/i.test(html))
      throw new Error(`Website package validation failed: incomplete semantic shell in ${entry.entryName}`);
    if (PLACEHOLDER_RE.test(html))
      throw new Error(`Website package validation failed: placeholder content in ${entry.entryName}`);
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1]!;
      if (/^(?:https?:|mailto:|tel:|#)/i.test(href)) continue;
      const target = href.split("#")[0]!;
      if (target && !names.has(target))
        throw new Error(`Website package validation failed: broken internal link '${href}' in ${entry.entryName}`);
    }
  }
}

async function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

async function renderOfficeArtifact(filePath: string): Promise<string | null> {
  const command = process.env.SOFFICE_PATH?.trim() || "soffice";
  const probe = await runProcess(command, ["--version"], 15_000).catch(() => null);
  if (!probe || probe.code !== 0) {
    if (process.env.NODE_ENV === "production")
      throw new ArtifactPipelineError(
        "INFRA",
        "Artifact render validation blocked: LibreOffice is unavailable in production",
        { ruleOrPart: "soffice-probe" },
      );
    log("warn", "artifact.render_skipped", {
      filePath: path.basename(filePath),
      reason: "soffice unavailable outside production",
    });
    return null;
  }
  const version =
    (probe.stdout || probe.stderr).trim().split(/\r?\n/)[0] || "LibreOffice";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-render-"));
  try {
    const profileUrl = pathToFileURL(path.join(tempDir, "profile")).href;
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await runProcess(
        command,
        [
          `-env:UserInstallation=${profileUrl}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          tempDir,
          filePath,
        ],
        90_000,
      );
    } catch (error) {
      throw new ArtifactPipelineError(
        "INFRA",
        `Artifact render validation blocked: ${error instanceof Error ? error.message : String(error)}`,
        { ruleOrPart: "soffice-convert", cause: error },
      );
    }
    if (result.code !== 0)
      throw new ArtifactPipelineError(
        "BUILD",
        `LibreOffice render rejected the artifact: ${result.stderr || result.stdout}`,
        { ruleOrPart: "libreoffice-render" },
      );
    const pdfPath = path.join(tempDir, `${path.parse(filePath).name}.pdf`);
    if (!fs.existsSync(pdfPath))
      throw new ArtifactPipelineError(
        "INFRA",
        "Artifact render validation blocked: LibreOffice produced no PDF",
        { ruleOrPart: "soffice-output" },
      );
    const pdf = fs.readFileSync(pdfPath);
    if (
      pdf.length < 5_000 ||
      pdf.subarray(0, 5).toString("ascii") !== "%PDF-"
    )
      throw new ArtifactPipelineError(
        "INFRA",
        "Artifact render validation blocked: LibreOffice output is invalid or unexpectedly small",
        { ruleOrPart: "soffice-output" },
      );
    return version;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertOutputCoverage(kind: JobKind, prompt: string, plan: ArtifactPlan, visibleText: string): void {
  const normalized = visibleText.replace(/\s+/g, " ").trim();
  if (normalized.length < 200)
    throw new Error("Artifact output validation failed: finished artifact contains too little visible content");
  for (const section of plan.sections) {
    if (!normalized.toLocaleLowerCase().includes(section.heading.toLocaleLowerCase().slice(0, 40)))
      throw new Error(`Artifact output validation failed: section '${section.heading}' is missing from the finished artifact`);
  }
  if (kind === "presentation" && SPEED_DATING_RE.test(prompt) && !SPEED_DATING_RE.test(normalized))
    throw new Error("Artifact output validation failed: Speed Dating is missing from the finished deck");
  if (kind === "presentation" && FOUR_CORNERS_RE.test(prompt) && !FOUR_CORNERS_RE.test(normalized))
    throw new Error("Artifact output validation failed: Four Corners is missing from the finished deck");
}

export async function validateBuiltArtifact(
  kind: JobKind,
  prompt: string,
  plan: ArtifactPlan,
  filePath: string,
  diagnostics?: { root: string; jobId: string },
): Promise<ArtifactValidationReceipt> {
  try {
    const buffer = fs.readFileSync(filePath);
    if (kind === "presentation") assertPresentationPackage(buffer);
    else if (["document", "analysis", "research"].includes(kind))
      assertDocumentPackage(buffer);
    else if (kind === "website") assertWebsitePackage(filePath);

    let schemaValidator: string | null = null;
    let renderValidator: string | null = null;
    const knownBenignFindings: ArtifactValidationFinding[] = [];
    if (
      kind === "presentation" ||
      ["document", "analysis", "research"].includes(kind)
    ) {
      let validation: Awaited<ReturnType<typeof validateFile>>;
      try {
        validation = await validateFile(filePath, {
          officeVersion: "Microsoft365",
        });
      } catch (error) {
        throw new ArtifactPipelineError(
          "INFRA",
          `OOXML validator execution failed: ${error instanceof Error ? error.message : String(error)}`,
          { ruleOrPart: "ooxml-validator", cause: error },
        );
      }
      schemaValidator = SCHEMA_VALIDATOR;
      const blockingErrors = [];
      for (const error of validation.errors ?? []) {
        if (kind === "presentation" && isKnownBenignFinding(error))
          knownBenignFindings.push(benignFindingReceipt(error));
        else blockingErrors.push(error);
      }
      if (blockingErrors.length) {
        const detail = blockingErrors
          .map(
            (error: any) =>
              `${error.path ?? "package"}: ${error.description ?? error.id ?? "schema error"}`,
          )
          .join("; ");
        throw new ArtifactPipelineError(
          "BUILD",
          `Microsoft 365 OOXML validation failed: ${detail || "unknown schema error"}`,
          {
            ruleOrPart:
              blockingErrors[0]?.path ??
              blockingErrors[0]?.xPath ??
              "ooxml-schema",
          },
        );
      }
      renderValidator = await renderOfficeArtifact(filePath);
    }

    const visibleText = packageVisibleText(kind, filePath);
    assertOutputCoverage(kind, prompt, plan, visibleText);
    const receipt: ArtifactValidationReceipt = {
      kind,
      artifactSha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length,
      requirements: plan.requirements?.length ?? 0,
      schemaValidator,
      renderValidator,
      powerPointDesktopValidated: false,
      buildSha: currentBuildSha(),
      generatorVersion:
        kind === "presentation"
          ? PPTX_GENERATOR
          : ["document", "analysis", "research"].includes(kind)
            ? DOCX_GENERATOR
            : "Agent Díaz deterministic HTML ZIP",
      knownBenignFindings,
      llmCalls: 0,
      maxLlmCalls: 0,
      wallTimeMs: 0,
      attempts: [],
    };
    log("info", "artifact.quality_passed", { ...receipt });
    return receipt;
  } catch (error) {
    const classified = asArtifactPipelineError(error, "BUILD", "artifact-build");
    if (
      diagnostics &&
      classified.failureClass === "BUILD" &&
      fs.existsSync(filePath)
    ) {
      const bytes = fs.readFileSync(filePath);
      const packageSha = crypto.createHash("sha256").update(bytes).digest("hex");
      const dir = path.join(diagnostics.root, diagnostics.jobId);
      fs.mkdirSync(dir, { recursive: true });
      const diagnosticName = `${Date.now()}-${kind}-${packageSha.slice(0, 12)}${path.extname(filePath)}`;
      const diagnosticPath = path.join(dir, diagnosticName);
      fs.copyFileSync(filePath, diagnosticPath);
      fs.writeFileSync(
        `${diagnosticPath}.json`,
        JSON.stringify(
          {
            kind,
            packageSha,
            failureClass: classified.failureClass,
            ruleOrPart: classified.ruleOrPart,
            error: classified.message,
            sourceName: path.basename(filePath),
            capturedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      classified.diagnosticPath = diagnosticPath;
      log("warn", "artifact.diagnostic_preserved", {
        jobId: diagnostics.jobId,
        kind,
        packageSha,
        diagnosticPath,
        reason: classified.message,
      });
    }
    log("warn", "artifact.validation_failed", {
      file: path.basename(filePath),
      kind,
      failureClass: classified.failureClass,
      ruleOrPart: classified.ruleOrPart,
      diagnosticPath: classified.diagnosticPath,
      reason: classified.message,
    });
    throw classified;
  }
}
