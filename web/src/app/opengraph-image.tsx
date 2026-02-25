/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "Shorted.com.au - Decode Market Sentiment";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

let cachedLogo: string | null = null;

async function getLogoBase64(): Promise<string> {
  if (cachedLogo) return cachedLogo;

  try {
    const data = await readFile(
      join(process.cwd(), "public/logo.png"),
    );
    cachedLogo = `data:image/png;base64,${data.toString("base64")}`;
    return cachedLogo;
  } catch {
    // ignore
  }

  try {
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "https://shorted.com.au";
    const res = await fetch(`${siteUrl}/logo.png`);
    const buf = Buffer.from(await res.arrayBuffer());
    cachedLogo = `data:image/png;base64,${buf.toString("base64")}`;
    return cachedLogo;
  } catch {
    // ignore
  }

  return "";
}

export default async function Image() {
  const logoSrc = await getLogoBase64();

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
          backgroundColor: "#FFFFFF",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 32,
          }}
        >
          {logoSrc && (
            <img
              src={logoSrc}
              width={220}
              height={220}
            />
          )}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline" }}>
              <span
                style={{
                  fontSize: 96,
                  fontWeight: 800,
                  color: "#E87A1E",
                  letterSpacing: "-0.02em",
                  lineHeight: 1,
                }}
              >
                Shorted
              </span>
              <span
                style={{
                  fontSize: 48,
                  fontWeight: 700,
                  color: "#E87A1E",
                  letterSpacing: "-0.01em",
                  lineHeight: 1,
                  marginLeft: 4,
                }}
              >
                .com.au
              </span>
            </div>

            <div
              style={{
                width: "100%",
                height: 3,
                backgroundColor: "#E87A1E",
                marginTop: 12,
                marginBottom: 14,
              }}
            />

            <span
              style={{
                fontSize: 38,
                fontWeight: 600,
                color: "#E87A1E",
                fontStyle: "italic",
                letterSpacing: "0.02em",
              }}
            >
              Decode Market Sentiment
            </span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
