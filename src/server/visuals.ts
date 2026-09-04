import sharp from "sharp";

export interface ChartSpec {
  title: string;
  type: "bar" | "line" | "pie" | "donut";
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
  unit?: string;
  sourceNote?: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]!));
const palette = ["#c99a2e", "#2f739c", "#70a37f", "#c8664f", "#8067a8"];

function formatValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 1000) return `${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(/\.0$/, "");
}

function wrapText(value: string, maxChars: number, maxLines = 3): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) break;
  }
  if (lines.length < maxLines && current) {
    const consumed = lines.join(" ").split(/\s+/).filter(Boolean).length;
    const remaining = words.slice(consumed).join(" ");
    lines.push(remaining.length > maxChars * 1.45 ? `${remaining.slice(0, Math.max(1, maxChars * 1.45 - 1)).trimEnd()}…` : remaining);
  }
  return lines.slice(0, maxLines);
}

function svgMultilineText(
  lines: string[],
  x: number,
  y: number,
  className: string,
  anchor: "start" | "middle" | "end" = "start",
  lineHeight = 18,
): string {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${className}">${lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${esc(line)}</tspan>`)
    .join("")}</text>`;
}

function chartOutlierIndex(spec: ChartSpec): number | null {
  if (spec.type !== "bar" || spec.series.length !== 1 || spec.labels.length < 3) return null;
  const values = spec.series[0]!.values.map((value) => Math.abs(value)).filter((value) => Number.isFinite(value));
  if (values.length < 3 || values.some((value) => value < 0)) return null;
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value);
  if (!sorted[1] || sorted[1].value <= 0) return null;
  return sorted[0]!.value / sorted[1]!.value >= 15 ? sorted[0]!.index : null;
}

export function chartSvg(spec: ChartSpec, width = 1000, height = 560): string {
  const pad = { l: 82, r: 34, t: 78, b: 82 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  let marks = "";
  let legend = "";

  if (spec.type === "bar") {
    const outlierIndex = chartOutlierIndex(spec);
    if (outlierIndex !== null) {
      const series = spec.series[0]!;
      const comparable = spec.labels
        .map((label, index) => ({ label, value: series.values[index] ?? 0, index }))
        .filter((item) => item.index !== outlierIndex);
      const max = Math.max(1, ...comparable.map((item) => Math.abs(item.value))) * 1.12;
      const left = pad.l + 190;
      const chartW = width * 0.52;
      const rowH = Math.min(58, Math.max(36, h / Math.max(1, comparable.length)));
      comparable.forEach((item, row) => {
        const y = pad.t + row * rowH + 5;
        const barW = chartW * Math.abs(item.value) / max;
        marks += svgMultilineText(wrapText(item.label, 22, 2), left - 14, y + 17, "lab", "end", 15);
        marks += `<rect x="${left}" y="${y}" width="${Math.max(2, barW)}" height="${Math.max(18, rowH - 14)}" rx="5" fill="${palette[0]}"/>`;
        marks += `<text x="${left + Math.max(6, barW) + 8}" y="${y + Math.max(18, rowH - 14) / 2 + 5}" class="val">${esc(formatValue(item.value))}</text>`;
      });
      const outlierValue = series.values[outlierIndex] ?? 0;
      const outlierLabel = spec.labels[outlierIndex] ?? "Outlier";
      const calloutX = width * 0.75;
      marks += `<rect x="${calloutX}" y="${pad.t + 30}" width="${width - calloutX - 36}" height="${Math.min(230, h - 60)}" rx="18" fill="#f1e5c5" stroke="#c99a2e" stroke-width="2"/>`;
      marks += `<text x="${calloutX + 24}" y="${pad.t + 76}" class="kicker">Different scale</text>`;
      marks += `<text x="${calloutX + 24}" y="${pad.t + 130}" class="big">${esc(formatValue(outlierValue))}</text>`;
      marks += svgMultilineText(wrapText(outlierLabel, 24, 3), calloutX + 24, pad.t + 166, "lab", "start", 18);
      marks += `<text x="${left}" y="${pad.t + h - 8}" class="note">Comparable categories shown on their own scale; the dominant value is separated to preserve meaning.</text>`;
    } else {
      const all = spec.series.flatMap((series) => series.values).filter(Number.isFinite);
      const max = Math.max(1, ...all.map(Math.abs)) * 1.12;
      const horizontal = spec.labels.length >= 6 || spec.labels.some((label) => label.length > 14);
      if (horizontal) {
        const labelW = Math.min(250, Math.max(160, width * 0.24));
        const chartX = pad.l + labelW;
        const chartW = width - chartX - pad.r - 72;
        const rowH = h / Math.max(1, spec.labels.length);
        const groupH = Math.max(18, rowH * 0.72);
        const barH = Math.max(8, groupH / Math.max(1, spec.series.length));
        spec.labels.forEach((label, i) => {
          const y = pad.t + i * rowH + Math.max(0, (rowH - groupH) / 2);
          marks += svgMultilineText(wrapText(label, 24, 2), chartX - 14, y + 13, "lab", "end", 14);
          spec.series.forEach((series, j) => {
            const value = series.values[i] ?? 0;
            const barW = chartW * Math.abs(value) / max;
            const yy = y + j * barH;
            marks += `<rect x="${chartX}" y="${yy}" width="${Math.max(2, barW)}" height="${Math.max(6, barH - 3)}" rx="4" fill="${palette[j % palette.length]}"/>`;
            marks += `<text x="${chartX + Math.max(5, barW) + 7}" y="${yy + Math.max(6, barH - 3) / 2 + 4}" class="val">${esc(formatValue(value))}</text>`;
          });
        });
      } else {
        const group = w / Math.max(1, spec.labels.length);
        const bw = Math.max(8, (group * 0.72) / Math.max(1, spec.series.length));
        spec.labels.forEach((label, i) => {
          spec.series.forEach((series, j) => {
            const value = series.values[i] ?? 0;
            const bh = h * Math.abs(value) / max;
            const x = pad.l + i * group + group * 0.14 + j * bw;
            const y = pad.t + h - bh;
            marks += `<rect x="${x}" y="${y}" width="${Math.max(4, bw - 3)}" height="${bh}" rx="3" fill="${palette[j % palette.length]}"/>`;
            marks += `<text x="${x + bw / 2}" y="${Math.max(pad.t + 12, y - 7)}" text-anchor="middle" class="val">${esc(formatValue(value))}</text>`;
          });
          marks += svgMultilineText(wrapText(label, 14, 2), pad.l + i * group + group / 2, pad.t + h + 26, "lab", "middle", 15);
        });
      }
    }
  } else if (spec.type === "line") {
    const all = spec.series.flatMap((series) => series.values).filter(Number.isFinite);
    const max = Math.max(1, ...all.map(Math.abs)) * 1.12;
    const dx = w / Math.max(1, spec.labels.length - 1);
    spec.series.forEach((series, j) => {
      const pts = series.values.map((value, i) => `${pad.l + i * dx},${pad.t + h - h * value / max}`).join(" ");
      marks += `<polyline points="${pts}" fill="none" stroke="${palette[j % palette.length]}" stroke-width="5"/>`;
      series.values.forEach((value, i) => {
        marks += `<circle cx="${pad.l + i * dx}" cy="${pad.t + h - h * value / max}" r="6" fill="${palette[j % palette.length]}"/>`;
      });
    });
    spec.labels.forEach((label, i) => {
      marks += svgMultilineText(wrapText(label, 12, 2), pad.l + i * dx, pad.t + h + 26, "lab", "middle", 14);
    });
  } else {
    const values = spec.series[0]?.values ?? [];
    const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const cx = width * 0.39;
    const cy = height / 2 + 22;
    const r = Math.min(150, height * 0.29);
    const inner = spec.type === "donut" ? r * 0.55 : 0;
    let a = -Math.PI / 2;
    values.forEach((value, i) => {
      const n = Math.max(0, value);
      const end = a + n / total * Math.PI * 2;
      const large = end - a > Math.PI ? 1 : 0;
      const p1 = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      const p2 = [cx + r * Math.cos(end), cy + r * Math.sin(end)];
      const q1 = [cx + inner * Math.cos(end), cy + inner * Math.sin(end)];
      const q2 = [cx + inner * Math.cos(a), cy + inner * Math.sin(a)];
      marks += inner
        ? `<path d="M${p1} A${r},${r} 0 ${large},1 ${p2} L${q1} A${inner},${inner} 0 ${large},0 ${q2} Z" fill="${palette[i % palette.length]}"/>`
        : `<path d="M${cx},${cy} L${p1} A${r},${r} 0 ${large},1 ${p2} Z" fill="${palette[i % palette.length]}"/>`;
      const label = `${spec.labels[i] ?? ""} (${formatValue(value)})`;
      legend += `<rect x="${width * 0.63}" y="${112 + i * 45}" width="15" height="15" fill="${palette[i % palette.length]}"/>`;
      legend += svgMultilineText(wrapText(label, 30, 2), width * 0.63 + 25, 125 + i * 45, "lab", "start", 15);
      a = end;
    });
  }

  if (spec.series.length > 1) {
    spec.series.forEach((series, i) => {
      legend += `<circle cx="${90 + i * 190}" cy="${height - 30}" r="7" fill="${palette[i % palette.length]}"/><text x="${104 + i * 190}" y="${height - 25}" class="lab">${esc(series.name)}</text>`;
    });
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>text{font-family:'DejaVu Sans','Liberation Sans',sans-serif;fill:#17324d}.title{font-size:26px;font-weight:700}.lab{font-size:14px}.val{font-size:12px;font-weight:700}.note{font-size:11px;fill:#667784}.kicker{font-size:12px;font-weight:700;letter-spacing:1px;fill:#8b691c;text-transform:uppercase}.big{font-size:38px;font-weight:800;fill:#17324d}</style><rect width="100%" height="100%" rx="18" fill="#fff"/><text x="${pad.l}" y="42" class="title">${esc(spec.title)}</text><line x1="${pad.l}" y1="${pad.t + h}" x2="${pad.l + w}" y2="${pad.t + h}" stroke="#cad3d9"/>${marks}${legend}<text x="${pad.l}" y="${height - 8}" class="note">${esc(spec.sourceNote || "")}</text></svg>`;
}

