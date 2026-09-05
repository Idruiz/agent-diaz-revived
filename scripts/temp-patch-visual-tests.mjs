import fs from "node:fs";

function patchAgentTest() {
  const file = "src/server/__tests__/agent.test.ts";
  let text = fs.readFileSync(file, "utf8");
  const testAnchor = 'it("counts one qualitative image-judge call in the successful artifact receipt"';
  const testStart = text.indexOf(testAnchor);
  if (testStart < 0) throw new Error("agent test anchor missing");
  const receiptStart = text.indexOf("    expect(artifact.receipt).toMatchObject({", testStart);
  const stateStart = text.indexOf("    expect(db.getArtifactRunState(job.id)).toMatchObject({", receiptStart);
  if (receiptStart < 0 || stateStart < 0) throw new Error("agent receipt anchors missing");
  const oldBlock = text.slice(receiptStart, stateStart);
  if (oldBlock.includes("imageReceipt.requested")) return false;
  const replacement = `    expect(artifact.receipt).toMatchObject({
      llmCalls: 3,
      maxLlmCalls: 6,
      images: {
        judgeCalls: 1,
      },
    });
    const imageReceipt = (artifact.receipt as any).images;
    expect(imageReceipt.requested).toBeGreaterThan(0);
    expect(imageReceipt.requested).toBeLessThanOrEqual(10);
    expect(imageReceipt.fetched).toBe(imageReceipt.requested);
    expect(imageReceipt.placed).toBe(imageReceipt.requested);
`;
  text = text.slice(0, receiptStart) + replacement + text.slice(stateStart);
  fs.writeFileSync(file, text);
  return true;
}

function patchGoldenTest() {
  const file = "src/server/__tests__/artifact-golden.test.ts";
  let text = fs.readFileSync(file, "utf8");
  let changed = false;
  const importLine = 'import { planArtifactVisuals } from "../artifact-visual-plan";';
  if (!text.includes(importLine)) {
    const anchor = 'import { compileArtifactPlan } from "../artifact-compiler";\n';
    if (!text.includes(anchor)) throw new Error("golden import anchor missing");
    text = text.replace(anchor, anchor + `${importLine}\n`);
    changed = true;
  }
  const oldStart = text.indexOf("        const expectedImages = golden.plan.sections.filter(");
  if (oldStart >= 0) {
    const next = text.indexOf("        expect(receipt.images).toMatchObject({", oldStart);
    if (next < 0) throw new Error("golden expected-images end anchor missing");
    const replacement = `        const expectedImages = planArtifactVisuals(
          golden.kind,
          compiledGolden,
          golden.prompt,
        ).receipt.plannedSlots;
`;
    text = text.slice(0, oldStart) + replacement + text.slice(next);
    changed = true;
  }
  if (changed) fs.writeFileSync(file, text);
  return changed;
}

const changed = [patchAgentTest(), patchGoldenTest()].some(Boolean);
console.log(changed ? "patched stale visual-budget tests" : "visual-budget tests already aligned");
