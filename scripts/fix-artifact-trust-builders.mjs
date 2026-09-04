import fs from "node:fs";

const file = "src/server/builders.ts";
let source = fs.readFileSync(file, "utf8");
const broken = "async function docx(}\n\nasync function docx(config:Config";
const fixed = "async function docx(config:Config";
if (!source.includes(broken)) throw new Error("Expected malformed docx boundary not found");
if (source.indexOf(broken) !== source.lastIndexOf(broken)) throw new Error("Malformed docx boundary is not unique");
source = source.replace(broken, fixed);
fs.writeFileSync(file, source);
console.log("Repaired pptx/docx function boundary.");
