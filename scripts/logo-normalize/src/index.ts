#!/usr/bin/env node
/**
 * Normalise every logo in gs://shorted-company-logos/logos/ into
 * gs://shorted-company-logos/logos-normalized/<code>.png.
 *
 * Per logo:
 *   1. Download source PNG
 *   2. Trim transparent/near-white whitespace
 *   3. Centre on a 256×256 transparent PNG, contain-fit
 *   4. Upload to logos-normalized/<code>.png with long cache headers
 *
 * Idempotent — skips logos whose normalized version already exists
 * unless --force is passed.
 *
 * Usage:
 *   tsx src/index.ts                       # process all, skip existing
 *   tsx src/index.ts --force               # reprocess all
 *   tsx src/index.ts --only=DRO,BHP        # specific codes only
 *   tsx src/index.ts --concurrency=20      # default 10
 *   tsx src/index.ts --dry-run             # plan without writing
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { Storage } from "@google-cloud/storage";
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
const SOURCE_PREFIX = "logos/";
const DEST_PREFIX = "logos-normalized/";
const CANVAS = 256;
// Padding around the trimmed mark — small breathing room, not a frame.
const PADDING = 16;

interface Args {
  force: boolean;
  dryRun: boolean;
  only?: Set<string>;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, dryRun: false, concurrency: 10 };
  for (const a of argv) {
    if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--only=")) {
      args.only = new Set(
        a.split("=").slice(1).join("=").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
      );
    } else if (a.startsWith("--concurrency=")) {
      const v = parseInt(a.split("=")[1] ?? "10", 10);
      if (Number.isFinite(v) && v > 0) args.concurrency = v;
    }
  }
  return args;
}

// Find the tight content bounding box. A pixel counts as "content" iff
//   - it is sufficiently opaque (alpha > alphaThreshold), AND
//   - it is sufficiently distinct from the sampled background colour
//     (corner pixels — usually transparent or solid white).
//
// This catches the common case where a logo PNG has visible-looking
// transparency but is actually filled with white pixels at alpha=255
// that Sharp's built-in trim() can't tell apart from real content.
async function tightBounds(
  pngBuffer: Buffer,
  alphaThreshold = 32,
  colourTolerance = 12,
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const { data, info } = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;

  // Sample the four corners + 1px in to capture the background colour.
  // If they disagree, fall back to alpha-only thresholding (the logo
  // probably already has clean transparency).
  const samples: number[][] = [];
  for (const [x, y] of [
    [0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1],
    [1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2],
  ] as const) {
    const idx = (y * W + x) * C;
    samples.push([data[idx]!, data[idx + 1]!, data[idx + 2]!, data[idx + 3]!]);
  }
  // Background = corners agree within tolerance.
  const ref = samples[0]!;
  const cornerAgree = samples.every((p) =>
    Math.abs(p[0]! - ref[0]!) <= colourTolerance &&
    Math.abs(p[1]! - ref[1]!) <= colourTolerance &&
    Math.abs(p[2]! - ref[2]!) <= colourTolerance,
  );
  const bgR = ref[0]!;
  const bgG = ref[1]!;
  const bgB = ref[2]!;
  const bgA = ref[3]!;
  const bgIsTransparent = bgA <= alphaThreshold;

  // Two passes:
  //   strict — pixel must be opaque AND not pure-white (handles logos
  //            that have stray RGB=(255,255,255,255) "phantom" pixels
  //            in their export, like the DRO logo).
  //   lenient — fallback when strict finds nothing (e.g. legitimate
  //            white-on-transparent logos).
  const scan = (strict: boolean) => {
    let mnX = W, mnY = H, mxX = -1, mxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * C;
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const a = data[i + 3]!;
        let isContent: boolean;
        if (cornerAgree && !bgIsTransparent) {
          // Solid-coloured background (e.g. white card with logo on top).
          const colourDiff = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
          isContent = colourDiff > colourTolerance * 3 || a + alphaThreshold < bgA;
        } else if (strict) {
          // Strict: alpha-opaque AND not near-white.
          const nearWhite = r > 245 && g > 245 && b > 245;
          isContent = a > alphaThreshold && !nearWhite;
        } else {
          isContent = a > alphaThreshold;
        }
        if (isContent) {
          if (x < mnX) mnX = x;
          if (y < mnY) mnY = y;
          if (x > mxX) mxX = x;
          if (y > mxY) mxY = y;
        }
      }
    }
    return { mnX, mnY, mxX, mxY };
  };

  let { mnX: minX, mnY: minY, mxX: maxX, mxY: maxY } = scan(true);
  if (maxX < 0) ({ mnX: minX, mnY: minY, mxX: maxX, mxY: maxY } = scan(false));
  if (maxX < 0) return null;
  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

async function normaliseLogo(src: Buffer): Promise<Buffer> {
  // 1. Find the tight content bounding box and extract just that region.
  //    Threshold 32 catches near-invisible AA pixels while still tolerating
  //    legitimate semi-transparent edges in the mark itself.
  const normalised = await sharp(src).ensureAlpha().png().toBuffer();
  const bounds = await tightBounds(normalised, 32);
  const trimmed = bounds
    ? await sharp(normalised)
        .extract({
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        })
        .toBuffer()
    : normalised;

  const meta = await sharp(trimmed).metadata();
  const w = meta.width ?? CANVAS;
  const h = meta.height ?? CANVAS;
  const targetInner = CANVAS - PADDING * 2;

  // 2. Resize trimmed mark to fit inside the inner area, preserving aspect.
  const scale = Math.min(targetInner / w, targetInner / h);
  const newW = Math.max(1, Math.round(w * scale));
  const newH = Math.max(1, Math.round(h * scale));
  const resized = await sharp(trimmed)
    .resize(newW, newH, { fit: "inside" })
    .toBuffer();

  // 3. Composite onto a 256×256 transparent canvas, centred.
  return await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function processOne(
  storage: Storage,
  code: string,
  args: Args,
): Promise<"normalized" | "skipped" | "failed"> {
  const bucket = storage.bucket(BUCKET);
  const dstName = `${DEST_PREFIX}${code}.png`;
  const dstFile = bucket.file(dstName);

  if (!args.force) {
    const [exists] = await dstFile.exists();
    if (exists) return "skipped";
  }

  try {
    const srcFile = bucket.file(`${SOURCE_PREFIX}${code}.png`);
    const [src] = await srcFile.download();
    const out = await normaliseLogo(src);
    if (args.dryRun) {
      console.log(`  [dry-run] would write ${dstName} (${out.length}b)`);
      return "normalized";
    }
    await dstFile.save(out, {
      contentType: "image/png",
      resumable: false,
      // 1d browser, 7d CDN, longer SWR. Not immutable — logos do get
      // re-scraped (wrong source, brand refresh) and we want updates to
      // propagate within a day.
      metadata: { cacheControl: "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000" },
    });
    return "normalized";
  } catch (err) {
    console.warn(`  [warn] ${code}: ${String(err).slice(0, 100)}`);
    return "failed";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const storage = new Storage();
  const bucket = storage.bucket(BUCKET);

  console.log(`[normalize] listing ${BUCKET}/${SOURCE_PREFIX} …`);
  const [files] = await bucket.getFiles({ prefix: SOURCE_PREFIX });
  const codes = files
    .map((f) => f.name.replace(SOURCE_PREFIX, "").replace(/\.png$/i, ""))
    .filter((n) => /^[A-Z0-9]+$/.test(n))
    .filter((code) => !args.only || args.only.has(code));

  console.log(`[normalize] ${codes.length} candidate logos (concurrency=${args.concurrency})`);
  if (args.dryRun) console.log("[normalize] DRY RUN — no writes");

  const counts = { normalized: 0, skipped: 0, failed: 0 };
  let idx = 0;
  const t0 = Date.now();

  await Promise.all(
    Array.from({ length: args.concurrency }, async () => {
      while (idx < codes.length) {
        const i = idx++;
        const code = codes[i]!;
        const result = await processOne(storage, code, args);
        counts[result]++;
        if ((counts.normalized + counts.skipped + counts.failed) % 100 === 0) {
          const done = counts.normalized + counts.skipped + counts.failed;
          console.log(
            `[normalize] ${done}/${codes.length} (${counts.normalized}✓ ${counts.skipped}- ${counts.failed}✗)`,
          );
        }
      }
    }),
  );

  const ms = Date.now() - t0;
  console.log("");
  console.log(`[normalize] done in ${(ms / 1000).toFixed(1)}s`);
  console.log(`  normalized: ${counts.normalized}`);
  console.log(`  skipped (already done): ${counts.skipped}`);
  console.log(`  failed: ${counts.failed}`);
}

main().catch((err) => {
  console.error("[normalize] FAILED:", err);
  process.exit(1);
});
