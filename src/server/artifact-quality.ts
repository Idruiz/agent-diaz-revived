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
const XML_TEXT_BODY = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>';
const MINIMAL_NOTES_SP_TREE = '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

export interface PresentationRepairStats {
  textBodiesAdded: number;
  notesMastersNormalized: number;
  notesMasterLinksReordered: number;
  orphanContentTypesRemoved: number;
  invalidSerializedValuesNormalized: number;
}

export interface DocumentRepairStats {
  drawingIdsReassigned: number;
}

export interface ArtifactValidationReceipt {
  kind: JobKind;
  sha256: string;
  bytes: number;
  requirements: number;
  rendered: boolean;
  validator: string;
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

function patchTextlessShapes(xml: string): { xml: string; count: number } {
  let count = 0;
  const patched = xml.replace(/<p:sp(?=[\s>])[\s\S]*?<\/p:sp>/g, (shape) => {
    if (shape.includes("<p:txBody")) return shape;
    count++;
    return shape.replace("</p:sp>", `${XML_TEXT_BODY}</p:sp>`);
  });
  return { xml: patched, count };
}

export function repairPresentationBuffer(input: Buffer): { buffer: Buffer; stats: PresentationRepairStats } {
  const zip = new AdmZip(input);
  const packageEntries = new Set(zip.getEntries().map((entry) => entry.entryName));
  let textBodiesAdded = 0;
  let notesMastersNormalized = 0;
  let notesMasterLinksReordered = 0;
  let orphanContentTypesRemoved = 0;
  let invalidSerializedValuesNormalized = 0;
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.endsWith(".xml")) continue;
    let xml = entry.getData().toString("utf8");
    if (entry.entryName === "[Content_Types].xml") {
      xml = xml.replace(/<Override\b[^>]*\bPartName="\/([^"]+)"[^>]*\/>/g, (override, partName: string) => {
        if (packageEntries.has(partName)) return override;
        orphanContentTypesRemoved++;
        return "";
      });
    }
    if (entry.entryName === "ppt/presentation.xml") {
      const notesMasterList = xml.match(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/)?.[0];
      if (notesMasterList) {
        const withoutList = xml.replace(notesMasterList, "");
        const reordered = withoutList.replace(/(?=<p:sldIdLst\b)/, notesMasterList);
        if (reordered !== xml) {
          xml = reordered;
          notesMasterLinksReordered++;
        }
      }
    }
    if (/^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(entry.entryName)) {
      const normalized = xml.replace(/<p:spTree>[\s\S]*?<\/p:spTree>/, MINIMAL_NOTES_SP_TREE);
      if (normalized !== xml) {
        xml = normalized;
        notesMastersNormalized++;
      }
    }
    if (/^ppt\/(?:slides|slideLayouts|slideMasters)\//.test(entry.entryName)) {
      const patched = patchTextlessShapes(xml);
      xml = patched.xml;
      textBodiesAdded += patched.count;
    }
    xml = xml.replace(/(\s[\w:.-]+)="(?:NaN|undefined|null)"/g, (_match, attribute: string) => {
      invalidSerializedValuesNormalized++;
      return `${attribute}="0"`;
    });
    entry.setData(Buffer.from(xml, "utf8"));
  }
  return {
    buffer: zip.toBuffer(),
    stats: { textBodiesAdded, notesMastersNormalized, notesMasterLinksReordered, orphanContentTypesRemoved, invalidSerializedValuesNormalized },
  };
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
  for (const entry of zip.getEntries().filter((item) => /^ppt\/(?:slides|slideLayouts|slideMasters)\/.*\.xml$/.test(item.entryName))) {
    const xml = entry.getData().toString("utf8");
    for (const match of xml.matchAll(/<p:sp(?=[\s>])[\s\S]*?<\/p:sp>/g))
      if (!match[0].includes("<p:txBody"))
        throw new Error(`Presentation package validation failed: textless shape remains in ${entry.entryName}`);
  }
  for (const entry of zip.getEntries().filter((item) => /^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(item.entryName))) {
    const xml = entry.getData().toString("utf8");
    if (/<p:sp(?=[\s>])/.test(xml))
      throw new Error(`Presentation package validation failed: invalid notes-master placeholder remains in ${entry.entryName}`);
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

async function renderOfficeArtifact(filePath: string): Promise<boolean> {
  const command = process.env.SOFFICE_PATH?.trim() || "soffice";
  const probe = await runProcess(command, ["--version"], 15_000).catch(() => null);
  if (!probe || probe.code !== 0) {
    if (process.env.NODE_ENV === "production")
      throw new Error("Artifact render validation failed: LibreOffice is unavailable in production");
    log("warn", "artifact.render_skipped", { filePath: path.basename(filePath), reason: "soffice unavailable outside production" });
    return false;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-render-"));
  try {
    const profileUrl = pathToFileURL(path.join(tempDir, "profile")).href;
    const result = await runProcess(command, [`-env:UserInstallation=${profileUrl}`, "--headless", "--convert-to", "pdf", "--outdir", tempDir, filePath], 90_000);
    if (result.code !== 0)
      throw new Error(`LibreOffice render failed: ${result.stderr || result.stdout}`);
    const pdfPath = path.join(tempDir, `${path.parse(filePath).name}.pdf`);
    if (!fs.existsSync(pdfPath))
      throw new Error("LibreOffice render failed: no PDF was produced");
    const pdf = fs.readFileSync(pdfPath);
    if (pdf.length < 5_000 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-")
      throw new Error("LibreOffice render failed: output PDF is invalid or unexpectedly small");
    return true;
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
): Promise<ArtifactValidationReceipt> {
  try {
    const buffer = fs.readFileSync(filePath);
    if (kind === "presentation") assertPresentationPackage(buffer);
    else if (["document", "analysis", "research"].includes(kind)) assertDocumentPackage(buffer);
    else if (kind === "website") assertWebsitePackage(filePath);

    let validator = "deterministic-package";
    let rendered = false;
    if (kind === "presentation" || ["document", "analysis", "research"].includes(kind)) {
      const validation = await validateFile(filePath, { officeVersion: "Microsoft365" });
      if (!validation.ok) {
        const detail = validation.errors.slice(0, 8).map((error) => `${error.path ?? "package"}: ${error.description ?? error.id ?? "schema error"}`).join("; ");
        throw new Error(`Microsoft 365 OOXML validation failed: ${detail || "unknown schema error"}`);
      }
      validator = "Microsoft Open XML SDK / Microsoft365";
      rendered = await renderOfficeArtifact(filePath);
    }

    const visibleText = packageVisibleText(kind, filePath);
    assertOutputCoverage(kind, prompt, plan, visibleText);
    const receipt: ArtifactValidationReceipt = {
      kind,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length,
      requirements: plan.requirements?.length ?? 0,
      rendered,
      validator,
    };
    log("info", "artifact.quality_passed", { ...receipt });
    return receipt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    log("warn", "artifact.validation_failed_retriable", {
      file: path.basename(filePath),
      kind,
      reason: message,
    });
    throw new Error(`Artifact validation failed and requires regeneration: ${message}`);
  }
}
