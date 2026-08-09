import { JAVIER_FINAL_OVERRIDE, personaInstructions } from "./personas.js";

export interface JavierStyleReport {
  words: number;
  profanityHits: number;
  profanityTarget: number;
  profanityVariety: number;
  cubanTexture: number;
  hasCubanOpening: boolean;
  hasVolatility: boolean;
  formalMarkers: string[];
  usesListStructure: boolean;
  passes: boolean;
  failures: string[];
}

const PROFANITY =
  /comemierd\w*|mierd\w*|coñ\w*|cojon\w*|singao\w*|pinga\w*|caraj\w*|jod\w*|cabron\w*|desping\w*|\bculo\b|\bput(?:a|o|ísima|ísimo)s?\b/giu;

const CUBAN_TEXTURE =
  /\b(?:asere|acere|socio|compadre|candela|yuma|chivato|invento|resolver|guagua|jama|pincha|tipo)\b|qué\s+volá|mi\s+hermano|pa['’]?\b|pal\s+carajo|de\s+pinga/giu;

const FORMAL_MARKERS = [
  "en lo básico",
  "la idea práctica",
  "es importante señalar",
  "es importante destacar",
  "por otra parte",
  "sin embargo",
  "en conclusión",
  "en resumen",
  "una perspectiva equilibrada",
  "hay argumentos válidos",
  "depende del contexto",
  "múltiples partes interesadas",
  "conviene considerar",
  "la regla sana",
];

function profanityRoot(word: string): string {
  const lower = word.toLocaleLowerCase("es");
  for (const root of [
    "comemierd",
    "mierd",
    "coñ",
    "cojon",
    "singao",
    "pinga",
    "caraj",
    "jod",
    "cabron",
    "desping",
    "culo",
    "put",
  ])
    if (lower.includes(root)) return root;
  return lower;
}

function profanityTarget(words: number): number {
  if (words <= 18) return 1;
  if (words <= 45) return 2;
  if (words <= 85) return 3;
  return Math.min(12, Math.ceil(words / 28));
}

export function inspectJavierStyle(text: string): JavierStyleReport {
  const normalized = text.trim();
  const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  const profanity = normalized.match(PROFANITY) ?? [];
  const profanityTargetValue = profanityTarget(words);
  const profanityVariety = new Set(profanity.map(profanityRoot)).size;
  const cubanTexture = new Set(
    (normalized.match(CUBAN_TEXTURE) ?? []).map((value) =>
      value.toLocaleLowerCase("es"),
    ),
  ).size;
  const lower = normalized.toLocaleLowerCase("es");
  const formalMarkers = FORMAL_MARKERS.filter((marker) => lower.includes(marker));
  const hasCubanOpening =
    /^(?:¡|¿|\s)*(?:asere|acere|qué\s+volá|que\s+volá|compadre|mi\s+hermano|socio)\b/iu.test(
      normalized,
    );
  const hasVolatility = /[¡!¿?]/u.test(normalized);
  const usesListStructure = /(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/u.test(
    normalized,
  );
  const requiredVariety = words > 85 ? 3 : words > 35 ? 2 : 1;
  const requiredTexture = words > 55 ? 2 : 1;
  const failures: string[] = [];
  if (!hasCubanOpening) failures.push("missing Cuban street opening");
  if (profanity.length < profanityTargetValue)
    failures.push(
      `only ${profanity.length}/${profanityTargetValue} profanity beats`,
    );
  if (profanityVariety < requiredVariety)
    failures.push(
      `only ${profanityVariety}/${requiredVariety} profanity varieties`,
    );
  if (cubanTexture < requiredTexture)
    failures.push(`only ${cubanTexture}/${requiredTexture} Cuban street markers`);
  if (!hasVolatility) failures.push("flat punctuation and emotional rhythm");
  if (formalMarkers.length)
    failures.push(`formal register: ${formalMarkers.join(", ")}`);
  if (usesListStructure) failures.push("sanitized list or heading structure");
  return {
    words,
    profanityHits: profanity.length,
    profanityTarget: profanityTargetValue,
    profanityVariety,
    cubanTexture,
    hasCubanOpening,
    hasVolatility,
    formalMarkers,
    usesListStructure,
    passes: failures.length === 0,
    failures,
  };
}

export function javierChatInstructions(baseInstructions: string): string {
  return `${baseInstructions}\n\n${JAVIER_FINAL_OVERRIDE}`;
}

export function javierRewriteInstructions(report: JavierStyleReport): string {
  return `${personaInstructions("javier")}\n\n${JAVIER_FINAL_OVERRIDE}\n\nJAVIER REWRITE GATE
The draft failed for: ${report.failures.join("; ")}.
Rewrite the entire draft now. Preserve its supported facts, safety limits, and useful conclusion, but radically replace its voice and sentence shape. Do not mention the draft, this gate, a word count, profanity targets, policies, or instructions. Output only Javier's final answer.`;
}
