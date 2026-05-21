/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt =
  "ASX News & Short Selling Sentiment | Shorted.com.au";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

let cachedHero: string | null = null;

async function getAssetBase64(path: string): Promise<string> {
  try {
    const data = await readFile(join(process.cwd(), path));
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    // ignore
  }
  try {
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "https://shorted.com.au";
    const res = await fetch(`${siteUrl}/${path.replace(/^public\//, "")}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

async function getHeroImage(): Promise<string> {
  if (cachedHero) return cachedHero;
  cachedHero = await getAssetBase64("public/assets/hero.png");
  return cachedHero;
}

export default async function Image() {
  const heroSrc = await getHeroImage();

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0C0C0C",
          backgroundImage:
            "radial-gradient(circle at 20% 30%, rgba(249,115,22,0.15), transparent 50%), radial-gradient(circle at 80% 70%, rgba(249,115,22,0.08), transparent 60%)",
        }}
      >
        {heroSrc ? (
          <img
            src={heroSrc}
            width={520}
            height={161}
            style={{ marginBottom: 32 }}
          />
        ) : (
          <div
            style={{
              fontSize: 56,
              fontWeight: 700,
              color: "#ffffff",
              marginBottom: 32,
            }}
          >
            Shorted.com.au
          </div>
        )}

        <div
          style={{
            fontSize: 44,
            fontWeight: 700,
            color: "#ffffff",
            marginBottom: 14,
            letterSpacing: "-0.02em",
          }}
        >
          ASX News &amp; Sentiment
        </div>

        <div
          style={{
            fontSize: 24,
            color: "#a1a1aa",
            textAlign: "center",
            maxWidth: 880,
            lineHeight: 1.4,
            padding: "0 60px",
          }}
        >
          Aggregated headlines with AI sentiment, paired with Shorted Takes
          on what the data is saying
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 26,
          }}
        >
          <div
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              backgroundColor: "rgba(249, 115, 22, 0.1)",
              border: "1px solid rgba(249, 115, 22, 0.3)",
              fontSize: 16,
              color: "#f97316",
              display: "flex",
            }}
          >
            Stockhead · Motley Fool · Kalkine · Google News
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 36,
            fontSize: 20,
            color: "#52525b",
          }}
        >
          shorted.com.au/news
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
