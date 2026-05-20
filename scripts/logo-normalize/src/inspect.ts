#!/usr/bin/env node
/**
 * Visual inspection tools for the logo-normalize output.
 *
 *   tsx src/inspect.ts contact-sheet --variant=normalized --rows=10 --cols=10 --page=1 --out=/tmp/sheet.png
 *   tsx src/inspect.ts compare --rows=8 --page=1 --out=/tmp/compare.png
 *   tsx src/inspect.ts flag-broken --out=/tmp/suspects.csv
 *   tsx src/inspect.ts focus --codes=DRO,BHP,WBC,CBA --out=/tmp/focus.png
 *
 * --variant=raw|normalized (contact-sheet only).
 * --sort=alpha|short (default alpha).
 * --short-min=10 (only stocks shorted ≥ this %; default 0 = no filter).
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { Storage, type File } from "@google-cloud/storage";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const p of [
  resolve(__dirname, "..", ".env"),
  resolve(__dirname, "..", "..", "..", ".env"),
  resolve(__dirname, "..", "..", "..", "services", ".env"),
]) {
  if (existsSync(p)) loadDotenv({ path: p, override: false });
}

const BUCKET = process.env.GCS_LOGO_BUCKET ?? "shorted-company-logos";
const API_URL = process.env.SHORTED_API_URL ?? "https://api.shorted.com.au";

const CELL = 128;          // each logo rendered at 128×128 in the grid
const LABEL_HEIGHT = 22;   // pixels reserved at bottom of each cell for the code label
const PADDING = 8;

interface Args {
  command: string;
  variant: "raw" | "normalized";
  rows: number;
  cols: number;
  page: number;
  out: string;
  codes?: string[];
  shortMin: number;
  sort: "alpha" | "short";
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "", variant: "normalized", rows: 10, cols: 10, page: 1,
    out: "/tmp/logo-inspect.png", shortMin: 0, sort: "alpha",
  };
  for (const a of argv) {
    if (a.startsWith("--variant=")) {
      const v = a.split("=")[1];
      if (v === "raw" || v === "normalized") args.variant = v;
    } else if (a.startsWith("--rows=")) args.rows = parseInt(a.split("=")[1] ?? "10", 10);
    else if (a.startsWith("--cols=")) args.cols = parseInt(a.split("=")[1] ?? "10", 10);
    else if (a.startsWith("--page=")) args.page = parseInt(a.split("=")[1] ?? "1", 10);
    else if (a.startsWith("--out=")) args.out = a.split("=").slice(1).join("=");
    else if (a.startsWith("--codes=")) args.codes = a.split("=").slice(1).join("=").split(",").map((s) => s.trim().toUpperCase());
    else if (a.startsWith("--short-min=")) args.shortMin = parseFloat(a.split("=")[1] ?? "0");
    else if (a.startsWith("--sort=")) {
      const v = a.split("=")[1];
      if (v === "alpha" || v === "short") args.sort = v;
    } else if (!a.startsWith("--") && !args.command) args.command = a;
  }
  return args;
}

interface TopShort { productCode: string; latestShortPosition?: number }

async function fetchOrderedCodes(args: Args): Promise<string[]> {
  if (args.codes && args.codes.length > 0) return args.codes;

  if (args.sort === "short") {
    // Pull from top-shorts API, optionally filter by min %.
    const res = await fetch(`${API_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      body: JSON.stringify({ period: "1y", limit: 500, offset: 0, summaryOnly: true }),
    });
    if (!res.ok) throw new Error(`GetTopShorts HTTP ${res.status}`);
    const data = (await res.json()) as { timeSeries?: TopShort[] };
    return (data.timeSeries ?? [])
      .filter((s) => (s.latestShortPosition ?? 0) >= args.shortMin)
      .map((s) => s.productCode);
  }

  // Alphabetic: list whatever's in the bucket.
  const storage = new Storage();
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: "logos-normalized/" });
  return files
    .map((f) => f.name.replace("logos-normalized/", "").replace(/\.png$/i, ""))
    .filter((n) => /^[A-Z0-9]+$/.test(n))
    .sort();
}

async function downloadLogo(
  storage: Storage,
  variant: "raw" | "normalized",
  code: string,
): Promise<Buffer | null> {
  const prefix = variant === "normalized" ? "logos-normalized/" : "logos/";
  const file = storage.bucket(BUCKET).file(`${prefix}${code}.png`);
  try {
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return buf;
  } catch {
    return null;
  }
}

// Render text via SVG (Sharp can't draw text directly).
function labelSvg(text: string, width: number, height: number): Buffer {
  const safe = text.replace(/[<>&"]/g, "");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="rgba(10,10,10,0.85)"/>
      <text x="50%" y="${Math.floor(height * 0.7)}" text-anchor="middle"
            font-family="-apple-system, system-ui, sans-serif" font-size="${Math.floor(height * 0.6)}"
            font-weight="700" fill="#FFA94D">${safe}</text>
    </svg>`,
  );
}

async function renderCell(
  buf: Buffer | null,
  code: string,
  cellSize: number,
): Promise<Buffer> {
  // Cell = transparent canvas of cellSize × (cellSize+labelHeight), with the logo
  // contained in the top square and the code label across the bottom strip.
  const totalH = cellSize + LABEL_HEIGHT;
  const composites: sharp.OverlayOptions[] = [];

  if (buf) {
    try {
      const resized = await sharp(buf)
        .resize(cellSize - PADDING * 2, cellSize - PADDING * 2, { fit: "inside" })
        .toBuffer();
      composites.push({ input: resized, gravity: "north", top: PADDING, left: PADDING });
    } catch {
      // skip — empty cell
    }
  }

  composites.push({
    input: labelSvg(code, cellSize, LABEL_HEIGHT),
    top: cellSize,
    left: 0,
  });

  return sharp({
    create: {
      width: cellSize,
      height: totalH,
      channels: 4,
      background: { r: 24, g: 24, b: 26, alpha: 1 }, // dark chrome
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

async function renderContactSheet(args: Args): Promise<void> {
  const codes = await fetchOrderedCodes(args);
  console.log(`[inspect] candidate codes: ${codes.length}`);

  const perPage = args.rows * args.cols;
  const startIdx = (args.page - 1) * perPage;
  const pageCodes = codes.slice(startIdx, startIdx + perPage);
  if (pageCodes.length === 0) {
    console.error(`[inspect] page ${args.page} is empty (only ${Math.ceil(codes.length / perPage)} pages)`);
    process.exit(1);
  }
  console.log(`[inspect] page ${args.page}/${Math.ceil(codes.length / perPage)} — codes ${pageCodes[0]} … ${pageCodes[pageCodes.length - 1]}`);

  const storage = new Storage();
  const cellTotalH = CELL + LABEL_HEIGHT;

  // Download all logos in parallel.
  const cells = await Promise.all(
    pageCodes.map(async (code) => {
      const buf = await downloadLogo(storage, args.variant, code);
      return { code, cell: await renderCell(buf, code, CELL) };
    }),
  );

  // Assemble into a grid.
  const sheetW = args.cols * CELL;
  const sheetH = args.rows * cellTotalH;
  const composites: sharp.OverlayOptions[] = cells.map(({ cell }, i) => {
    const row = Math.floor(i / args.cols);
    const col = i % args.cols;
    return { input: cell, top: row * cellTotalH, left: col * CELL };
  });

  await sharp({
    create: {
      width: sheetW,
      height: sheetH,
      channels: 4,
      background: { r: 10, g: 10, b: 12, alpha: 1 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(args.out);

  console.log(`[inspect] wrote ${args.out} (${sheetW}×${sheetH})`);
}

async function renderCompareSheet(args: Args): Promise<void> {
  const codes = await fetchOrderedCodes(args);
  const perPage = args.rows * args.cols;
  const startIdx = (args.page - 1) * perPage;
  const pageCodes = codes.slice(startIdx, startIdx + perPage);
  if (pageCodes.length === 0) {
    console.error(`[inspect] page ${args.page} empty`);
    process.exit(1);
  }
  console.log(`[inspect] compare page ${args.page} — ${pageCodes.length} pairs`);

  const storage = new Storage();
  const halfCell = Math.floor(CELL / 2) - 2; // each half a bit smaller with a thin gap
  const cellTotalH = CELL + LABEL_HEIGHT;

  const pairs = await Promise.all(
    pageCodes.map(async (code) => {
      const [raw, norm] = await Promise.all([
        downloadLogo(storage, "raw", code),
        downloadLogo(storage, "normalized", code),
      ]);

      // Side-by-side: raw on left, normalized on right.
      const innerH = CELL - PADDING * 2;
      const composites: sharp.OverlayOptions[] = [];
      const fits: Array<[Buffer | null, "west" | "east"]> = [[raw, "west"], [norm, "east"]];
      for (const [buf, gravity] of fits) {
        if (!buf) continue;
        try {
          const r = await sharp(buf).resize(halfCell, innerH, { fit: "inside" }).toBuffer();
          composites.push({
            input: r,
            top: PADDING,
            left: gravity === "west" ? PADDING : CELL - halfCell - PADDING,
          });
        } catch {
          // skip
        }
      }
      // Thin vertical divider
      composites.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="${innerH}">
            <rect width="2" height="${innerH}" fill="rgba(255,169,77,0.25)"/>
          </svg>`,
        ),
        top: PADDING,
        left: Math.floor(CELL / 2) - 1,
      });
      composites.push({
        input: labelSvg(code, CELL, LABEL_HEIGHT),
        top: CELL,
        left: 0,
      });

      const cell = await sharp({
        create: {
          width: CELL,
          height: cellTotalH,
          channels: 4,
          background: { r: 24, g: 24, b: 26, alpha: 1 },
        },
      })
        .composite(composites)
        .png()
        .toBuffer();

      return cell;
    }),
  );

  const sheetW = args.cols * CELL;
  const sheetH = args.rows * cellTotalH;
  const composites: sharp.OverlayOptions[] = pairs.map((cell, i) => {
    const row = Math.floor(i / args.cols);
    const col = i % args.cols;
    return { input: cell, top: row * cellTotalH, left: col * CELL };
  });
  await sharp({
    create: {
      width: sheetW, height: sheetH, channels: 4,
      background: { r: 10, g: 10, b: 12, alpha: 1 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(args.out);
  console.log(`[inspect] wrote ${args.out} (compare grid)`);
}

interface BrokenReport {
  code: string;
  contentPct: number;     // % of pixels considered "content" (alpha > 32, non-near-white)
  meanLuma: number;       // mean brightness of content pixels (0=black, 255=white)
  colourSpread: number;   // max-min RGB across content (0=monochrome)
  isSuspect: boolean;
  reason: string;
}

async function analyseLogo(code: string, storage: Storage): Promise<BrokenReport | null> {
  const buf = await downloadLogo(storage, "normalized", code);
  if (!buf) return null;
  // Count any opaque-enough pixel as content — it'll render against
  // some background somewhere. Both dark-on-transparent and
  // light-on-transparent logos pass this test.
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  let contentPixels = 0;
  let lumaSum = 0;
  let minR = 255, minG = 255, minB = 255;
  let maxR = 0, maxG = 0, maxB = 0;
  for (let p = 0; p < data.length; p += C) {
    const r = data[p]!, g = data[p + 1]!, b = data[p + 2]!, a = data[p + 3]!;
    if (a > 32) {
      contentPixels++;
      lumaSum += (0.299 * r + 0.587 * g + 0.114 * b);
      if (r < minR) minR = r;
      if (g < minG) minG = g;
      if (b < minB) minB = b;
      if (r > maxR) maxR = r;
      if (g > maxG) maxG = g;
      if (b > maxB) maxB = b;
    }
  }
  const total = W * H;
  const contentPct = (contentPixels / total) * 100;
  const meanLuma = contentPixels ? lumaSum / contentPixels : 0;
  const colourSpread = contentPixels ? Math.max(maxR - minR, maxG - minG, maxB - minB) : 0;

  let isSuspect = false;
  let reason = "";
  // Truly blank: <0.5% opaque pixels — almost certainly a scrape failure.
  if (contentPct < 0.5) {
    isSuspect = true;
    reason = `near-blank (${contentPct.toFixed(2)}% opaque pixels)`;
  } else if (contentPct > 95 && colourSpread < 10) {
    // Almost-entirely-uniform-coloured frame — usually a placeholder.
    isSuspect = true;
    reason = `${contentPct.toFixed(0)}% monochrome fill (spread ${colourSpread})`;
  }
  return { code, contentPct, meanLuma, colourSpread, isSuspect, reason };
}

async function flagBroken(args: Args): Promise<void> {
  const codes = await fetchOrderedCodes({ ...args, sort: "alpha" });
  console.log(`[inspect] analysing ${codes.length} logos…`);
  const storage = new Storage();
  const results: BrokenReport[] = [];
  // Limited concurrency to avoid throttling GCS.
  const POOL = 20;
  let idx = 0;
  await Promise.all(
    Array.from({ length: POOL }, async () => {
      while (idx < codes.length) {
        const i = idx++;
        const code = codes[i]!;
        const r = await analyseLogo(code, storage);
        if (r) results.push(r);
        if (results.length % 200 === 0) console.log(`[inspect] ${results.length}/${codes.length}`);
      }
    }),
  );

  const suspects = results.filter((r) => r.isSuspect)
    .sort((a, b) => a.contentPct - b.contentPct);

  const lines = [
    "code,content_pct,mean_luma,colour_spread,reason",
    ...suspects.map((r) =>
      `${r.code},${r.contentPct.toFixed(2)},${r.meanLuma.toFixed(0)},${r.colourSpread},"${r.reason}"`,
    ),
  ];
  writeFileSync(args.out, lines.join("\n") + "\n");
  console.log("");
  console.log(`[inspect] total: ${results.length}, suspects: ${suspects.length} (${((suspects.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`[inspect] wrote ${args.out}`);
  // Print the top 15 worst.
  console.log("");
  console.log("Worst offenders (first 15):");
  for (const r of suspects.slice(0, 15)) {
    console.log(`  ${r.code.padEnd(6)} ${r.contentPct.toFixed(2).padStart(6)}%  ${r.reason}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "contact-sheet":
      await renderContactSheet(args);
      break;
    case "compare":
      await renderCompareSheet(args);
      break;
    case "flag-broken":
      await flagBroken(args);
      break;
    case "focus":
      // Same as contact-sheet but for an explicit list of codes.
      if (!args.codes || args.codes.length === 0) {
        throw new Error("focus requires --codes=A,B,C");
      }
      await renderContactSheet(args);
      break;
    default:
      console.error("Usage: tsx src/inspect.ts <contact-sheet|compare|flag-broken|focus> [flags]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[inspect] FAILED:", err);
  process.exit(1);
});
