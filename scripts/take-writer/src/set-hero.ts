// set-hero.ts — put artwork made outside the newsroom (for example a
// BrandBrain generation) on a take as its header image, under the same
// publication review that `publish` requires.
//
//   set-hero --slug=SLUG --image=PATH --caption="Illustration: …" [--credit="…"] [--dry-run]
//
// 1. Read the take and the image: PNG, WebP or JPEG, at most 8 MiB, landscape,
//    at least 1200 px wide.
// 2. Upload it under a content-addressed name, takes/<slug>-hero-<sha12>.<ext>.
//    A new image always gets a new URL, so a CDN or browser cache can never serve
//    the old header at it (overwriting takes/<slug>-hero.png in place served the
//    old bytes for up to a day).
// 3. Run the publication vision review on the article with the candidate hero.
// 4. Only after it passes, swap hero_image_url, hero_caption and hero_credit,
//    guarded on the hero the take had when the command started.
// 5. Revalidate /news, /news/<slug> and / when the take is published.
//
// --dry-run checks the take and the file and prints the plan: no upload, no
// paid review, no write.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Storage } from "@google-cloud/storage";
import { Client as PgClient } from "pg";

import { ILLUSTRATION_CREDIT, illustrationCaption } from "./illustration-caption.js";
import { revalidateNewsSurfaces } from "./publish.js";
import { PUBLICATION_VISION_LIMITS, sniffImageType, validateArticle, type ReviewImageType } from "./validator.js";

export interface SetHeroOptions {
  slug: string;
  imagePath: string;
  caption: string;
  credit?: string;
  dryRun?: boolean;
}

export interface SetHeroResult {
  slug: string;
  previousHeroUrl: string | null;
  heroUrl: string;
  caption: string;
  credit: string;
  published: boolean;
  dryRun: boolean;
}

const MIN_HERO_WIDTH = 1200;
const EXTENSION: Record<ReviewImageType, string> = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" };

/** Pixel size from the image header, or null when the header cannot be read. */
export function imageDimensions(buf: Buffer, type: ReviewImageType): { width: number; height: number } | null {
  if (type === "image/png") {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (type === "image/webp") {
    if (buf.length < 30) return null;
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return null;
}

/** Reject anything the publication review or the page header cannot use, before any upload. */
export function checkHeroImage(buf: Buffer): { type: ReviewImageType; width: number; height: number } {
  const type = sniffImageType(buf);
  if (!type) throw new Error("hero image must be a PNG, WebP or JPEG file");
  if (buf.length > PUBLICATION_VISION_LIMITS.maxImageBytes) {
    throw new Error(`hero image is ${buf.length} bytes; the publication review accepts at most ${PUBLICATION_VISION_LIMITS.maxImageBytes}`);
  }
  const size = imageDimensions(buf, type);
  if (!size) throw new Error("could not read the hero image's dimensions");
  if (size.width < MIN_HERO_WIDTH || size.width <= size.height) {
    throw new Error(`hero image must be landscape and at least ${MIN_HERO_WIDTH}px wide (got ${size.width}x${size.height})`);
  }
  return { type, ...size };
}

/** takes/<slug>-hero-<first 12 hex of sha256>.<ext>: one URL per distinct image. */
export function heroObjectPath(slug: string, buf: Buffer, type: ReviewImageType): string {
  const sha = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  return `takes/${slug}-hero-${sha}.${EXTENSION[type]}`;
}

export async function setHero(opts: SetHeroOptions): Promise<SetHeroResult> {
  if (!opts.slug) throw new Error("--slug=SLUG required for set-hero");
  if (!opts.imagePath) throw new Error("--image=PATH required for set-hero");
  const caption = opts.caption?.trim();
  if (!caption || !/^Illustration:\s*\S/i.test(caption)) {
    throw new Error('--caption must describe the artwork and begin "Illustration:"');
  }
  const heroCaption = illustrationCaption(caption);
  const credit = opts.credit?.trim() || ILLUSTRATION_CREDIT;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");

  const buf = await readFile(opts.imagePath);
  const image = checkHeroImage(buf);
  const bucket = process.env.GCS_LOGO_BUCKET ?? "shorted-company-logos";
  const objectPath = heroObjectPath(opts.slug, buf, image.type);
  const heroUrl = `https://storage.googleapis.com/${bucket}/${objectPath}`;

  const pg = new PgClient({ connectionString: dbUrl, keepAlive: true, keepAliveInitialDelayMillis: 5_000 });
  await pg.connect();
  try {
    const { rows } = await pg.query<{ published_at: string | null; hero_image_url: string | null }>(
      `SELECT published_at, hero_image_url FROM editorial_takes WHERE slug = $1`,
      [opts.slug],
    );
    const row = rows[0];
    if (!row) throw new Error(`no editorial_takes row with slug ${opts.slug}`);
    const previousHeroUrl = row.hero_image_url;
    const published = row.published_at !== null;
    const result: SetHeroResult = { slug: opts.slug, previousHeroUrl, heroUrl, caption: heroCaption, credit, published, dryRun: Boolean(opts.dryRun) };
    console.log(`[set-hero] ${opts.slug}: ${image.type} ${image.width}x${image.height}, ${buf.length} bytes`);
    console.log(`[set-hero] current hero: ${previousHeroUrl ?? "(none)"}`);
    console.log(`[set-hero] new hero:     ${heroUrl}`);
    if (previousHeroUrl === heroUrl) throw new Error("this image is already the take's hero; nothing to do");
    if (opts.dryRun) {
      console.log("[set-hero] dry run: no upload, no review, no write");
      return result;
    }

    await new Storage().bucket(bucket).file(objectPath).save(buf, {
      contentType: image.type,
      resumable: false,
      // Content-addressed: the bytes at this URL never change.
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
    });

    try {
      await validateArticle(opts.slug, { rounds: PUBLICATION_VISION_LIMITS.rounds, requirePass: true, hero: { url: heroUrl, caption: heroCaption } });
    } catch (err) {
      throw new Error(`header review failed; the take still has its previous hero (${objectPath} is uploaded but unused)`, { cause: err });
    }

    const updated = await pg.query(
      `UPDATE editorial_takes
          SET hero_image_url = $1, hero_caption = $2, hero_credit = $3, updated_at = NOW()
        WHERE slug = $4 AND hero_image_url IS NOT DISTINCT FROM $5`,
      [heroUrl, heroCaption, credit, opts.slug, previousHeroUrl],
    );
    if (updated.rowCount !== 1) {
      throw new Error("the take's hero changed during the review; nothing written");
    }
    console.log(`[set-hero] hero replaced: ${previousHeroUrl ?? "(none)"} -> ${heroUrl}`);
    if (published) await revalidateNewsSurfaces(opts.slug);
    return result;
  } finally {
    await pg.end();
  }
}
