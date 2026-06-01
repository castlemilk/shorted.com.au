/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "Yearly Short Selling Report - Shorted.com.au";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

// Self-healing cache: regenerate daily so a transient fetch failure doesn't
// freeze a broken image for a year via Next.js's default immutable cache.
export const revalidate = 86400;

let cachedBg: string | null = null;
let cachedLogo: string | null = null;

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

async function getBackgroundImage(): Promise<string> {
  if (cachedBg) return cachedBg;
  cachedBg = await getAssetBase64("public/assets/preview-background.png");
  return cachedBg;
}

async function getLogoImage(): Promise<string> {
  if (cachedLogo) return cachedLogo;
  cachedLogo = await getAssetBase64("public/assets/logo-small.png");
  return cachedLogo;
}

function parseYearSlug(slug: string): { year: number } | null {
  const match = /^(\d{4})$/.exec(slug);
  if (!match?.[1]) return null;
  const year = parseInt(match[1], 10);
  if (year < 2010 || year > 2100) return null;
  return { year };
}

function getYearEndDate(year: number): string {
  const d = new Date(Date.UTC(year, 11, 31));
  return d.toISOString().slice(0, 10);
}

async function getTopStockForDate(
  date: string,
): Promise<{ code: string; name: string; percentageShorted: number } | null> {
  try {
    const apiUrl =
      process.env.NEXT_PUBLIC_API_URL ??
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      "http://localhost:9091";
    const res = await fetch(
      `${apiUrl}/shorts.v1alpha1.ShortedStocksService/GetMarketByDate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", "User-Agent": "shorted-og/1.0" },
        body: JSON.stringify({ date, limit: 1, offset: 0 }),
        next: { revalidate: 86400 },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      stocks?: Array<{
        productCode?: string;
        name?: string;
        percentageShorted?: number;
      }>;
    };
    const top = data.stocks?.[0];
    if (!top) return null;
    return {
      code: top.productCode ?? "",
      name: top.name ?? "",
      percentageShorted: top.percentageShorted ?? 0,
    };
  } catch {
    return null;
  }
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const parsed = parseYearSlug(slug);
  const yearLabel = parsed ? `${parsed.year}` : slug;
  const endDate = parsed ? getYearEndDate(parsed.year) : "";

  const [bgSrc, logoSrc, topStock] = await Promise.all([
    getBackgroundImage(),
    getLogoImage(),
    endDate ? getTopStockForDate(endDate) : Promise.resolve(null),
  ]);

  const stockCode = topStock?.code ?? "";
  const companyName = topStock?.name ?? "";
  const shortPct =
    topStock && topStock.percentageShorted > 0
      ? `${topStock.percentageShorted.toFixed(1)}%`
      : "";

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

        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.6) 100%)",
          }}
        />

        <div
          style={{
            position: "absolute",
            top: 40,
            left: 60,
            right: 60,
            bottom: 80,
            display: "flex",
            borderRadius: 16,
            border: "1px solid rgba(0, 255, 156, 0.25)",
            backgroundColor: "rgba(10, 10, 10, 0.65)",
            boxShadow:
              "0 0 40px rgba(0, 255, 156, 0.1), inset 0 0 40px rgba(0, 255, 156, 0.03)",
            padding: "40px 50px",
          }}
        >
          {logoSrc && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "center",
                width: 200,
                paddingTop: 10,
                flexShrink: 0,
              }}
            >
              <img src={logoSrc} width={180} height={180} />
            </div>
          )}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              paddingLeft: logoSrc ? 30 : 0,
              justifyContent: "center",
            }}
          >
            <div style={{ display: "flex" }}>
              <span style={{ fontSize: 46, fontWeight: 700, color: "#00FF9C" }}>
                SHORTED ANNUAL
              </span>
            </div>

            <div
              style={{
                fontSize: 22,
                color: "#5cb38a",
                marginTop: 4,
                letterSpacing: "0.02em",
              }}
            >
              Official ASIC Short Data
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                marginTop: 28,
                padding: "8px 20px",
                borderRadius: 8,
                border: "1px solid rgba(0, 255, 156, 0.2)",
                backgroundColor: "rgba(0, 255, 156, 0.08)",
                alignSelf: "flex-start",
              }}
            >
              <span
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: "#00FF9C",
                  letterSpacing: "0.05em",
                }}
              >
                Year {yearLabel}
              </span>
            </div>

            {stockCode ? (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: "#00FF9C",
                    marginTop: 24,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  Year-End Top Short
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 40,
                    marginTop: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 64,
                      fontWeight: 800,
                      color: "#00FF9C",
                      letterSpacing: "0.04em",
                      textShadow: "0 0 30px rgba(0,255,156,0.3)",
                    }}
                  >
                    {stockCode}
                  </span>
                  {shortPct && (
                    <span
                      style={{
                        fontSize: 48,
                        fontWeight: 700,
                        color: "#00FF9C",
                        textShadow: "0 0 20px rgba(0,255,156,0.3)",
                      }}
                    >
                      {shortPct}
                    </span>
                  )}
                </div>

                {companyName && (
                  <div
                    style={{
                      fontSize: 22,
                      color: "#5cb38a",
                      marginTop: 4,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      maxWidth: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {companyName}
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  fontSize: 36,
                  fontWeight: 700,
                  color: "#00FF9C",
                  marginTop: 32,
                  letterSpacing: "0.02em",
                }}
              >
                Annual Short Selling Report
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            fontSize: 18,
            color: "#4a8a73",
            letterSpacing: "0.03em",
            fontStyle: "italic",
          }}
        >
          Data Sourced From ASIC. T+4 Delay, Not Financial Advice.
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
