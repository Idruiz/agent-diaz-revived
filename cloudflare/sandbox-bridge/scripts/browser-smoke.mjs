import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const root = "/workspace/browser-smoke";
fs.mkdirSync(root, { recursive: true });
const source = path.join(root, "input.html");
const screenshot = path.join(root, "output.png");
const marker = `agent-diaz-${Date.now()}`;
fs.writeFileSync(
  source,
  `<!doctype html><meta charset="utf-8"><title>${marker}</title><main><h1>${marker}</h1><p>Cloudflare sandbox filesystem browser proof.</p></main>`,
  "utf8",
);

const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
  const title = await page.title();
  if (title !== marker) throw new Error(`Unexpected title: ${title}`);
  await page.screenshot({ path: screenshot, fullPage: true });
} finally {
  await browser.close();
}

if (!fs.existsSync(screenshot) || fs.statSync(screenshot).size < 100)
  throw new Error("Puppeteer did not write a real screenshot into /workspace");

console.log("AGENT_DIAZ_PUPPETEER_WORKSPACE_OK");
