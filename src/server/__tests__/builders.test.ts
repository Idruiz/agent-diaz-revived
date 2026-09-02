import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { buildArtifact } from "../builders";
import type { Config } from "../config";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "diaz-builders-"));
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
  OPENAI_MODEL: "test",
  OPENAI_FAST_MODEL: "test",
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
const plan = {
  title: "Validation artifact",
  subtitle: "Builder smoke test",
  requirements: [{ id: "R1", text: "Build a validated visual artifact", mandatory: true }],
  sections: [
    {
      heading: "Evidence chart",
      body: "This section visualizes executed values.",
      bullets: ["One verified point", "A second verified point"],
      speakerNotes: "Presenter note",
      requirementIds: ["R1"],
      layout: "data" as const,
      chart: {
        title: "Quarterly result",
        type: "bar" as const,
        labels: ["Q1", "Q2", "Q3"],
        series: [{ name: "Score", values: [31, 44, 57] }],
        unit: "points",
        sourceNote: "Fixture data",
      },
    },
    {
      heading: "Evidence table",
      body: "The same evidence is available as an exact table.",
      bullets: [],
      speakerNotes: "",
      requirementIds: ["R1"],
      layout: "data" as const,
      table: {
        title: "Exact results",
        headers: ["Period", "Score"],
        rows: [
          ["Q1", "31"],
          ["Q2", "44"],
          ["Q3", "57"],
        ],
      },
    },
    {
      heading: "Process",
      body: "The workflow is made explicit.",
      bullets: [],
      speakerNotes: "",
      requirementIds: ["R1"],
      layout: "process" as const,
      diagram: {
        title: "Validated workflow",
        nodes: ["Evidence", "Analysis", "Artifact"],
        caption: "Every stage is checked.",
      },
    },
  ],
  sources: [{ title: "OpenAI", url: "https://openai.com" }],
};
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
describe("artifact builders", () => {
  for (const kind of [
    "research",
    "analysis",
    "presentation",
    "document",
    "website",
  ] as const)
    it(`builds a visual ${kind}`, async () => {
      const out = await buildArtifact(config, kind, plan);
      expect(fs.existsSync(out.path)).toBe(true);
      expect(out.size).toBeGreaterThan(kind === "website" ? 1500 : 8000);
      expect(path.dirname(out.path)).toBe(config.artifactDir);
    });
  it("uses schema-safe rendered charts while keeping diagrams and text native", async () => {
    const out = await buildArtifact(config, "presentation", plan);
    const zip = new AdmZip(out.path),
      names = zip.getEntries().map((entry) => entry.entryName),
      slideNames = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
      slideText = slideNames
        .map((name) => zip.getEntry(name)!.getData().toString("utf8"))
        .join("\n");
    expect(slideNames).toHaveLength(5);
    expect(names.some((name) => name.startsWith("ppt/charts/") && name.endsWith(".xml"))).toBe(false);
    expect(names.some((name) => name.startsWith("ppt/media/") && !name.endsWith("/"))).toBe(true);
    expect(slideText).not.toContain(" / 3");
    expect(slideText.match(/>Sources</g)).toHaveLength(1);
    expect(slideText).toContain("Validated workflow");
  });
  it("generates print-safe Word structure with fixed tables and a distinct cover", async () => {
    const out = await buildArtifact(config, "document", plan);
    const zip = new AdmZip(out.path),
      documentXml = zip
        .getEntry("word/document.xml")!
        .getData()
        .toString("utf8"),
      numberingXml = zip
        .getEntry("word/numbering.xml")!
        .getData()
        .toString("utf8");
    expect(documentXml).toContain('w:type="fixed"');
    expect(documentXml).toContain('w:w="9360"');
    expect(documentXml).toContain("<w:titlePg");
    expect(documentXml).toContain("<w:keepNext");
    expect(numberingXml).toContain('w:val="bullet"');
  });
  it("packages phone-portable self-contained website pages", async () => {
    const out = await buildArtifact(config, "website", plan);
    const zip = new AdmZip(out.path);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain("OPEN_ME_FIRST.html");
    expect(names).toContain("index.html");
    expect(names).not.toContain("styles.css");
    for (const entry of zip
      .getEntries()
      .filter((e) => e.entryName.endsWith(".html"))) {
      const html = entry.getData().toString("utf8");
      expect(html).toContain("<style>");
      expect(html).not.toContain('href="styles.css"');
      expect(html).not.toContain("assets/images/");
    }
  });
});
