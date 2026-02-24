/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "Stock Short Position Data - Shorted.com.au";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

let cachedBg: string | null = null;

async function getBackgroundImage(): Promise<string> {
  if (cachedBg) return cachedBg;

  // Try filesystem first (works in dev + Docker)
  try {
    const data = await readFile(
      join(process.cwd(), "public/assets/preview-background.png"),
    );
    cachedBg = `data:image/png;base64,${data.toString("base64")}`;
    return cachedBg;
  } catch {
    // ignore
  }

  // Fallback: fetch from own domain (works on Vercel standalone)
  try {
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "https://shorted.com.au";
    const res = await fetch(`${siteUrl}/assets/preview-background.png`);
    const buf = Buffer.from(await res.arrayBuffer());
    cachedBg = `data:image/png;base64,${buf.toString("base64")}`;
    return cachedBg;
  } catch {
    // ignore
  }

  return "";
}

async function getStockData(
  code: string,
): Promise<{
  name: string;
  percentageShorted: number;
} | null> {
  try {
    const apiUrl =
      process.env.NEXT_PUBLIC_API_URL ??
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      "http://localhost:9091";
    const res = await fetch(
      `${apiUrl}/shorts.v1alpha1.ShortedStocksService/GetStock`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productCode: code }),
        next: { revalidate: 3600 },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      name?: string;
      percentageShorted?: number;
    };
    return {
      name: data.name ?? "",
      percentageShorted: data.percentageShorted ?? 0,
    };
  } catch {
    return null;
  }
}

export default async function Image({
  params,
}: {
  params: Promise<{ stockCode: string }>;
}) {
  const { stockCode } = await params;
  const code = stockCode.toUpperCase();

  const [bgSrc, stockData] = await Promise.all([
    getBackgroundImage(),
    getStockData(code),
  ]);

  const companyName = stockData?.name ?? "";
  const shortPct =
    stockData && stockData.percentageShorted > 0
      ? `${stockData.percentageShorted.toFixed(1)}%`
      : "N/A";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          backgroundColor: "#0a0a0a",
        }}
      >
        {/* Background image */}
        {bgSrc && (
          <img
            src={bgSrc}
            width={1200}
            height={630}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        )}

        {/* Dark overlay for text readability */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.4) 40%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0.7) 100%)",
          }}
        />

        {/* Content */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            padding: "60px 80px",
          }}
        >
          {/* Heading */}
          <div
            style={{
              fontSize: 36,
              color: "#FFA94D",
              fontWeight: 700,
              letterSpacing: "0.02em",
              marginBottom: 48,
              textShadow: "0 2px 8px rgba(0,0,0,0.8)",
            }}
          >
            See What the Bears Are Betting On
          </div>

          {/* Stock code + company name */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 24,
              marginBottom: 40,
            }}
          >
            <div
              style={{
                fontSize: 72,
                fontWeight: 800,
                color: "#FFA94D",
                letterSpacing: "0.04em",
                textShadow: "0 2px 12px rgba(255,169,77,0.4)",
              }}
            >
              {code}
            </div>
            {companyName && (
              <div
                style={{
                  fontSize: 36,
                  color: "#d4a017",
                  fontWeight: 500,
                  textShadow: "0 2px 8px rgba(0,0,0,0.8)",
                  maxWidth: 700,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {companyName}
              </div>
            )}
          </div>

          {/* Short interest bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              padding: "16px 40px",
              borderRadius: 8,
              border: "1px solid rgba(255,169,77,0.3)",
              backgroundColor: "rgba(0,0,0,0.5)",
            }}
          >
            <div
              style={{
                fontSize: 24,
                color: "#d4a017",
                fontWeight: 600,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              Short Interest
            </div>
            <div
              style={{
                fontSize: 48,
                fontWeight: 800,
                color: "#FFA94D",
                textShadow: "0 0 20px rgba(255,169,77,0.5)",
              }}
            >
              {shortPct}
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              position: "absolute",
              bottom: 40,
              display: "flex",
              alignItems: "center",
              gap: 16,
              fontSize: 18,
              color: "#8a7040",
              letterSpacing: "0.05em",
            }}
          >
            <span>
              ASX shorted data from ASIC, T+4 delayed — shorted.com.au
            </span>
            <span style={{ color: "#6b5530" }}>|</span>
            <span style={{ fontSize: 16, color: "#6b5530" }}>
              By Ben Ebsworth
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