export async function chartPng(spec: ChartSpec): Promise<Buffer> {
  return sharp(Buffer.from(chartSvg(spec))).png().toBuffer();
}

interface DiagramBox {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  index: number;
}

function diagramBoxes(nodes: string[], width: number, height: number): { boxes: DiagramBox[]; effectiveHeight: number; mode: "row" | "grid" } {
  const maxLength = Math.max(0, ...nodes.map((node) => node.length));
  const rowMode = nodes.length <= 4 && maxLength <= 28;
  const marginX = 70;
  const top = 112;
  const bottom = 86;
  const gapX = rowMode ? 32 : 38;
  const gapY = 34;
  const columns = rowMode ? Math.max(1, nodes.length) : Math.min(3, Math.max(2, Math.ceil(Math.sqrt(nodes.length))));
  const rows = Math.ceil(nodes.length / columns);
  const boxW = (width - marginX * 2 - gapX * Math.max(0, columns - 1)) / columns;
  const chars = Math.max(12, Math.floor(boxW / 8.2));
  const wrapped = nodes.map((node) => wrapText(node, chars, 4));
  const rowLineCounts = Array.from({ length: rows }, (_, row) =>
    Math.max(1, ...wrapped.slice(row * columns, row * columns + columns).map((lines) => lines.length)),
  );
  const rowHeights = rowLineCounts.map((lines) => Math.max(78, 34 + lines * 18));
  const neededHeight = top + rowHeights.reduce((sum, value) => sum + value, 0) + gapY * Math.max(0, rows - 1) + bottom;
  const effectiveHeight = Math.max(height, neededHeight);
  const boxes: DiagramBox[] = [];
  let y = top;
  for (let row = 0; row < rows; row++) {
    const items = nodes.slice(row * columns, row * columns + columns);
    const rowWidth = items.length * boxW + Math.max(0, items.length - 1) * gapX;
    const startX = (width - rowWidth) / 2;
    items.forEach((_, col) => {
      const index = row * columns + col;
      boxes.push({ x: startX + col * (boxW + gapX), y, w: boxW, h: rowHeights[row]!, lines: wrapped[index]!, index });
    });
    y += rowHeights[row]! + gapY;
  }
  return { boxes, effectiveHeight, mode: rowMode ? "row" : "grid" };
}

