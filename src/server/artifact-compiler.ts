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
    if (!current) {
      current = word;
      continue;
    }
    if ((current + " " + word).length <= maxChars) current += " " + word;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}

function continuationHeading(base: string, index: number): string {
  const suffix = ` — continued ${index}`;
  const available = Math.max(12, MAX_HEADING - suffix.length);
  return `${base.slice(0, available).trimEnd()}${suffix}`;
}

function labelledHeading(base: string, label: string): string {
  const suffix = ` — ${label}`;
  const available = Math.max(12, MAX_HEADING - suffix.length);
  return `${base.slice(0, available).trimEnd()}${suffix}`;
}

function standardFragments(
  section: ArtifactPlan["sections"][number],
): ArtifactPlan["sections"] {
  const bodyChunks = chunks(section.body, MAX_PRESENTATION_BODY);
  const bulletGroups = Array.from(
    {
      length: Math.max(
        1,
        Math.ceil(section.bullets.length / MAX_PRESENTATION_BULLETS),
      ),
    },
    (_, index) =>
      section.bullets.slice(
        index * MAX_PRESENTATION_BULLETS,
        index * MAX_PRESENTATION_BULLETS + MAX_PRESENTATION_BULLETS,
      ),
  );
  const count = Math.max(bodyChunks.length, bulletGroups.length);
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(section),
    heading:
      index === 0
        ? section.heading
        : continuationHeading(section.heading, index + 1),
    body: bodyChunks[index] ?? "",
    bullets: bulletGroups[index] ?? [],
    imageQuery: index === 0 ? section.imageQuery : undefined,
  }));
}

function supportingFragments(
  section: ArtifactPlan["sections"][number],
  body: string,
  bullets: string[],
  label = "context",
): ArtifactPlan["sections"] {
  if (!body.trim() && bullets.length === 0) return [];
  const source = {
    ...structuredClone(section),
    heading: labelledHeading(section.heading, label),
    body: body.replace(/\s+/g, " ").trim(),
    bullets: [...bullets],
    layout: "standard" as const,
    activity: undefined,
    table: undefined,
    chart: undefined,
    diagram: undefined,
    imageQuery: undefined,
  };
  return standardFragments(source);
}

function activityLabel(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * Converts a semantic ArtifactPlan into a render-admissible plan before any PPTX
 * bytes are written. This stage owns pagination and renderer capability gaps.
 * Builders must not discover fit failures after serialization and must not delete
 * semantic content with slice()/ellipsis. Any audience-facing semantic copy that
 * a specialized template cannot render is materialized on deterministic context
 * slides instead.
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
    if (structured) {
      const context = supportingFragments(
        section,
        section.body,
        section.bullets,
      );
      compiled.push(...context);
      if (context.length)
        normalizations.push({
          code: "presentation_content_reflowed",
          detail: `Materialized ${context.length} audience-context slide(s) for '${section.heading}' because its structured visual template does not render the full narrative and bullet fields.`,
        });
      const primary = structuredClone(section);
      // Table/chart/diagram content remains on the specialized slide. Original
      // audience narrative is already present exactly once in context above.
      primary.body = "";
      primary.bullets = [];
      compiled.push(primary);
      continue;
    }

    const activity = section.activity;
    if (!activity) {
      const fragments = standardFragments(section);
      compiled.push(...fragments);
      if (fragments.length > 1)
        normalizations.push({
          code: "presentation_content_paginated",
          detail: `Split '${section.heading}' into ${fragments.length} deterministic slides to preserve all audience-facing content.`,
        });
      continue;
    }

    if (activity.type === "speed_dating") {
      const context = supportingFragments(
        section,
        section.body,
        section.bullets,
      );
      compiled.push(...context);
      if (context.length)
        normalizations.push({
          code: "presentation_content_reflowed",
          detail: `Materialized ${context.length} audience-context slide(s) for '${section.heading}' because the Speed Dating template reserves its canvas for directions, prompts, and sentence frames.`,
        });
      const primary = structuredClone(section);
      primary.body = "";
      primary.bullets = [];
      compiled.push(primary);
      continue;
    }

    const bodyLimit = activity.type === "four_corners" ? 280 : 340;
    const bodyChunks = chunks(section.body, bodyLimit);
    const extraFourCornerFrames =
      activity.type === "four_corners"
        ? activity.sentenceFrames.slice(3)
        : [];
    const needsSupportingSlide =
      bodyChunks.length > 1 ||
      section.bullets.length > 0 ||
      extraFourCornerFrames.length > 0;

    let primaryBody = section.body.replace(/\s+/g, " ").trim();
    if (needsSupportingSlide) {
      const context = supportingFragments(
        section,
        section.body,
        [...section.bullets, ...extraFourCornerFrames],
      );
      compiled.push(...context);
      primaryBody = `${activityLabel(activity.type)} · follow the directions and complete the prompts.`;
      normalizations.push({
        code: "presentation_content_reflowed",
        detail: `Materialized ${context.length} audience-context slide(s) for '${section.heading}' so narrative, bullets, and template-overflow fields remain visible exactly once.`,
      });
    }

    if (activity.type === "four_corners") {
      const prompts = [...activity.prompts];
      prompts.forEach((prompt, index) => {
        const primary = structuredClone(section);
        primary.heading =
          index === 0
            ? section.heading
            : labelledHeading(section.heading, `round ${index + 1}`);
        primary.body =
          index === 0
            ? primaryBody
            : `Four Corners round ${index + 1} · choose a corner and explain your choice.`;
        primary.bullets = [];
        primary.activity = {
          ...structuredClone(activity),
          prompts: [prompt],
          // The current Four Corners frame box safely renders three frames. Any
          // fourth frame is preserved on the context slide above instead of being
          // silently sliced by the renderer.
          sentenceFrames: activity.sentenceFrames.slice(0, 3),
        };
        primary.imageQuery = index === 0 ? section.imageQuery : undefined;
        compiled.push(primary);
      });
      if (prompts.length > 1)
        normalizations.push({
          code: "presentation_activity_paginated",
          detail: `Expanded '${section.heading}' into ${prompts.length} Four Corners round slides so every planned prompt is usable rather than silently discarding prompts after the first.`,
        });
      continue;
    }

    const primary = structuredClone(section);
    primary.body = needsSupportingSlide ? primaryBody : bodyChunks[0] ?? "";
    primary.bullets = [];
    compiled.push(primary);
  }

  plan.sections = compiled;
  return { plan, normalizations };
}
