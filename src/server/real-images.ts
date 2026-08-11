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
  const tokens = query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2);
  const searchNoise = new Set([
    "photograph",
    "photography",
    "photo",
    "image",
    "documentary",
    "detailed",
    "scientific",
    "illustration",
    "comparison",
    "closeup",
    "close",
  ]);
  const meaningful = tokens.filter((token) => !searchNoise.has(token));
  const honeyIndex=meaningful.findIndex((token,index)=>token==="honey"&&meaningful[index+1]==="bee"),
    core=honeyIndex>=0?meaningful.slice(honeyIndex,honeyIndex+2):meaningful.slice(0,2),
    modifiers=meaningful.filter((_,index)=>honeyIndex>=0?(index<honeyIndex||index>honeyIndex+1):index>1).filter(token=>token!=="western"),
    broad=core.length&&modifiers.length?`"${core.join(" ")}" (${modifiers.slice(0,5).join(" OR ")})`:"";
  const variants = [...new Set([
    broad,
    query,
    meaningful.join(" "),
    meaningful.slice(0,6).join(" "),
    meaningful.slice(0,4).join(" "),
    meaningful.slice(0,3).join(" "),
  ].filter(Boolean))];
  let pages:any[]=[];
  for(const variant of variants){
    const api = new URL("https://commons.wikimedia.org/w/api.php");
    api.searchParams.set("action", "query");
    api.searchParams.set("generator", "search");
    api.searchParams.set("gsrsearch", `${variant} filetype:bitmap`);
    api.searchParams.set("gsrnamespace", "6");
    api.searchParams.set("gsrlimit", "12");
    api.searchParams.set("prop", "imageinfo");
    api.searchParams.set("iiprop", "url|size|extmetadata");
    api.searchParams.set("iiurlwidth", "1600");
    api.searchParams.set("format", "json");
    api.searchParams.set("origin", "*");
    const response = await fetchWithRetry(api, {
      headers: {
        "User-Agent": "AgentDiaz/3.3 (licensed educational artifact builder)",
      },
      signal: AbortSignal.timeout(15000),
    });
    const json: any = await response.json();
    pages = Object.values(json?.query?.pages ?? {}) as any[];
    if(pages.length)break;
  }
  const wantsIllustration=/\b(illustration|diagram|engraving|historical print)\b/i.test(query);
  const avoid=wantsIllustration
    ? /\b(logo|flag|map|seal|coat of arms|icon|symbol|screenshot)\b/i
    : /\b(logo|flag|map|seal|coat of arms|icon|symbol|screenshot|book|journal|newspaper|magazine|poster|advertisement|cover|scan|page|diagram|engraving)\b/i;
  const candidates = pages
    .map((p) => ({ p, ii: p.imageinfo?.[0] }))
    .filter(
      (x) =>
        x.ii?.thumburl &&
        /\.(?:jpe?g|png|webp)(?:[/?]|$)/i.test(String(x.ii.thumburl)),
    )
    .map((hit) => {
      const title=String(hit.p.title||"").toLocaleLowerCase(),
        description=text(hit.ii.extmetadata?.ImageDescription?.value).toLocaleLowerCase(),
        haystack=`${title} ${description}`,
        titleMatches=tokens.filter((token)=>title.includes(token)).length,
        descriptionMatches=tokens.filter((token)=>description.includes(token)).length;
      const pixels = Number(hit.ii.width || 0) * Number(hit.ii.height || 0);
      return {
        ...hit,
        score:
          titleMatches * 55 +
          descriptionMatches * 7 +
          Math.min(30, pixels / 500_000) +
          (/\.jpe?g(?:[/?]|$)/i.test(String(hit.ii.thumburl)) ? 6 : 0) -
          (avoid.test(haystack) ? 220 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);
  if (!candidates.length)
    throw new Error(`No licensed bitmap found for image query: ${query}`);
  let last: Error | undefined;
  for (const hit of candidates.slice(0, 6)) {
    try {
      const image = await fetchWithRetry(hit.ii.thumburl, {
        headers: { "User-Agent": "AgentDiaz/3.3" },
        signal: AbortSignal.timeout(20000),
      });
      const downloaded = Buffer.from(await image.arrayBuffer()),
        bytes = await normalizeLicensedImage(downloaded),
        dimensions = await sharp(bytes).metadata(),
        meta = hit.ii.extmetadata ?? {};
      if (!dimensions.width || !dimensions.height)
        throw new Error("Normalized image has no dimensions");
      return {
        bytes,
        extension: "jpg",
        mime: "image/jpeg",
        width: dimensions.width,
        height: dimensions.height,
        title: text(meta.ObjectName?.value || hit.p.title).slice(0, 180),
        creator: text(
          meta.Artist?.value ||
            meta.Credit?.value ||
            "Wikimedia Commons contributor",
        ).slice(0, 220),
        license: text(
          meta.LicenseShortName?.value ||
            meta.UsageTerms?.value ||
            "See source for license",
        ).slice(0, 120),
        sourceUrl: String(
          meta.CanonicalPage?.value || hit.ii.descriptionurl || hit.ii.url,
        ),
      };
    } catch (error) {
      last = error instanceof Error ? error : new Error("Image candidate failed");
    }
  }
  throw new Error(
    `No usable licensed image found for '${query}': ${last?.message || "all candidates failed"}`,
  );
}
