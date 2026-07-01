import { type NextRequest } from "next/server";
import sharp from "sharp";
import { verifyEmailImageSignature, isBlockedHost } from "@/lib/email-image";

// sharp needs the Node runtime (not edge).
export const runtime = "nodejs";
// Params-driven; we control caching via response headers below.
export const dynamic = "force-dynamic";

const FALLBACK = "/email/logo-mark.png";
const MAX_BYTES = 8 * 1024 * 1024; // 8MB upstream cap
const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
// Cap decoded pixels so a small, highly-compressed "decompression bomb" can't
// exhaust function memory. Far above any legitimate 3:2 article thumbnail.
const MAX_INPUT_PIXELS = 24_000_000;

/**
 * GET /api/email/img?u=<image url>&w=<display width>&s=<hmac>
 *
 * Fetches an HMAC-signed upstream image, hard-compresses it to a small JPEG
 * (mozjpeg q70), and serves it with a 1-year immutable cache so Vercel's CDN and
 * Gmail's image proxy each fetch+compress it exactly once. Used for news-digest
 * article thumbnails so emails render fast and don't hotlink/leak to news CDNs.
 *
 * Any failure (bad signature aside) redirects to the branded fallback tile so a
 * card never shows a broken image.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const origin = req.nextUrl.origin;
  const u = req.nextUrl.searchParams.get("u") ?? "";
  const w = req.nextUrl.searchParams.get("w") ?? "120";
  const s = req.nextUrl.searchParams.get("s") ?? "";
  const secret = process.env.EMAIL_IMG_SECRET ?? "";

  // Signature is the primary access control: only URLs we signed are served.
  if (!verifyEmailImageSignature(u, w, s, secret)) {
    return new Response("forbidden", { status: 403 });
  }

  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return fallback(origin);
  }
  if (!isAllowedTarget(target)) {
    return fallback(origin);
  }

  const displayW = Math.min(Math.max(parseInt(w, 10) || 120, 16), 400);
  const outW = displayW * 2; // 2x for retina
  const outH = Math.round((outW * 2) / 3); // 3:2 card thumbnail

  try {
    const res = await fetchFollowingSafeRedirects(target);
    if (!res || !res.ok) return fallback(origin);
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.startsWith("text/") || ct.startsWith("application/json")) {
      return fallback(origin);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
      return fallback(origin);
    }
    const out = await sharp(buf, {
      failOn: "truncated",
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate() // honour EXIF orientation
      .resize({ width: outW, height: outH, fit: "cover", position: "attention" })
      .jpeg({ quality: 70, mozjpeg: true, progressive: true })
      .toBuffer();
    return new Response(new Uint8Array(out), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control":
          "public, max-age=31536000, s-maxage=31536000, immutable",
        "Content-Length": String(out.byteLength),
      },
    });
  } catch {
    return fallback(origin);
  }
}

function isAllowedTarget(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !isBlockedHost(url.hostname)
  );
}

/**
 * fetchFollowingSafeRedirects follows redirects manually, re-validating the host
 * of every hop. `redirect: "follow"` would let a signed public URL 302 into a
 * private/link-local address (SSRF), so the per-hop check is required.
 */
async function fetchFollowingSafeRedirects(
  start: URL,
): Promise<Response | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": "shorted-email-img/1.0 (+https://shorted.com.au)",
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        },
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      let next: URL;
      try {
        next = new URL(loc, url);
      } catch {
        return null;
      }
      if (!isAllowedTarget(next)) return null;
      url = next;
      continue;
    }
    return res;
  }
  return null; // too many redirects
}

function fallback(origin: string): Response {
  // Bound re-invocation for a persistently broken upstream without hard-caching
  // a failure (transient failures can still recover). Construct manually because
  // Response.redirect() headers are immutable.
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(FALLBACK, origin).toString(),
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
