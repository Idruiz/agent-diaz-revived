import type { ArtifactPlan, JobKind } from "../shared/contracts.js";

export interface ArtifactVisualPlanReceipt {
  targetSlots: number;
  explicitQueries: number;
  retainedExplicitQueries: number;
  trimmedExplicitQueries: number;
  derivedQueries: number;
  plannedSlots: number;
  eligibleSections: number;
  skippedStructured: number;
  skippedActivities: number;
  disabledByPrompt: boolean;
  userRequestedSlots: number | null;
  imageHeavyPrompt: boolean;
}

const SOURCE_HEADING_RE = /^(sources|references|bibliography|works cited)$/i;
const NO_IMAGES_RE = /\b(?:no images?|no photos?|text[- ]only|without images?|sans images?|sin im[aá]genes?)\b/i;
const NO_ADDITIONAL_IMAGES_RE = /\b(?:no additional (?:images?|photos?)|do not add (?:additional )?(?:images?|photos?)|(?:use )?only (?:the )?(?:specified|requested|provided|explicit(?:ly)?(?: requested)?) (?:images?|photos?)|only (?:use )?(?:the )?(?:specified|requested|provided|explicit(?:ly)?(?: requested)?) (?:images?|photos?))\b/i;
const IMAGE_HEAVY_RE = /\b(?:many|numerous|lots? of|plenty of|photo[- ]heavy|image[- ]heavy|rich(?:ly)? illustrated|highly visual|visual[- ]rich)\s*(?:relevant\s+|documentary\s+|licensed\s+)?(?:images?|photos?|photographs?)?\b/i;
const SUPPORT_HEADING_RE = /\b(?:directions?|language frames?|sentence frames?|round\s+\d+|continued\s+\d+|exit ticket|guided practice|independent practice|speed dating|four corners)\b/i;
const VISUAL_TOPIC_RE = /\b(?:culture|cultural|history|historic|heritage|city|country|region|place|site|architecture|building|food|cuisine|festival|art|artist|museum|landscape|geography|map|community|people|tradition|science|nature|environment|animal|plant|technology|industry|sport|travel|qu[eé]bec|francophon|montr[eé]al|paris|france|canada|spain|espa[nñ]a|madrid|barcelona|sevilla|seville|granada|toledo|c[oó]rdoba)\b/i;
const STOP_WORDS = new Set([
  "about","after","again","also","avec","because","being","dans","des","each","from","have","into","just","more","pour","that","their","them","this","through","une","using","with","your","vous","nous","elle","elles","ils","les","the","and","for","are","was","were","aux","sur","par","que","qui","est","pas","plus","comme","mais","ses","son","sa","ces","dans","une","un","des","du","de","la","le","et","en","au","aux","à","a","an","of","to","in","on","is","it","as","or",
  "context","section","continued","finished","audience","facing","content","implications","implication","conclusion","result","results","overview","summary","language","frames","frame","support","supporting","complete","completed","production","ready","requested","artifact","validation","route",
]);
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

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
  return uniqueWords([...heading, ...title, ...body], 7).join(" ").trim();
}

function parseCountToken(token: string): number | null {
  const key = token.toLocaleLowerCase();
  const parsed = /^\d+$/.test(key) ? Number(key) : NUMBER_WORDS[key];
  return parsed && parsed > 0 ? Math.min(24, parsed) : null;
}

function requestedVisualCount(prompt: string): number | null {
  const match = prompt.match(
    /\b(?:(?:at least|minimum(?: of)?|no fewer than)\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d{1,2})\s+(?:licensed\s+|relevant\s+|documentary\s+)?(?:images?|photos?|photographs?)\b/i,
  );
  if (!match || match.index === undefined) return null;
  const after = prompt.slice(match.index + match[0].length, match.index + match[0].length + 24);
  if (/^\s*(?:per|for each|on each)\b/i.test(after)) return null;
  return parseCountToken(match[1]!);
}

function targetFor(kind: JobKind, sectionCount: number, eligibleCount: number): number {
  if (!eligibleCount) return 0;
  if (kind === "website") return Math.min(12, eligibleCount, Math.max(5, Math.round(sectionCount * 0.62)));
  if (kind === "presentation") return Math.min(10, eligibleCount, Math.max(4, Math.round(sectionCount * 0.33)));
  if (kind === "research") return Math.min(8, eligibleCount, Math.max(3, Math.round(sectionCount * 0.4)));
  if (kind === "document") return Math.min(7, eligibleCount, Math.max(2, Math.round(sectionCount * 0.34)));
  if (kind === "analysis") return Math.min(3, eligibleCount, Math.max(1, Math.round(sectionCount * 0.18)));
  return 0;
}

