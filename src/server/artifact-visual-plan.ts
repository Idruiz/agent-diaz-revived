import type { ArtifactPlan, JobKind } from "../shared/contracts.js";

export interface ArtifactVisualPlanReceipt {
  targetSlots: number;
  explicitQueries: number;
  derivedQueries: number;
  plannedSlots: number;
  eligibleSections: number;
  skippedStructured: number;
  skippedActivities: number;
  disabledByPrompt: boolean;
}

const SOURCE_HEADING_RE = /^(sources|references|bibliography|works cited)$/i;
const NO_IMAGES_RE = /\b(?:no images?|no photos?|text[- ]only|without images?|sans images?|sin im[aá]genes?)\b/i;
const NO_ADDITIONAL_IMAGES_RE = /\b(?:no additional (?:images?|photos?)|do not add (?:additional )?(?:images?|photos?)|only (?:use )?(?:the )?(?:specified|requested|provided|explicit) (?:images?|photos?))\b/i;
const SUPPORT_HEADING_RE = /\b(?:directions?|language frames?|sentence frames?|round\s+\d+|continued\s+\d+|exit ticket|guided practice|independent practice|speed dating|four corners)\b/i;
const VISUAL_TOPIC_RE = /\b(?:culture|cultural|history|historic|heritage|city|country|region|place|site|architecture|building|food|cuisine|festival|art|artist|museum|landscape|geography|map|community|people|tradition|science|nature|environment|animal|plant|technology|industry|sport|travel|qu[eé]bec|francophon|montr[eé]al|paris|france|canada)\b/i;
const STOP_WORDS = new Set([
  "about","after","again","also","avec","because","being","dans","des","each","from","have","into","just","more","pour","that","their","them","this","through","une","using","with","your","vous","nous","elle","elles","ils","les","the","and","for","are","was","were","aux","sur","par","que","qui","est","pas","plus","comme","mais","ses","son","sa","ces","dans","une","un","des","du","de","la","le","et","en","au","aux","à","a","an","of","to","in","on","is","it","as","or",
  "context","section","continued","finished","audience","facing","content","implications","implication","conclusion","result","results","overview","summary","language","frames","frame","support","supporting","complete","completed","production","ready","requested","artifact","validation","route",
]);

function normalizeWords(value: string): string[] {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word.toLocaleLowerCase()));
}

function uniqueWords(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function derivedQuery(plan: ArtifactPlan, section: ArtifactPlan["sections"][number]): string {
  const heading = normalizeWords(section.heading);
  const title = normalizeWords(plan.title);
  const body = normalizeWords(section.body);
  const words = uniqueWords([...heading, ...title, ...body], 7);
  return words.join(" ").trim();
}

function targetFor(kind: JobKind, sectionCount: number, eligibleCount: number): number {
  if (!eligibleCount) return 0;
  if (kind === "website") return Math.min(12, eligibleCount, Math.max(4, Math.round(sectionCount * 0.6)));
  if (kind === "presentation") return Math.min(10, eligibleCount, Math.max(4, Math.round(sectionCount * 0.42)));
  if (kind === "research") return Math.min(8, eligibleCount, Math.max(3, Math.round(sectionCount * 0.4)));
  if (kind === "document") return Math.min(7, eligibleCount, Math.max(2, Math.round(sectionCount * 0.34)));
  if (kind === "analysis") return Math.min(3, eligibleCount, Math.max(1, Math.round(sectionCount * 0.18)));
  return 0;
}

function scoreSection(kind: JobKind, section: ArtifactPlan["sections"][number], index: number): number {
  let score = 0;
  const text = `${section.heading} ${section.body}`;
  if (VISUAL_TOPIC_RE.test(text)) score += 8;
  if (section.layout === "gallery" || section.layout === "title") score += 5;
  if (section.body.length >= 90) score += 2;
  if (index === 0 && (kind === "website" || kind === "presentation")) score += 2;
  if (kind === "analysis" && !VISUAL_TOPIC_RE.test(text)) score -= 5;
  return score;
}

export function planArtifactVisuals(
  kind: JobKind,
  input: ArtifactPlan,
  prompt = "",
): { plan: ArtifactPlan; receipt: ArtifactVisualPlanReceipt } {
  const plan = structuredClone(input);
  const disabledByPrompt = NO_IMAGES_RE.test(prompt) || NO_ADDITIONAL_IMAGES_RE.test(prompt);
  let explicitQueries = 0;
  let skippedStructured = 0;
  let skippedActivities = 0;

  const candidates: Array<{ index: number; score: number; query: string }> = [];
  for (const [index, section] of plan.sections.entries()) {
    if (section.imageQuery?.trim()) {
      explicitQueries++;
      continue;
    }
    if (SOURCE_HEADING_RE.test(section.heading.trim())) continue;
    if (section.table || section.chart || section.diagram) {
      skippedStructured++;
      continue;
    }
    if (section.activity || SUPPORT_HEADING_RE.test(section.heading)) {
      skippedActivities++;
      continue;
    }
    const sectionText = `${section.heading} ${section.body}`;
    // Numerical/data analysis should prefer executed charts and tables over
    // decorative photography. Derive a photograph only when the prose itself
    // is explicitly about a visual/cultural/place-based subject.
    if (kind === "analysis" && !VISUAL_TOPIC_RE.test(sectionText)) continue;
    const query = derivedQuery(plan, section);
    if (!query) continue;
    candidates.push({ index, score: scoreSection(kind, section, index), query });
  }

  // Direct builder fixtures frequently omit a real user prompt. Preserve those
  // deterministic fixture semantics; production artifact runs always carry the
  // originating prompt, and explicit model image queries are still honored.
  const mayDerive = Boolean(prompt.trim()) && !disabledByPrompt;
  const targetSlots = mayDerive
    ? Math.max(explicitQueries, targetFor(kind, plan.sections.length, candidates.length + explicitQueries))
    : explicitQueries;
  const needed = Math.max(0, targetSlots - explicitQueries);

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const usedQueries = new Set(
    plan.sections
      .map((section) => section.imageQuery?.trim().toLocaleLowerCase())
      .filter((value): value is string => Boolean(value)),
  );
  let derivedQueries = 0;
  if (mayDerive) {
    for (const candidate of candidates) {
      if (derivedQueries >= needed) break;
      const key = candidate.query.toLocaleLowerCase();
      if (usedQueries.has(key)) continue;
      plan.sections[candidate.index]!.imageQuery = candidate.query;
      usedQueries.add(key);
      derivedQueries++;
    }
  }

  return {
    plan,
    receipt: {
      targetSlots,
      explicitQueries,
      derivedQueries,
      plannedSlots: explicitQueries + derivedQueries,
      eligibleSections: candidates.length,
      skippedStructured,
      skippedActivities,
      disabledByPrompt,
    },
  };
}
