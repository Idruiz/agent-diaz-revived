import type { ArtifactPlan } from "../shared/contracts.js";

const VISUAL_REFERENCE_RE =
  /\b(?:image|images|photo|photos|picture|pictures|carte|cartes|map|maps|regardez|regarde|look\s+at|observe|observez|observa|observad|imagen|imágenes|foto|fotos|mapa|mapas)\b/i;

export interface PresentationReconciliation {
  sectionIndex: number;
  heading: string;
  reason: string;
  movedToSpeakerNotes: string[];
}

export interface ReconciledPresentationPlan {
  plan: ArtifactPlan;
  reconciliations: PresentationReconciliation[];
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?;:])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function reconcileVisibleText(
  value: string,
): { visible: string; moved: string[] } {
  const sentences = splitSentences(value);
  const moved = sentences.filter((sentence) =>
    VISUAL_REFERENCE_RE.test(sentence),
  );
  if (!moved.length) return { visible: value, moved: [] };
  const kept = sentences.filter(
    (sentence) => !VISUAL_REFERENCE_RE.test(sentence),
  );
  return {
    visible: kept.join(" ").trim(),
    moved,
  };
}

export function hasVisibleVisualReference(value: string): boolean {
  return VISUAL_REFERENCE_RE.test(value);
}

export function reconcilePresentationPlan(
  input: ArtifactPlan,
  placedImageQueries: Set<string>,
): ReconciledPresentationPlan {
  const plan = structuredClone(input);
  const reconciliations: PresentationReconciliation[] = [];

  plan.sections.forEach((section, sectionIndex) => {
    const requestedImage = section.imageQuery?.trim();
    const imageAvailable =
      Boolean(requestedImage) &&
      placedImageQueries.has(requestedImage!);
    if (imageAvailable) return;

    const moved: string[] = [];
    const body = reconcileVisibleText(section.body);
    section.body = body.visible;
    moved.push(...body.moved);

    section.bullets = section.bullets.filter((bullet) => {
      if (!hasVisibleVisualReference(bullet)) return true;
      moved.push(bullet);
      return false;
    });

    if (section.activity) {
      section.activity.directions =
        section.activity.directions.filter((direction) => {
          if (!hasVisibleVisualReference(direction)) return true;
          moved.push(direction);
          return false;
        });
      section.activity.prompts = section.activity.prompts.filter(
        (prompt) => {
          if (!hasVisibleVisualReference(prompt)) return true;
          moved.push(prompt);
          return false;
        },
      );
      section.activity.sentenceFrames =
        section.activity.sentenceFrames.filter((frame) => {
          if (!hasVisibleVisualReference(frame)) return true;
          moved.push(frame);
          return false;
        });
    }

    if (!moved.length) return;
    section.speakerNotes = [
      section.speakerNotes.trim(),
      "Reconciled absent-visual references:",
      ...moved.map((item) => `• ${item}`),
    ]
      .filter(Boolean)
      .join("\n");
    reconciliations.push({
      sectionIndex,
      heading: section.heading,
      reason:
        "Visible text referenced a photo/map that was not delivered; the reference was moved to speaker notes.",
      movedToSpeakerNotes: moved,
    });
  });

  return { plan, reconciliations };
}