function imageHeavyTarget(kind: JobKind, available: number, automaticTarget: number): number {
  if (!available) return 0;
  if (kind === "website") return Math.min(14, available, Math.max(10, automaticTarget));
  if (kind === "presentation") return Math.min(12, available, Math.max(8, automaticTarget));
  if (kind === "research") return Math.min(10, available, Math.max(6, automaticTarget));
  if (kind === "document") return Math.min(9, available, Math.max(5, automaticTarget));
  return automaticTarget;
}

function scoreSection(kind: JobKind, section: ArtifactPlan["sections"][number], index: number): number {
  let score = 0;
  const text = `${section.heading} ${section.body}`;
  if (VISUAL_TOPIC_RE.test(text)) score += 8;
  if (section.layout === "gallery" || section.layout === "title") score += 5;
  if (section.body.length >= 90) score += 2;
  if (index === 0 && (kind === "website" || kind === "presentation")) score += 3;
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
  const imageHeavyPrompt = IMAGE_HEAVY_RE.test(prompt);
  const userRequestedSlots = requestedVisualCount(prompt);
  let explicitQueries = 0;
  let skippedStructured = 0;
  let skippedActivities = 0;

  const explicit: Array<{ index: number; score: number }> = [];
  const candidates: Array<{ index: number; score: number; query: string }> = [];
  for (const [index, section] of plan.sections.entries()) {
    const hasExplicit = Boolean(section.imageQuery?.trim());
    if (hasExplicit) explicitQueries++;
    if (SOURCE_HEADING_RE.test(section.heading.trim())) continue;
    if (section.table || section.chart || section.diagram) {
      skippedStructured++;
      if (hasExplicit) explicit.push({ index, score: scoreSection(kind, section, index) });
      continue;
    }
    if (section.activity || SUPPORT_HEADING_RE.test(section.heading)) {
      skippedActivities++;
      if (hasExplicit) explicit.push({ index, score: scoreSection(kind, section, index) });
      continue;
    }
    const sectionText = `${section.heading} ${section.body}`;
    if (kind === "analysis" && !VISUAL_TOPIC_RE.test(sectionText)) {
      if (hasExplicit) explicit.push({ index, score: scoreSection(kind, section, index) });
      continue;
    }
    const score = scoreSection(kind, section, index);
    if (hasExplicit) {
      explicit.push({ index, score });
      continue;
    }
    const query = derivedQuery(plan, section);
    if (query) candidates.push({ index, score, query });
  }

  const mayDerive = Boolean(prompt.trim()) && !disabledByPrompt;
  const available = explicit.length + candidates.length;
  const automaticTarget = targetFor(kind, plan.sections.length, available);
  const desired = disabledByPrompt
    ? explicitQueries
    : userRequestedSlots !== null
      ? Math.min(userRequestedSlots, available)
      : imageHeavyPrompt
        ? imageHeavyTarget(kind, available, automaticTarget)
        : automaticTarget;
  const targetSlots = Math.max(0, desired);

  // Model-authored imageQuery fields are suggestions, not an unlimited provider
  // budget. Keep the strongest ones and trim excess unless the user explicitly
  // disabled derivation (which semantically means "only those explicit visuals").
  explicit.sort((a, b) => b.score - a.score || a.index - b.index);
  const explicitKeep = disabledByPrompt
    ? new Set(explicit.map((item) => item.index))
    : new Set(explicit.slice(0, targetSlots).map((item) => item.index));
  let trimmedExplicitQueries = 0;
  for (const item of explicit) {
    if (explicitKeep.has(item.index)) continue;
    plan.sections[item.index]!.imageQuery = undefined;
    trimmedExplicitQueries++;
  }
  const retainedExplicitQueries = explicitQueries - trimmedExplicitQueries;
  const needed = Math.max(0, targetSlots - retainedExplicitQueries);

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
      retainedExplicitQueries,
      trimmedExplicitQueries,
      derivedQueries,
      plannedSlots: retainedExplicitQueries + derivedQueries,
      eligibleSections: candidates.length,
      skippedStructured,
      skippedActivities,
      disabledByPrompt,
      userRequestedSlots,
      imageHeavyPrompt,
    },
  };
}
