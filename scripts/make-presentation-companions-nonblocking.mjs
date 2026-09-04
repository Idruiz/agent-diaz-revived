import fs from "node:fs";

function patch(file, before, after, expected = 1) {
  let text = fs.readFileSync(file, "utf8");
  const count = text.split(before).length - 1;
  if (count !== expected) throw new Error(`${file}: expected ${expected}, found ${count}: ${before.slice(0, 100)}`);
  fs.writeFileSync(file, text.split(before).join(after));
}

patch(
  "src/server/presentation-exports.ts",
  `          try {\n            await ensurePresentationExports(config, source);\n          } catch (error) {\n            log("error", "artifact.presentation_companion_export_failed", {\n              jobId: job.id,\n              artifactId: artifactView.id,\n              name: artifactView.name,\n              error: error instanceof Error ? error.message : String(error),\n            });\n          }`,
  `          // Companion generation must never sit on the critical path for the\n          // accepted PPTX. Kick it off after completion and return job detail\n          // immediately; the normal polling cycle will expose the companions\n          // once their files are ready.\n          void ensurePresentationExports(config, source).catch((error) => {\n            log("error", "artifact.presentation_companion_export_failed", {\n              jobId: job.id,\n              artifactId: artifactView.id,\n              name: artifactView.name,\n              error: error instanceof Error ? error.message : String(error),\n            });\n          });`,
);

patch(
  "scripts/live-artifact-acceptance.mjs",
  `  if (kind === "presentation") {\n    const views = current.artifacts || [];\n    const html = views.find((item) => item.id === artifact.id + "--html");\n    const pdf = views.find((item) => item.id === artifact.id + "--pdf");\n    if (!html || !pdf)\n      throw new Error("presentation completed without both HTML and PDF companion downloads");\n    for (const companion of [html, pdf]) {`,
  `  if (kind === "presentation") {\n    // The PPTX is deliverable immediately. Companion conversion is deliberately\n    // asynchronous, so poll only for companions after proving the primary file\n    // is already downloadable.\n    let views = current.artifacts || [];\n    const companionDeadline = Date.now() + 2 * 60 * 1000;\n    while (\n      Date.now() < companionDeadline &&\n      (!views.some((item) => item.id === artifact.id + "--html") ||\n        !views.some((item) => item.id === artifact.id + "--pdf"))\n    ) {\n      await new Promise((resolve) => setTimeout(resolve, 1500));\n      current = await (await request("/api/jobs/" + job.id)).json();\n      views = current.artifacts || [];\n    }\n    const html = views.find((item) => item.id === artifact.id + "--html");\n    const pdf = views.find((item) => item.id === artifact.id + "--pdf");\n    if (!html || !pdf)\n      throw new Error("presentation companions did not become ready within two minutes");\n    for (const companion of [html, pdf]) {`,
);

console.log("Presentation companion exports are now off the PPTX delivery critical path.");
