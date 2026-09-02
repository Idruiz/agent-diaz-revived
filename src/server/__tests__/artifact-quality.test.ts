import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import {
  assertArtifactPlanQuality,
  assertWebsitePackage,
  repairDocumentBuffer,
  repairPresentationBuffer,
} from "../artifact-quality";
import type { ArtifactPlan } from "../../shared/contracts";

const exactPrompt =
  "create a taching presentation slide deck to teach the present tense in french, connect it to french culture and include slides to get the students to practice such as speed dating and 4 corners";

function frenchTeachingPlan(): ArtifactPlan {
  const base = (heading: string, body: string, requirementIds: string[]) => ({
    heading,
    body,
    bullets: ["A complete audience-facing example", "A clear student check"],
    speakerNotes: "Use this slide to model the language, check understanding, and invite a complete response.",
    requirementIds,
    layout: "standard" as const,
  });
  return {
    title: "La France au présent",
    subtitle: "Parler de la vie francophone avec précision",
    requirements: [
      { id: "R1", text: "Teach the French present tense", mandatory: true },
      { id: "R2", text: "Connect grammar to French culture", mandatory: true },
      { id: "R3", text: "Include Speed Dating student practice", mandatory: true },
      { id: "R4", text: "Include Four Corners student practice", mandatory: true },
    ],
    sections: [
      {
        ...base("Objectifs et mise en route", "Students notice present-tense verbs in authentic descriptions of daily life in France.", ["R1", "R2"]),
        imageQuery: "French morning market shoppers",
      },
      {
        ...base("Construire le présent", "Subject pronouns and regular present-tense endings are modelled with complete examples.", ["R1"]),
        layout: "conjugation",
        table: {
          title: "Parler au présent",
          headers: ["Pronom", "Forme", "Exemple"],
          rows: [["je", "parle", "Je parle français."], ["nous", "parlons", "Nous parlons au café."]],
        },
      },
      {
        ...base("Verbes essentiels", "Être, avoir, aller and faire support practical communication in the present.", ["R1"]),
        imageQuery: "Paris students cafe conversation",
      },
      {
        ...base("La culture au quotidien", "Examples connect the present tense to meals, school, transport and leisure across the Francophone world.", ["R1", "R2"]),
        imageQuery: "Francophone community daily life",
      },
      {
        ...base("Four Corners", "Choose the statement that best represents your routine, move, and justify your choice in French.", ["R1", "R2", "R4"]),
        layout: "four_corners",
        activity: {
          type: "four_corners",
          durationMinutes: 8,
          directions: ["Read the four choices.", "Move to one corner.", "Explain and compare your choice."],
          prompts: ["Quelle activité représente le mieux ta journée?"],
          sentenceFrames: ["Je choisis… parce que…", "Dans ma vie, je…"],
          cornerLabels: ["Je mange", "Je voyage", "J'étudie", "Je fais du sport"],
        },
      },
      {
        ...base("Speed Dating", "Rotate through short conversations and answer every partner using complete present-tense sentences.", ["R1", "R2", "R3"]),
        layout: "speed_dating",
        activity: {
          type: "speed_dating",
          durationMinutes: 12,
          directions: ["Face one partner.", "Ask and answer one prompt.", "Rotate when the timer sounds."],
          prompts: ["Que fais-tu le matin?", "Où vas-tu le week-end?", "Qu'est-ce que tu manges?", "Avec qui parles-tu français?"],
          sentenceFrames: ["D'habitude, je…", "Le week-end, nous…"],
          cornerLabels: [],
        },
      },
      {
        ...base("Billet de sortie", "Students produce and check two original present-tense sentences connected to a cultural context.", ["R1", "R2"]),
        layout: "exit_ticket",
        activity: {
          type: "exit_ticket",
          durationMinutes: 4,
          directions: ["Write independently.", "Check the subject and ending."],
          prompts: ["Écris une phrase sur ta routine.", "Écris une phrase sur une pratique culturelle francophone."],
          sentenceFrames: [],
          cornerLabels: [],
        },
      },
    ],
    pages: undefined,
    sources: [{ title: "TV5MONDE Langue française", url: "https://langue-francaise.tv5monde.com/" }],
  };
}

