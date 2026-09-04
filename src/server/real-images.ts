import sharp from "sharp";

export interface RealImage {
  bytes: Buffer;
  extension: "jpg" | "png" | "webp";
  mime: string;
  width: number;
  height: number;
  title: string;
  creator: string;
  license: string;
  sourceUrl: string;
}

export interface CommonsImageCandidate {
  id: string;
  title: string;
  description: string;
  categories: string[];
  creator: string;
  license: string;
  width: number;
  height: number;
  thumbUrl: string;
  sourceUrl: string;
  query: string;
}

export interface CandidateRejection {
  candidateId: string;
  title: string;
  reason: string;
}

const EXCLUDED_SUBJECT_RE =
  /\b(?:nude|naked|corpse|funeral|memorial|injury|blood|protest|riot|homeless|sleeping person|drunk|police|weapon|logo|flag|map|screenshot|scan|book cover)\b/i;
const ALLOWED_LICENSE_RE =
  /^(?:CC(?:\s|[-]?)(?:BY|BY-SA|BY-NC|BY-NC-SA|0)\b|CC0\b|Public domain\b|PD\b)/i;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 400;
const MIN_ASPECT = 0.45;
const MAX_ASPECT = 2.5;
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

const text = (value: unknown) =>
  String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let providerCooldownUntil = 0;
let consecutiveRateLimits = 0;

class PermanentImageProviderError extends Error {}
class ImageProviderCooldownError extends Error {}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

export function imageProviderCooldownRemainingMs(): number {
  return Math.max(0, providerCooldownUntil - Date.now());
}

function setRateLimitCooldown(response: Response): number {
  consecutiveRateLimits++;
  const serverDelay = retryAfterMs(response);
  const fallbackDelay = Math.min(30_000, 2500 * 2 ** Math.min(consecutiveRateLimits - 1, 3));
  const delay = Math.max(1500, Math.min(60_000, serverDelay ?? fallbackDelay));
  providerCooldownUntil = Math.max(providerCooldownUntil, Date.now() + delay);
  return delay;
}

async function fetchWithRetry(
  url: URL | string,
  init: RequestInit,
  attempts = 2,
): Promise<Response> {
  let last: Error | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = imageProviderCooldownRemainingMs();
    if (remaining > 0)
      throw new ImageProviderCooldownError(
        `Image provider cooldown active (${Math.ceil(remaining / 1000)}s remaining after HTTP 429)`,
      );
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        consecutiveRateLimits = 0;
        providerCooldownUntil = 0;
        return response;
      }
      if (!RETRYABLE_HTTP.has(response.status))
        throw new PermanentImageProviderError(`Image provider returned ${response.status}`);
      if (response.status === 429) {
        const delay = setRateLimitCooldown(response);
        last = new Error(`Image provider temporarily unavailable (429; cooldown ${Math.ceil(delay / 1000)}s)`);
        if (attempt < attempts - 1) {
          await sleep(delay);
          providerCooldownUntil = 0;
          continue;
        }
        throw last;
      }
      last = new Error(`Image provider temporarily unavailable (${response.status})`);
    } catch (error) {
      if (error instanceof PermanentImageProviderError || error instanceof ImageProviderCooldownError)
        throw error;
      last = error instanceof Error ? error : new Error("Image provider request failed");
    }
    if (attempt < attempts - 1) await sleep(700 * 2 ** attempt);
  }
  throw last ?? new Error("Image provider request failed");
}

export function imageCandidateRejectionReason(candidate: CommonsImageCandidate): string | null {
  if (!ALLOWED_LICENSE_RE.test(candidate.license))
    return `license '${candidate.license || "missing"}' is not CC/PD`;
  if (candidate.width < MIN_WIDTH || candidate.height < MIN_HEIGHT)
    return `dimensions ${candidate.width}×${candidate.height} are below ${MIN_WIDTH}×${MIN_HEIGHT}`;
  const aspect = candidate.height > 0 ? candidate.width / candidate.height : 0;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT)
    return `aspect ratio ${aspect.toFixed(2)} is outside ${MIN_ASPECT}–${MAX_ASPECT}`;
  const haystack = [candidate.title, candidate.description, ...candidate.categories].join(" ");
  if (EXCLUDED_SUBJECT_RE.test(haystack))
    return "metadata matches the classroom-safety exclusion list";
  return null;
}

export async function normalizeLicensedImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > 10 * 1024 * 1024) throw new Error("Image exceeded 10 MB limit");
  if (bytes.length < 1000) throw new Error("Image download was unexpectedly small");
  return sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1200, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

