import fs from "node:fs";

const file = "src/server/__tests__/agent.test.ts";
let s = fs.readFileSync(file, "utf8");
function once(before, after) {
  const at = s.indexOf(before);
  if (at < 0) throw new Error(`Missing anchor: ${before.slice(0, 120)}`);
  if (s.indexOf(before, at + before.length) >= 0) throw new Error(`Ambiguous anchor: ${before.slice(0, 120)}`);
  s = s.slice(0, at) + after + s.slice(at + before.length);
}

once(
  'it("bounds plan repair at two calls while retaining the six-call global artifact budget", async () => {',
  'it("bounds genuinely mandatory plan repair at two calls while retaining the six-call global artifact budget", async () => {'
);
once(
  'prompt: "Create a seven-section visual presentation",',
  'prompt: "Create a visual presentation connected explicitly to French culture",'
);
once(
  'subtitle: "Six sections cannot satisfy the current presentation boundary",',
  'subtitle: "The mandatory cultural requirement remains absent",'
);
once(
  'text: "Create a seven-section visual presentation",',
  'text: "Create a complete visual presentation",'
);
once(
  'imageQuery: `documentary classroom scene ${variant} ${index + 1}`',
  'imageQuery: null'
);
once(
  '/Presentation needs at least 7 content sections/,',
  '/cultural requirement.*mandatory cultural requirement/i,'
);
fs.writeFileSync(file, s);
console.log("Updated plan-repair budget test to use a genuinely mandatory requirement defect.");