describe("artifact quality gates", () => {
  it("accepts the exact French teaching request only when both named activities are complete", () => {
    const plan = frenchTeachingPlan();
    expect(() => assertArtifactPlanQuality("presentation", exactPrompt, plan)).not.toThrow();
  });

  it("rejects a deck that merely mentions Speed Dating without implementing the activity", () => {
    const plan = frenchTeachingPlan();
    plan.sections[5] = {
      ...plan.sections[5]!,
      activity: {
        type: "discussion",
        durationMinutes: 5,
        directions: ["Discuss the prompt.", "Share one answer."],
        prompts: ["Que fais-tu?"],
        sentenceFrames: [],
        cornerLabels: [],
      },
    };
    expect(() => assertArtifactPlanQuality("presentation", exactPrompt, plan)).toThrow(/requires a Speed Dating activity slide/);
  });

  it("repairs PptxGenJS 4.0.1 textless shapes and normalizes the invalid notes master", () => {
    const zip = new AdmZip();
    zip.addFile("ppt/slides/slide1.xml", Buffer.from('<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:nvSpPr/><p:spPr/></p:sp></p:sld>'));
    zip.addFile("ppt/notesMasters/notesMaster1.xml", Buffer.from('<p:notesMaster xmlns:p="p" xmlns:a="a"><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr/></p:sp></p:spTree></p:notesMaster>'));
    zip.addFile("ppt/presentation.xml", Buffer.from('<p:presentation xmlns:p="p"><p:sldMasterIdLst/><p:sldIdLst/><p:sldSz cx="1" cy="1"/><p:notesSz cx="1" cy="1"/><p:notesMasterIdLst><p:notesMasterId/></p:notesMasterIdLst></p:presentation>'));
    zip.addFile("[Content_Types].xml", Buffer.from('<Types><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="master"/><Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="master"/></Types>'));
    zip.addFile("ppt/slideMasters/slideMaster1.xml", Buffer.from('<p:sldMaster xmlns:p="p"/>'));
    const repaired = repairPresentationBuffer(zip.toBuffer());
    const output = new AdmZip(repaired.buffer);
    const slide = output.getEntry("ppt/slides/slide1.xml")!.getData().toString("utf8");
    const notes = output.getEntry("ppt/notesMasters/notesMaster1.xml")!.getData().toString("utf8");
    expect(slide).toContain("<p:txBody>");
    expect(notes).not.toMatch(/<p:sp(?=[\s>])/);
    const presentation = output.getEntry("ppt/presentation.xml")!.getData().toString("utf8");
    const contentTypes = output.getEntry("[Content_Types].xml")!.getData().toString("utf8");
    expect(presentation.indexOf("<p:notesMasterIdLst>")).toBeLessThan(presentation.indexOf("<p:sldIdLst"));
    expect(contentTypes).not.toContain("slideMaster2.xml");
    expect(repaired.stats).toEqual({
      textBodiesAdded: 1,
      notesMastersNormalized: 1,
      notesMasterLinksReordered: 1,
      orphanContentTypesRemoved: 1,
    });
  });

  it("reassigns duplicate DOCX drawing identifiers deterministically", () => {
    const zip = new AdmZip();
    zip.addFile("word/document.xml", Buffer.from('<w:document xmlns:w="w" xmlns:wp="wp"><wp:docPr id="1" name="A"/><wp:docPr id="1" name="B"/></w:document>'));
    const repaired = repairDocumentBuffer(zip.toBuffer());
    const xml = new AdmZip(repaired.buffer).getEntry("word/document.xml")!.getData().toString("utf8");
    expect(xml).toContain('id="1" name="A"');
    expect(xml).toContain('id="2" name="B"');
    expect(repaired.stats.drawingIdsReassigned).toBe(2);
  });

  it("rejects a packaged website with a broken internal link", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-website-quality-"));
    const target = path.join(root, "broken.zip");
    const zip = new AdmZip();
    const page = (href: string) => `<!doctype html><html><head><title>Page</title></head><body><nav><a href="${href}">Next</a></nav><main>Complete professional content for this page.</main></body></html>`;
    zip.addFile("index.html", Buffer.from(page("missing.html")));
    zip.addFile("OPEN_ME_FIRST.html", Buffer.from(page("index.html")));
    zip.addFile("about.html", Buffer.from(page("index.html")));
    zip.addFile("attributions.html", Buffer.from(page("index.html")));
    zip.writeZip(target);
    expect(() => assertWebsitePackage(target)).toThrow(/broken internal link/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
