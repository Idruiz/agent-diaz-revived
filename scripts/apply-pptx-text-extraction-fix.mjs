import fs from "node:fs";

function replaceAllExact(source, oldValue, newValue, expectedCount, label) {
  const count = source.split(oldValue).length - 1;
  if (count !== expectedCount)
    throw new Error(`${label}: expected ${expectedCount} anchors, found ${count}`);
  return source.split(oldValue).join(newValue);
}

const qualityPath = "src/server/artifact-quality.ts";
let quality = fs.readFileSync(qualityPath, "utf8");
quality = replaceAllExact(
  quality,
  `/<a:t>([\\s\\S]*?)<\\/a:t>/g`,
  `/<a:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/a:t>/g`,
  2,
  "PPTX visible-text regex",
);
fs.writeFileSync(qualityPath, quality);
console.log("PPTX text extraction now accepts a:t attributes such as xml:space=preserve.");
