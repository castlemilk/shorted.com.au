/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt =
  "ASX Short Selling Reports - Weekly & Monthly Analysis | Shorted.com.au";
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
    // ignore
  }

  return "";
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
            "radial-gradient(circle at 25% 25%, #1a1a1a 0%, transparent 50%), radial-gradient(circle at 75% 75%, #1a1a1a 0%, transparent 50%)",
        }}
      >
        {/* Hero brand image */}
        {heroSrc ? (
          <img
            src={heroSrc}
            width={600}
            height={186}
            style={{ marginBottom: 36 }}
          />
        ) : (
          <div
            style={{
              fontSize: 60,
              fontWeight: 700,
              color: "#ffffff",
              marginBottom: 36,
            }}
          >
            Shorted.com.au
          </div>
        )}

        {/* Page title */}
        <div
          style={{
            fontSize: 40,
            fontWeight: 700,
            color: "#ffffff",
            marginBottom: 16,
          }}
        >
          Short Selling Reports
        </div>

        {/* Subtitle */}
        <div
          style={{
            fontSize: 26,
            color: "#a1a1aa",
            textAlign: "center",
            maxWidth: 800,
            lineHeight: 1.4,
          }}
        >
          Weekly &amp; monthly analysis of ASX short positions
        </div>

        {/* Badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: 28,
            padding: "8px 24px",
            borderRadius: 8,
            backgroundColor: "rgba(249, 115, 22, 0.1)",
            border: "1px solid rgba(249, 115, 22, 0.3)",
          }}
        >
          <span style={{ fontSize: 18, color: "#f97316" }}>
            Official ASIC Data — T+4 Delayed
          </span>
        </div>

        {/* URL */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            fontSize: 22,
            color: "#52525b",
          }}
        >
          shorted.com.au/reports
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