function searchVariants(query: string): string[] {
  const normalized = text(query);
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 2);
  return [normalized, tokens.slice(0, 6).join(" ")].filter(
    (value, index, all) => Boolean(value) && all.indexOf(value) === index,
  );
}

export async function searchCommonsCandidates(
  query: string,
  limit = 8,
): Promise<{ candidates: CommonsImageCandidate[]; rejected: CandidateRejection[] }> {
  const accepted = new Map<string, CommonsImageCandidate>();
  const rejected = new Map<string, CandidateRejection>();

  for (const variant of searchVariants(query)) {
    if (accepted.size >= limit) break;
    const api = new URL("https://commons.wikimedia.org/w/api.php");
    api.searchParams.set("action", "query");
    api.searchParams.set("generator", "search");
    api.searchParams.set("gsrsearch", `${variant} filetype:bitmap`);
    api.searchParams.set("gsrnamespace", "6");
    api.searchParams.set("gsrlimit", String(Math.max(limit, 8)));
    api.searchParams.set("prop", "imageinfo|categories");
    api.searchParams.set("iiprop", "url|size|extmetadata");
    api.searchParams.set("iiurlwidth", "1600");
    api.searchParams.set("cllimit", "max");
    api.searchParams.set("format", "json");
    api.searchParams.set("origin", "*");

    const response = await fetchWithRetry(
      api,
      {
        headers: { "User-Agent": "AgentDiaz/3.5 (licensed educational artifact builder; contact via project repository)" },
        signal: AbortSignal.timeout(15_000),
      },
      2,
    );
    const json: any = await response.json();
    const pages = Object.values(json?.query?.pages ?? {}) as any[];

    for (const page of pages) {
      if (accepted.size >= limit) break;
      const ii = page.imageinfo?.[0];
      if (!ii?.thumburl || !/\.(?:jpe?g|png|webp)(?:[/?]|$)/i.test(String(ii.thumburl)))
        continue;

      const meta = ii.extmetadata ?? {};
      const candidate: CommonsImageCandidate = {
        id: String(page.pageid ?? page.title ?? ii.thumburl),
        title: text(meta.ObjectName?.value || page.title).slice(0, 220),
        description: text(meta.ImageDescription?.value).slice(0, 500),
        categories: (page.categories ?? [])
          .map((category: any) => text(category.title).replace(/^Category:/i, ""))
          .filter(Boolean)
          .slice(0, 24),
        creator: text(meta.Artist?.value || meta.Credit?.value || "Wikimedia Commons contributor").slice(0, 220),
        license: text(meta.LicenseShortName?.value || meta.UsageTerms?.value).slice(0, 120),
        width: Number(ii.width || 0),
        height: Number(ii.height || 0),
        thumbUrl: String(ii.thumburl),
        sourceUrl: String(meta.CanonicalPage?.value || ii.descriptionurl || ii.url),
        query,
      };

      const reason = imageCandidateRejectionReason(candidate);
      if (reason) {
        rejected.set(candidate.id, { candidateId: candidate.id, title: candidate.title, reason });
        continue;
      }
      if (!accepted.has(candidate.id)) accepted.set(candidate.id, candidate);
    }
  }

  return { candidates: [...accepted.values()].slice(0, limit), rejected: [...rejected.values()] };
}

export async function downloadCommonsCandidate(candidate: CommonsImageCandidate): Promise<RealImage> {
  const response = await fetchWithRetry(
    candidate.thumbUrl,
    {
      headers: { "User-Agent": "AgentDiaz/3.5 (licensed educational artifact builder)" },
      signal: AbortSignal.timeout(20_000),
    },
    2,
  );
  const downloaded = Buffer.from(await response.arrayBuffer());
  const bytes = await normalizeLicensedImage(downloaded);
  const dimensions = await sharp(bytes).metadata();
  if (!dimensions.width || !dimensions.height) throw new Error("Normalized image has no dimensions");
  return {
    bytes,
    extension: "jpg",
    mime: "image/jpeg",
    width: dimensions.width,
    height: dimensions.height,
    title: candidate.title,
    creator: candidate.creator,
    license: candidate.license,
    sourceUrl: candidate.sourceUrl,
  };
}

export async function fetchCommonsImage(query: string): Promise<RealImage> {
  const { candidates } = await searchCommonsCandidates(query, 1);
  const candidate = candidates[0];
  if (!candidate) throw new Error(`No usable licensed image candidates found for '${query}'`);
  return downloadCommonsCandidate(candidate);
}
