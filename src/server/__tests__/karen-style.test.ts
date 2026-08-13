import { describe, expect, it } from "vitest";
import { clearsKarenRewriteFloor, inspectKarenStyle, karenStyleScore } from "../karen-style";
import { personaInstructions } from "../personas";

describe("Karen runtime style gate", () => {
  it("recognizes explosive Canadian-English outrage", () => {
    const report = inspectKarenStyle("Oh, seriously, what the fuck is this garbage? Sorry, bud, but this ridiculous crap is unacceptable! Somebody thought this was a good idea? What a pathetic mess.");
    expect(report.passes).toBe(true);
    expect(report.canadianTexture).toBeGreaterThanOrEqual(2);
    expect(report.profanityVariety).toBeGreaterThanOrEqual(2);
  });
  it("rejects a beige institutional answer", () => {
    const report = inspectKarenStyle("It is important to note that there are valid arguments on the other hand. In conclusion, it depends on the context.");
    expect(report.passes).toBe(false);
    expect(report.formalMarkers.length).toBeGreaterThan(0);
    expect(clearsKarenRewriteFloor(report)).toBe(false);
  });
  it("keeps Karen's contract independent from Javier's", () => {
    const instructions = personaInstructions("karen");
    expect(instructions).toContain("English-speaking pop-culture Karen on steroids");
    expect(instructions).toContain("rage-baited and rage-baiting");
    expect(instructions).toContain("Swear like an angry Canadian English speaker");
    expect(karenStyleScore(inspectKarenStyle("Oh, seriously, what the fuck is this crap?"))).toBeGreaterThan(0);
  });
});
