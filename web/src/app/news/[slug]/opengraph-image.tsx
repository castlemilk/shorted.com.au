/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getEditorialTake } from "~/app/actions/getEditorialTake";

export const alt = "Shorted Take";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

let cachedLogo: string | null = null;
async function getLogo(): Promise<string> {
  if (cachedLogo) return cachedLogo;
  try {
    const data = await readFile(
      join(process.cwd(), "public/assets/logo-small.png"),
    );
    cachedLogo = `data:image/png;base64,${data.toString("base64")}`;
    return cachedLogo;
  } catch {
    return "";
  }
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const resp = await getEditorialTake(slug);
  const take = resp?.take;
  const [logoSrc] = await Promise.all([getLogo()]);

  const headline = take?.headline ?? "Shorted Take";
  const stockCode = take?.stockCode ?? "";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#0a0a0a",
          backgroundImage:
            "radial-gradient(circle at 20% 20%, rgba(255,169,77,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255,169,77,0.06) 0%, transparent 60%)",
          padding: "56px 64px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 36 }}>
          {logoSrc ? <img src={logoSrc} width={56} height={56} /> : null}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#FFA94D",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
              }}
            >
              Shorted Take
            </div>
            <div style={{ fontSize: 16, color: "#d4a017", letterSpacing: "0.04em" }}>
              Editorial commentary
            </div>
          </div>
          {stockCode ? (
            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                padding: "10px 22px",
                borderRadius: 10,
                border: "1px solid rgba(255,169,77,0.3)",
                backgroundColor: "rgba(255,169,77,0.1)",
                fontSize: 32,
                fontWeight: 800,
                color: "#FFA94D",
                letterSpacing: "0.05em",
              }}
            >
              ${stockCode}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            fontSize: headline.length > 90 ? 44 : 56,
            fontWeight: 800,
            color: "#FFA94D",
            lineHeight: 1.15,
            letterSpacing: "-0.01em",
            flex: 1,
          }}
        >
          {headline}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 24,
            paddingTop: 24,
            borderTop: "1px solid rgba(255,169,77,0.2)",
            fontSize: 18,
            color: "#8a7040",
          }}
        >
          <span>shorted.com.au/news</span>
          <span style={{ fontStyle: "italic" }}>
            ASIC data · Not financial advice
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