export function diagramSvg(
  d: { title: string; nodes: string[]; caption?: string },
  width = 1000,
  height = 520,
): string {
  const nodes = d.nodes.slice(0, 10);
  const layout = diagramBoxes(nodes, width, height);
  let body = "";
  for (const box of layout.boxes) {
    body += `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="15" fill="${box.index % 2 ? "#e7eef2" : "#f1e5c5"}" stroke="#c99a2e" stroke-width="2"/>`;
    const textStart = box.y + box.h / 2 - ((box.lines.length - 1) * 17) / 2 + 5;
    body += svgMultilineText(box.lines, box.x + box.w / 2, textStart, "node", "middle", 17);
  }
  for (let index = 0; index < layout.boxes.length - 1; index++) {
    const from = layout.boxes[index]!;
    const to = layout.boxes[index + 1]!;
    if (Math.abs(from.y - to.y) < 2) {
      const y = from.y + from.h / 2;
      body += `<path d="M${from.x + from.w + 5},${y} L${to.x - 8},${y}" stroke="#2f739c" stroke-width="4" fill="none" marker-end="url(#a)"/>`;
    } else {
      const sx = from.x + from.w / 2;
      const sy = from.y + from.h + 5;
      const tx = to.x + to.w / 2;
      const ty = to.y - 8;
      const midY = sy + (ty - sy) / 2;
      body += `<path d="M${sx},${sy} C${sx},${midY} ${tx},${midY} ${tx},${ty}" stroke="#2f739c" stroke-width="4" fill="none" marker-end="url(#a)"/>`;
    }
  }
  const captionY = layout.effectiveHeight - 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${layout.effectiveHeight}" viewBox="0 0 ${width} ${layout.effectiveHeight}"><defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#2f739c"/></marker></defs><style>text{font-family:'DejaVu Sans','Liberation Sans',sans-serif;fill:#17324d}.title{font-size:27px;font-weight:700}.node{font-size:14px;font-weight:650}.cap{font-size:13px;fill:#667784}</style><rect width="100%" height="100%" fill="#fff"/><text x="60" y="54" class="title">${esc(d.title)}</text>${body}<text x="60" y="${captionY}" class="cap">${esc(d.caption || "")}</text></svg>`;
}

export async function diagramPng(d: { title: string; nodes: string[]; caption?: string }): Promise<Buffer> {
  return sharp(Buffer.from(diagramSvg(d))).png().toBuffer();
}
