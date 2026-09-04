import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Router } from "express";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { atomicWrite, safeJoin } from "./files.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PDF_MIME = "application/pdf";
const HTML_MIME = "text/html; charset=utf-8";
const VIRTUAL_ID = /^([0-9a-f-]{36})--(html|pdf)$/i;

interface ArtifactViewLike {
  id: string;
  jobId: string;
  name: string;
  mime: string;
  size: number;
  createdAt?: string;
  receipt?: unknown;
}

interface PresentationExportFile {
  format: "html" | "pdf";
  name: string;
  mime: string;
  path: string;
  size: number;
}

type PresentationExports = {
  html: PresentationExportFile;
  pdf: PresentationExportFile;
};

const exportInFlight = new Map<string, Promise<PresentationExports>>();

function routeParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && value.length && value[0]) return value[0];
  return null;
}

function isPresentationArtifact(
  artifact: Pick<ArtifactViewLike, "name" | "mime">,
): boolean {
  return artifact.mime === PPTX_MIME && /\.pptx$/i.test(artifact.name);
}

function exportName(name: string, format: "html" | "pdf"): string {
  return name.replace(/\.pptx$/i, `.${format}`);
}

function exportPath(
  config: Config,
  name: string,
  format: "html" | "pdf",
): string {
  return safeJoin(config.artifactDir, exportName(name, format));
}

function isFreshFile(
  target: string,
  sourceMtimeMs: number,
  minimumSize: number,
): boolean {
  if (!fs.existsSync(target)) return false;
  const stat = fs.statSync(target);
  return (
    stat.isFile() && stat.size >= minimumSize && stat.mtimeMs >= sourceMtimeMs
  );
}

function assertPdf(bytes: Buffer): void {
  if (
    bytes.length < 2_000 ||
    bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  )
    throw new Error("LibreOffice returned an invalid PDF export");
}

function displayTitle(name: string): string {
  return (
    name
      .replace(/\.pptx$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Agent Díaz presentation"
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]!,
  );
}

