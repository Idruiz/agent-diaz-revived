import type { ArtifactPlan, JobKind } from "../shared/contracts.js";
import type { ArtifactNormalizationReceipt } from "./artifact-quality.js";

const MAX_PRESENTATION_BODY = 440;
const MAX_PRESENTATION_BULLETS = 5;
const MAX_HEADING = 92;

function chunks(value: string, maxChars: number): string[] {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(" ");
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) { current = word; continue; }
    if ((current + " " + word).length <= maxChars) current += " " + word;
    else { out.push(current); current = word; }
  }
  if (current) out.push(current);
  return out;
}

function continuationHeading(base: string, index: number): string {
  const suffix = ` — continued ${index}`;
  const available = Math.max(12, MAX_HEADING - suffix.length);
  return `${base.slice(0, available).trimEnd()}${suffix}`;
}

function standardFragments(
  section: ArtifactPlan["sections"][number],
): ArtifactPlan["sections"] {
  const bodyChunks = chunks(section.body, MAX_PRESENTATION_BODY);
  const bulletGroups = Array.from(
    { length: Math.max(1, Math.ceil(section.bullets.length / MAX_PRESENTATION_BULLETS)) },
    (_, index) => section.bullets.slice(
      index * MAX_PRESENTATION_BULLETS,
      index * MAX_PRESENTATION_BULLETS + MAX_PRESENTATION_BULLETS,
    ),
  );
  const count = Math.max(bodyChunks.length, bulletGroups.length);
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(section),
    heading: index === 0 ? section.heading : continuationHeading(section.heading, index + 1),
    body: bodyChunks[index] ?? "",
    bullets: bulletGroups[index] ?? [],
    imageQuery: index === 0 ? section.imageQuery : undefined,
  }));
}

function contextFragments(
  section: ArtifactPlan["sections"][number],
): ArtifactPlan["sections"] {
  const source = {
    ...structuredClone(section),
    heading: continuationHeading(section.heading, 1).replace("continued 1", "context"),
    layout: "standard" as const,
    activity: undefined,
    table: undefined,
    chart: undefined,
    diagram: undefined,
    imageQuery: undefined,
  };
  return standardFragments(source);
}

/**
 * Converts a semantic ArtifactPlan into a render-admissible plan before any PPTX
 * bytes are written. This stage owns pagination. Builders must not discover fit
 * failures after serialization and must not delete semantic content with slice().
 */
export function compileArtifactPlan(
  kind: JobKind,
  input: ArtifactPlan,
): { plan: ArtifactPlan; normalizations: ArtifactNormalizationReceipt[] } {
  if (kind !== "presentation")
    return { plan: structuredClone(input), normalizations: [] };

  const plan = structuredClone(input);
  const compiled: ArtifactPlan["sections"] = [];
  const normalizations: ArtifactNormalizationReceipt[] = [];

  for (const section of plan.sections) {
    const structured = Boolean(section.table || section.chart || section.diagram);
    const activity = section.activity?.type;
    const bodyLimit = activity === "four_corners" ? 280 : activity ? 340 : MAX_PRESENTATION_BODY;
    const bodyNeedsPagination = section.body.replace(/\s+/g, " ").trim().length > bodyLimit;
    const bulletsNeedPagination = section.bullets.length > MAX_PRESENTATION_BULLETS;
    const builderDoesNotRenderBody = structured || activity === "speed_dating";
    const builderDoesNotRenderBullets = Boolean(activity);

    if (builderDoesNotRenderBody || builderDoesNotRenderBullets || bodyNeedsPagination || bulletsNeedPagination) {
      const context = contextFragments(section);
      compiled.push(...context);
      normalizations.push({
        code: "presentation_content_paginated",
        detail: `Moved audience-facing context for '${section.heading}' into ${context.length} deterministic context slide(s) so no body or bullet content is dropped.`,
      });
      const primary = structuredClone(section);
      primary.body = chunks(section.body, bodyLimit)[0] ?? "";
      primary.bullets = [];
      compiled.push(primary);
      continue;
    }

    const fragments = standardFragments(section);
    compiled.push(...fragments);
    if (fragments.length > 1)
      normalizations.push({
        code: "presentation_content_paginated",
        detail: `Split '${section.heading}' into ${fragments.length} deterministic slides to preserve all audience-facing content.`,
      });
  }

  plan.sections = compiled;
  return { plan, normalizations };
}
