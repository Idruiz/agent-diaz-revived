import fs from "node:fs";

const file = "scripts/apply-artifact-trust-rebuild.mjs";
let source = fs.readFileSync(file, "utf8");
const start = source.indexOf("// 8. Honest live acceptance harness");
const end = source.indexOf("// 9. Make CI labels honest", start);
if (start < 0 || end < 0) throw new Error("Could not locate live acceptance block");

const replacement = String.raw`// 8. Honest live acceptance harness: this is deliberately not mocked and not part of normal CI.
write(
  "scripts/live-artifact-acceptance.mjs",
  [
    'const base = (process.env.DIAZ_BASE_URL || "").replace(/\\\/$/, "");',
    'const password = process.env.DIAZ_ADMIN_PASSWORD || "";',
    'if (!base || !password) {',
    '  console.error("Set DIAZ_BASE_URL and DIAZ_ADMIN_PASSWORD to run real-provider acceptance.");',
    '  process.exit(2);',
    '}',
    '',
    'let cookie = "";',
    'async function request(route, init = {}) {',
    '  const headers = new Headers(init.headers || {});',
    '  if (cookie) headers.set("cookie", cookie);',
    '  const response = await fetch(base + route, { ...init, headers });',
    '  if (!response.ok) throw new Error(route + " -> " + response.status + ": " + await response.text());',
    '  return response;',
    '}',
    '',
    'const login = await request("/api/login", {',
    '  method: "POST",',
    '  headers: { "content-type": "application/json", origin: base },',
    '  body: JSON.stringify({ password }),',
    '});',
    'cookie = login.headers.get("set-cookie")?.split(";")[0] || "";',
    'if (!cookie) throw new Error("Login cookie missing");',
    '',
    'const cases = [',
    '  ["presentation", "Create a teaching presentation to teach the present tense in French, connect it to French culture, and include complete Speed Dating and Four Corners student practice."],',
    '  ["document", "Create a professional student-facing document about everyday culture in Spain with authentic examples and a discussion activity."],',
    '  ["research", "Research current evidence about teen social media use in Canada and create a sourced professional report with clear limitations."],',
    '  ["website", "Create a complete three-page website explaining public spaces in Barcelona with real licensed photography, working navigation, and sources."],',
    '];',
    '',
    'const results = [];',
    'for (const [kind, prompt] of cases) {',
    '  const conversation = await (await request("/api/conversations", {',
    '    method: "POST",',
    '    headers: { "content-type": "application/json", origin: base },',
    '    body: JSON.stringify({ title: "Acceptance " + kind }),',
    '  })).json();',
    '  const job = await (await request("/api/jobs", {',
    '    method: "POST",',
    '    headers: { "content-type": "application/json", origin: base },',
    '    body: JSON.stringify({ kind, prompt, conversationId: conversation.id, fileIds: [] }),',
    '  })).json();',
    '  let current;',
    '  const deadline = Date.now() + 20 * 60 * 1000;',
    '  do {',
    '    await new Promise((r) => setTimeout(r, 2500));',
    '    current = await (await request("/api/jobs/" + job.id)).json();',
    '    if (["failed", "blocked", "cancelled"].includes(current.status))',
    '      throw new Error(kind + " failed: " + (current.error || current.message));',
    '  } while (current.status !== "completed" && Date.now() < deadline);',
    '  if (current.status !== "completed") throw new Error(kind + " timed out");',
    '  if (current.artifacts?.length !== 1) throw new Error(kind + " produced " + (current.artifacts?.length ?? 0) + " artifacts");',
    '  const artifact = current.artifacts[0];',
    '  const attempts = artifact.receipt?.attempts || [];',
    '  if (attempts.length) throw new Error(kind + " was not first-pass: " + JSON.stringify(attempts));',
    '  if (kind === "presentation" && artifact.receipt?.presentation?.layoutFitting?.retried)',
    '    throw new Error("presentation used a layout repair pass");',
    '  const download = await request("/api/artifacts/" + artifact.id + "/download");',
    '  const bytes = new Uint8Array(await download.arrayBuffer());',
    '  if (bytes.length < 1500) throw new Error(kind + " download unexpectedly small");',
    '  results.push({ kind, jobId: job.id, artifact: artifact.name, bytes: bytes.length, firstPass: true });',
    '  console.log("[acceptance] " + kind + ": first-pass OK (" + artifact.name + ", " + bytes.length + " bytes)");',
    '}',
    'console.log(JSON.stringify({ base, results }, null, 2));',
    '',
  ].join("\\n"),
);

`;

source = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(file, source);
console.log("Trust driver quoting repaired.");
