import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { Config } from "./config.js";
import type { CommonsImageCandidate } from "./real-images.js";

export interface ImageJudgeSection {
  sectionIndex: number;
  heading: string;
  body: string;
  audience: string;
  query: string;
  candidates: CommonsImageCandidate[];
}

export interface ImageJudgeDecision {
  sectionIndex: number;
  chosenCandidate: string | null;
  reason: string;
  fallbackQueries: [string, string];
}

export interface ImageJudgeResult {
  decisions: ImageJudgeDecision[];
  judgeCalls: number;
}

export type ImageJudgeProvider = (
  sections: ImageJudgeSection[],
) => Promise<ImageJudgeDecision[]>;

let injectedTestProvider: ImageJudgeProvider | null = null;

export function setImageJudgeProviderForTests(
  provider: ImageJudgeProvider | null,
): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error(
      "Image-judge provider injection is test-only",
    );
  injectedTestProvider = provider;
}

const decisionSchema = z.object({
  decisions: z.array(
    z.object({
      sectionIndex: z.number().int().nonnegative(),
      chosenCandidate: z.string().nullable(),
      reason: z.string().min(1).max(500),
      fallbackQueries: z
        .array(z.string().min(2).max(120))
        .length(2),
    }),
  ),
});

function sanitizeDecision(
  section: ImageJudgeSection,
  decision: z.infer<typeof decisionSchema>["decisions"][number] | undefined,
): ImageJudgeDecision {
  const candidateIds = new Set(
    section.candidates.map((candidate) => candidate.id),
  );
  const chosen =
    decision?.chosenCandidate &&
    candidateIds.has(decision.chosenCandidate)
      ? decision.chosenCandidate
      : null;
  const fallback = decision?.fallbackQueries ?? [
    section.heading,
    section.query,
  ];
  return {
    sectionIndex: section.sectionIndex,
    chosenCandidate: chosen,
    reason:
      decision?.reason?.trim() ||
      (chosen
        ? "Chosen candidate is the best available topical classroom match."
        : "No candidate met the qualitative relevance bar."),
    fallbackQueries: [
      fallback[0]?.trim() || section.heading,
      fallback[1]?.trim() || section.query,
    ],
  };
}

export async function judgeImageCandidates(
  config: Config,
  sections: ImageJudgeSection[],
): Promise<ImageJudgeResult> {
  if (!sections.length)
    return { decisions: [], judgeCalls: 0 };

  if (injectedTestProvider) {
    const raw = await injectedTestProvider(sections);
    return {
      decisions: sections.map((section) =>
        sanitizeDecision(
          section,
          raw.find(
            (decision) =>
              decision.sectionIndex === section.sectionIndex,
          ),
        ),
      ),
      judgeCalls: 1,
    };
  }

  if (config.NODE_ENV === "test") {
    return {
      decisions: sections.map((section) => ({
        sectionIndex: section.sectionIndex,
        chosenCandidate: section.candidates[0]?.id ?? null,
        reason: section.candidates[0]
          ? "Deterministic test-only candidate selection."
          : "No filtered candidate was available.",
        fallbackQueries: [section.heading, section.query],
      })),
      judgeCalls: 0,
    };
  }

  const client = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
  });
  const compact = sections.map((section) => ({
    sectionIndex: section.sectionIndex,
    heading: section.heading,
    body: section.body,
    audience: section.audience,
    query: section.query,
    candidates: section.candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      description: candidate.description,
      categories: candidate.categories,
      license: candidate.license,
      width: candidate.width,
      height: candidate.height,
    })),
  }));

  const response = await client.responses.create({
    model: config.OPENAI_FAST_MODEL,
    reasoning: { effort: "low" },
    instructions: [
      "You are the single qualitative image-relevance judge for one educational artifact.",
      "Return one decision for every supplied sectionIndex.",
      "Choose a candidate only when it depicts the requested subject in the right place/culture and is suitable for a Grade 8 classroom.",
      "Reject text-heavy images, people in distress, demeaning imagery, wrong-country stock-photo clichés, or candidates whose metadata does not establish topical relevance.",
      "If no candidate clears the bar, chosenCandidate must be null.",
      "For every section provide exactly two short fallback search queries grounded in the section heading/body and real location or subject.",
      "Do not infer visual facts that are absent from candidate metadata.",
    ].join("\n"),
    input: JSON.stringify(compact),
    text: {
      format: zodTextFormat(
        decisionSchema,
        "artifact_image_judgment",
      ),
    },
    store: false,
    safety_identifier: "agent-diaz-owner",
  } as any);

  let parsed: z.infer<typeof decisionSchema>;
  try {
    parsed = decisionSchema.parse(
      JSON.parse(response.output_text || "{}"),
    );
  } catch (error) {
    throw new Error(
      `Image judge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    decisions: sections.map((section) =>
      sanitizeDecision(
        section,
        parsed.decisions.find(
          (decision) =>
            decision.sectionIndex === section.sectionIndex,
        ),
      ),
    ),
    judgeCalls: 1,
  };
}
