// Admin-only: regenerate the hero image for a Take via gpt-image-2,
// upload to GCS, and update the Take's hero_image_url.
//
// This mirrors scripts/image-gen's pipeline but inlined for the web
// runtime so the admin UI can do it synchronously (~30s).

import { type NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { gcsStorage } from "~/server/gcs-storage";
import { isAdmin } from "~/server/admin";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "~/app/actions/config";

export const maxDuration = 60; // seconds — Vercel function timeout

const MODEL = "gpt-image-2-2026-04-21";
const BUCKET = process.env.GCS_LOGO_BUCKET ?? "shorted-company-logos";

const BRAND_PROMPT_PREFIX = `Editorial illustration in the style of a modern financial publication.
Visual style: dark background (near-black #0a0a0a) with selective orange
accents (#FFA94D) used sparingly for emphasis. Minimal, clean,
composition-driven. Subtle grain or noise acceptable. High contrast.

NEVER include text, words, numbers, letters, charts, graphs, bars,
lines, percentages, cityscapes, skylines, businessmen, faces, hands,
arrows, rockets, bulls, bears, dollar signs, handshakes, money stacks.

Preferred: photorealistic close-up of a physical industrial subject;
isometric/geometric data abstraction; raw materials; document close-ups
(blank, no readable text); architectural interiors; mining or
processing equipment from unconventional angles.

Lighting: low-key, deep shadow, single warm amber light source hitting
a small portion of the frame. Editorial photo register, not infographic.

Topic to illustrate:`;

const FINAL_RULES = `

CRITICAL FINAL RULES — apply these to the image you generate:
1. Do NOT add any charts, graphs, bars, lines, percentages, numbers,
   ticker symbols, currency symbols, or other data visualisation
   elements — even if the topic mentions a document.
2. Do NOT add any text, words, letters, or numbers in the image.
3. Do NOT add any people, faces, silhouettes, hands, or figures.
4. Do NOT add any city skylines or recognisable architecture.
5. Keep the composition minimal — single subject, deep negative space,
   low-key lighting, one warm orange/amber light source.`;

async function buildHeroTopicForTake(headline: string, stockCode: string): Promise<string> {
  // Lightweight inline topic — for the admin "regenerate" button we
  // don't re-plan; we just build a sane prompt from the headline.
  // (Full plan-then-generate is in scripts/image-gen/pipeline.)
  const ctx = stockCode ? ` (ASX: ${stockCode})` : "";
  return `Editorial close-up photograph evoking the article subject${ctx}: ${headline}. A single concrete physical object on a dark surface with deep shadow, lit by a single warm amber light source from one side. No text, no charts, no people.`;
}

function adminClient() {
  return createClient(
    ShortedStocksService,
    createConnectTransport({ fetch, baseUrl: SHORTS_API_URL }),
  );
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });
  }

  // 1. Fetch the Take to know its headline.
  const client = adminClient();
  let take;
  try {
    const resp = await client.getEditorialTake({ slug });
    take = resp.take;
  } catch (err) {
    return NextResponse.json({ error: `failed to load take: ${String(err)}` }, { status: 404 });
  }
  if (!take) return NextResponse.json({ error: "take not found" }, { status: 404 });

  // 2. Build prompt and generate image.
  const topic = await buildHeroTopicForTake(take.headline, take.stockCode);
  const fullPrompt = `${BRAND_PROMPT_PREFIX}\n\n${topic}\n\nFormat: 16:9 horizontal hero banner composition.${FINAL_RULES}`;

  const openai = new OpenAI({ apiKey: openaiKey });
  let pngBuffer: Buffer;
  try {
    const resp = await openai.images.generate({
      model: MODEL,
      prompt: fullPrompt,
      size: "1536x1024",
      quality: "medium",
      n: 1,
    });
    const b64 = resp.data?.[0]?.b64_json;
    if (!b64) throw new Error("no image data");
    pngBuffer = Buffer.from(b64, "base64");
  } catch (err) {
    return NextResponse.json(
      { error: `image generation failed: ${String(err)}` },
      { status: 502 },
    );
  }

  // 3. Upload to GCS.
  const safeSlug = slug.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const objectPath = `takes/${safeSlug}-hero.png`;
  const storage = gcsStorage(); // WIF on Vercel, ADC locally
  try {
    await storage.bucket(BUCKET).file(objectPath).save(pngBuffer, {
      contentType: "image/png",
      resumable: false,
      metadata: { cacheControl: "public, max-age=86400" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `GCS upload failed: ${String(err)}` },
      { status: 502 },
    );
  }
  const heroImageUrl = `https://storage.googleapis.com/${BUCKET}/${objectPath}?v=${Date.now()}`;

  // 4. Persist to DB via the admin RPC.
  try {
    await client.updateEditorialTake({ slug, heroImageUrl });
  } catch (err) {
    return NextResponse.json(
      { error: `failed to save hero url: ${String(err)}`, heroImageUrl },
      { status: 502 },
    );
  }

  return NextResponse.json({ heroImageUrl, bytes: pngBuffer.length });
}
