import sharp from "sharp";

export interface RealImage {
  bytes: Buffer;
  extension: "jpg" | "png" | "webp";
  mime: string;
  title: string;
  creator: string;
  license: string;
  sourceUrl: string;
}
const text = (v: unknown) =>
  String(v ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(
  url: URL | string,
  init: RequestInit,
  attempts = 4,
): Promise<Response> {
  let last: Error | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      if (![429, 500, 502, 503, 504].includes(response.status))
        throw new Error(`Image provider returned ${response.status}`);
      last = new Error(
        `Image provider temporarily unavailable (${response.status})`,
      );
    } catch (error) {
      last =
        error instanceof Error
          ? error
          : new Error("Image provider request failed");
    }
    if (attempt < attempts - 1) await sleep(500 * 2 ** attempt);
  }
  throw last ?? new Error("Image provider request failed");
}

export async function normalizeLicensedImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > 10 * 1024 * 1024)
    throw new Error("Image exceeded 10 MB limit");
  if (bytes.length < 1000)
    throw new Error("Image download was unexpectedly small");
  return sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000 })
    .rotate()
    .resize({
      width: 1600,
      height: 1200,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

export async function fetchCommonsImage(query: string): Promise<RealImage> {
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("generator", "search");
  api.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  api.searchParams.set("gsrnamespace", "6");
  api.searchParams.set("gsrlimit", "8");
  api.searchParams.set("prop", "imageinfo");
  api.searchParams.set("iiprop", "url|mime|extmetadata");
  api.searchParams.set("iiurlwidth", "1600");
  api.searchParams.set("format", "json");
  api.searchParams.set("origin", "*");
  const response = await fetchWithRetry(api, {
    headers: {
      "User-Agent": "AgentDiaz/3.0 (licensed educational artifact builder)",
    },
    signal: AbortSignal.timeout(15000),
  });
  const json: any = await response.json();
  const pages = Object.values(json?.query?.pages ?? {}) as any[];
  const hit = pages
    .map((p) => ({ p, ii: p.imageinfo?.[0] }))
    .find(
      (x) =>
        x.ii?.thumburl &&
        ["image/jpeg", "image/png", "image/webp"].includes(x.ii.mime),
    );
  if (!hit)
    throw new Error(`No licensed bitmap found for image query: ${query}`);
  const image = await fetchWithRetry(hit.ii.thumburl, {
    headers: { "User-Agent": "AgentDiaz/3.1" },
    signal: AbortSignal.timeout(20000),
  });
  const downloaded = Buffer.from(await image.arrayBuffer()),
    bytes = await normalizeLicensedImage(downloaded);
  const meta = hit.ii.extmetadata ?? {};
  return {
    bytes,
    extension: "jpg",
    mime: "image/jpeg",
    title: text(meta.ObjectName?.value || hit.p.title),
    creator: text(
      meta.Artist?.value ||
        meta.Credit?.value ||
        "Wikimedia Commons contributor",
    ),
    license: text(
      meta.LicenseShortName?.value ||
        meta.UsageTerms?.value ||
        "See source for license",
    ),
    sourceUrl: String(
      meta.CanonicalPage?.value || hit.ii.descriptionurl || hit.ii.url,
    ),
  };
}
