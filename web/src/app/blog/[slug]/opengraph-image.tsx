/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPostBySlug } from "~/@/lib/api";

export const alt = "Shorted Blog Post";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

let cachedLogo: string | null = null;

async function getLogoBase64(): Promise<string> {
  if (cachedLogo) return cachedLogo;

  // Try filesystem first (works in dev + Docker)
  try {
    const data = await readFile(
      join(process.cwd(), "public/assets/logo-small.png"),
    );
    cachedLogo = `data:image/png;base64,${data.toString("base64")}`;
    return cachedLogo;
  } catch {
    // ignore
  }

  // Fallback: fetch from own domain (works on Vercel standalone)
  try {
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "https://shorted.com.au";
    const res = await fetch(`${siteUrl}/assets/logo-small.png`);
    const buf = Buffer.from(await res.arrayBuffer());
    cachedLogo = `data:image/png;base64,${buf.toString("base64")}`;
    return cachedLogo;
  } catch {
    // ignore
  }

  return "";
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  const logoSrc = await getLogoBase64();

  const title = post?.title ?? "Blog Post";
  const date = post?.date
    ? new Date(post.date).toLocaleDateString("en-AU", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";
  const authorName = post?.author?.name ?? "Ben Ebsworth";

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#0C0C0C",
          backgroundImage:
            "radial-gradient(circle at 25% 25%, #1a1a1a 0%, transparent 50%), radial-gradient(circle at 75% 75%, #1a1a1a 0%, transparent 50%)",
          padding: "60px 80px",
          position: "relative",
        }}
      >
        {/* Top: Logo + brand + blog badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
            }}
          >
            {logoSrc ? (
              <img
                src={logoSrc}
                width={56}
                height={56}
                style={{ marginRight: 16 }}
              />
            ) : (
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 12,
                  background:
                    "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginRight: 16,
                  fontSize: 32,
                  color: "white",
                }}
              >
                S
              </div>
            )}
            <span
              style={{
                fontSize: 40,
                fontWeight: 700,
                color: "#ffffff",
                letterSpacing: "-0.02em",
              }}
            >
              Shorted
            </span>
          </div>

          {/* Blog badge */}
          <div
            style={{
              display: "flex",
              padding: "8px 20px",
              borderRadius: 8,
              backgroundColor: "rgba(249, 115, 22, 0.1)",
              border: "1px solid rgba(249, 115, 22, 0.3)",
            }}
          >
            <span style={{ fontSize: 18, color: "#f97316", fontWeight: 600 }}>
              Blog
            </span>
          </div>
        </div>

        {/* Title */}
        <div
          style={{
            display: "flex",
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontSize: title.length > 60 ? 40 : 48,
              fontWeight: 700,
              color: "#ffffff",
              textAlign: "center",
              lineHeight: 1.3,
              maxWidth: 1000,
            }}
          >
            {title}
          </div>
        </div>

        {/* Footer: date + author + site */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              fontSize: 22,
              color: "#71717a",
            }}
          >
            {date && <span>{date}</span>}
            {date && <span style={{ color: "#3f3f46" }}>|</span>}
            <span style={{ color: "#a1a1aa" }}>By {authorName}</span>
          </div>

          <div
            style={{
              fontSize: 20,
              color: "#52525b",
            }}
          >
            shorted.com.au
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