export function browserPresentationHtml(
  title: string,
  pdfBytes: Buffer,
): string {
  assertPdf(pdfBytes);
  const encoded = pdfBytes.toString("base64");
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${safeTitle}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1118;color:#f7f3ea}
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#0b1118}
body{display:grid;grid-template-rows:auto 1fr}.bar{display:flex;align-items:center;gap:.8rem;padding:.6rem .8rem;background:#17324d;border-bottom:3px solid #c99a2e;box-shadow:0 8px 24px #0006;z-index:2}
.brand{font-weight:800;letter-spacing:.12em;color:#c99a2e;font-size:.78rem;white-space:nowrap}.title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}.actions{display:flex;gap:.5rem;align-items:center}
button,a.control{appearance:none;border:1px solid #ffffff35;border-radius:.55rem;background:#ffffff12;color:#fff;padding:.48rem .72rem;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}button:hover,a.control:hover{background:#ffffff20}
.viewer{position:relative;min-height:0;background:#151b22}.viewer iframe{display:block;width:100%;height:100%;border:0;background:#222}.fallback{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:2rem;color:#d9e0e4;pointer-events:none}.fallback strong{color:#fff}
.hint{font-size:.76rem;color:#d9e0e4;white-space:nowrap}@media(max-width:760px){.hint,.brand{display:none}.bar{padding:.45rem}.actions{gap:.3rem}button,a.control{padding:.42rem .55rem;font-size:.85rem}}
@media print{.bar{display:none}.viewer{height:100vh}}
</style>
</head>
<body>
<header class="bar">
  <div class="brand">AGENT DÍAZ</div>
  <div class="title">${safeTitle}</div>
  <div class="hint">Browser-native slide view · use the PDF viewer arrows / Page Up / Page Down</div>
  <div class="actions">
    <a class="control" id="openPdf" target="_blank" rel="noopener">Open PDF</a>
    <button id="fullscreen" type="button">Full screen</button>
  </div>
</header>
<main class="viewer" id="viewer">
  <div class="fallback"><div><strong>Loading presentation…</strong><br>If your browser disables its PDF viewer, use “Open PDF”.</div></div>
  <iframe id="slides" title="${safeTitle}"></iframe>
</main>
<script id="pdf-data" type="application/octet-stream">${encoded}</script>
<script>
(()=>{
  const encoded=document.getElementById("pdf-data").textContent.trim();
  const binary=atob(encoded);
  const bytes=new Uint8Array(binary.length);
  for(let offset=0;offset<binary.length;offset+=65536){
    const end=Math.min(binary.length,offset+65536);
    for(let index=offset;index<end;index++)bytes[index]=binary.charCodeAt(index);
  }
  const url=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
  const slides=document.getElementById("slides");
  slides.src=url+"#view=FitH&toolbar=1&navpanes=0";
  const openPdf=document.getElementById("openPdf");
  openPdf.href=url;
  document.getElementById("fullscreen").addEventListener("click",()=>{
    const viewer=document.getElementById("viewer");
    if(document.fullscreenElement)document.exitFullscreen();
    else viewer.requestFullscreen();
  });
  addEventListener("beforeunload",()=>URL.revokeObjectURL(url),{once:true});
})();
</script>
</body>
</html>`;
}

async function renderPdf(
  pptxPath: string,
  target: string,
): Promise<void> {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "diaz-presentation-export-"),
  );
  const profileDir = path.join(tempRoot, "profile");
  const outputDir = path.join(tempRoot, "out");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    const { stdout, stderr } = await execFileAsync(
      "soffice",
      [
        "--headless",
        "--nologo",
        "--nodefault",
        "--nolockcheck",
        "--nofirststartwizard",
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        "--convert-to",
        "pdf:impress_pdf_Export",
        "--outdir",
        outputDir,
        pptxPath,
      ],
      { timeout: 120_000, maxBuffer: 1_000_000 },
    );
    const converted = path.join(
      outputDir,
      `${path.basename(pptxPath, path.extname(pptxPath))}.pdf`,
    );
    if (!fs.existsSync(converted))
      throw new Error(
        `LibreOffice did not create the expected PDF${stderr ? `: ${stderr.trim()}` : stdout ? `: ${stdout.trim()}` : ""}`,
      );
    const bytes = fs.readFileSync(converted);
    assertPdf(bytes);
    atomicWrite(target, bytes);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function generatePresentationExports(
  config: Config,
  artifact: { name: string; path: string; mime: string },
): Promise<PresentationExports> {
  const expectedSource = safeJoin(config.artifactDir, artifact.name);
  if (
    path.resolve(artifact.path) !== expectedSource ||
    !fs.existsSync(expectedSource)
  )
    throw new Error(
      "Presentation source bytes are missing or outside the artifact directory",
    );

  const sourceStat = fs.statSync(expectedSource);
  const pdfTarget = exportPath(config, artifact.name, "pdf");
  const htmlTarget = exportPath(config, artifact.name, "html");

  if (!isFreshFile(pdfTarget, sourceStat.mtimeMs, 2_000)) {
    await renderPdf(expectedSource, pdfTarget);
    log("info", "artifact.presentation_pdf_ready", {
      source: artifact.name,
      name: path.basename(pdfTarget),
      size: fs.statSync(pdfTarget).size,
    });
  } else {
    assertPdf(fs.readFileSync(pdfTarget));
  }

  const pdfStat = fs.statSync(pdfTarget);
  if (!isFreshFile(htmlTarget, pdfStat.mtimeMs, 3_000)) {
    const html = browserPresentationHtml(
      displayTitle(artifact.name),
      fs.readFileSync(pdfTarget),
    );
    if (
      !html.startsWith("<!doctype html>") ||
      !html.includes('id="pdf-data"')
    )
      throw new Error(
        "Generated browser presentation failed deterministic HTML validation",
      );
    atomicWrite(htmlTarget, Buffer.from(html, "utf8"));
    log("info", "artifact.presentation_html_ready", {
      source: artifact.name,
      name: path.basename(htmlTarget),
      size: fs.statSync(htmlTarget).size,
    });
  }

  return {
    html: {
      format: "html",
      name: path.basename(htmlTarget),
      mime: HTML_MIME,
      path: htmlTarget,
      size: fs.statSync(htmlTarget).size,
    },
    pdf: {
      format: "pdf",
      name: path.basename(pdfTarget),
      mime: PDF_MIME,
      path: pdfTarget,
      size: fs.statSync(pdfTarget).size,
    },
  };
}

export async function ensurePresentationExports(
  config: Config,
  artifact: { name: string; path: string; mime: string },
): Promise<PresentationExports> {
  if (!isPresentationArtifact(artifact))
    throw new Error(
      "Only validated PPTX artifacts can be exported as presentation companions",
    );
  const key = path.resolve(artifact.path);
  const existing = exportInFlight.get(key);
  if (existing) return existing;
  const task = generatePresentationExports(config, artifact);
  exportInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (exportInFlight.get(key) === task) exportInFlight.delete(key);
  }
}

export function presentationArtifactViews(
  config: Config,
  artifacts: ArtifactViewLike[],
): ArtifactViewLike[] {
  const expanded: ArtifactViewLike[] = [];
  for (const artifact of artifacts) {
    expanded.push(artifact);
    if (!isPresentationArtifact(artifact)) continue;
    for (const format of ["html", "pdf"] as const) {
      const target = exportPath(config, artifact.name, format);
      if (!fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      if (
        !stat.isFile() ||
        stat.size < (format === "pdf" ? 2_000 : 3_000)
      )
        continue;
      expanded.push({
        ...artifact,
        id: `${artifact.id}--${format}`,
        name: exportName(artifact.name, format),
        mime: format === "pdf" ? PDF_MIME : HTML_MIME,
        size: stat.size,
      });
    }
  }
  return expanded;
}

export function presentationExportRoutes(
  config: Config,
  db: Db,
  auth: ReturnType<typeof import("./auth.js").createAuth>,
): Router {
  const router = Router();

  router.get(
    "/jobs/:id",
    auth.verifyOrigin,
    auth.requireAuth,
    async (req, res, next) => {
      const id = routeParam(req.params.id);
      if (!id) return next();
      const job = db.getJob(id);
      if (!job || job.kind !== "presentation") return next();
      const artifacts = db.listArtifacts(job.id);
      if (job.status === "completed") {
        for (const artifactView of artifacts.filter(isPresentationArtifact)) {
          const source = db.getArtifact(artifactView.id);
          if (!source) continue;
          try {
            await ensurePresentationExports(config, source);
          } catch (error) {
            log("error", "artifact.presentation_companion_export_failed", {
              jobId: job.id,
              artifactId: artifactView.id,
              name: artifactView.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return res.json({
        ...job,
        artifacts: presentationArtifactViews(
          config,
          db.listArtifacts(job.id),
        ),
        approvals: db.listApprovals(job.id),
      });
    },
  );

  router.get(
    "/artifacts/:id/download",
    auth.verifyOrigin,
    auth.requireAuth,
    async (req, res, next) => {
      const id = routeParam(req.params.id);
      if (!id) return next();
      const match = id.match(VIRTUAL_ID);
      if (!match) return next();
      const [, baseId, formatValue] = match;
      const format = formatValue!.toLowerCase() as "html" | "pdf";
      const artifact = db.getArtifact(baseId!);
      if (!artifact || !isPresentationArtifact(artifact))
        return res
          .status(404)
          .json({ error: "Presentation artifact not found" });
      try {
        const exports = await ensurePresentationExports(config, artifact);
        const selected = exports[format];
        return res.download(selected.path, selected.name);
      } catch (error) {
        log("error", "artifact.presentation_companion_download_failed", {
          artifactId: baseId,
          format,
          error: error instanceof Error ? error.message : String(error),
        });
        return res.status(503).json({
          error:
            "The browser/PDF presentation export is temporarily unavailable. The original PowerPoint is unchanged; retry this download.",
        });
      }
    },
  );

  return router;
}
