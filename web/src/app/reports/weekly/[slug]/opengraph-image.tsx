/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "Weekly Short Selling Report - Shorted.com.au";
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

function parseWeekSlug(slug: string): { year: number; week: number } | null {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return null;
  return { year: parseInt(match[1]), week: parseInt(match[2]) };
}

function getWeekEndDate(year: number, week: number): string {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay();
  const start = new Date(simple);
  if (dow <= 4) {
    start.setUTCDate(simple.getUTCDate() - simple.getUTCDay() + 1);
  } else {
    start.setUTCDate(simple.getUTCDate() + 8 - simple.getUTCDay());
  }
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 4); // Friday
  return end.toISOString().slice(0, 10);
}

async function getTopStockForDate(
  date: string,
): Promise<{ code: string; name: string; percentageShorted: number } | null> {
  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
    "http://localhost:9091";

  // ASIC data is T+4, weekends/holidays return empty. Follow `previousDate`
  // up to 5 hops back so the OG always renders real data.
  let cursor: string | undefined = date;
  for (let hops = 0; hops < 5 && cursor; hops++) {
    try {
      const res = await fetch(
        `${apiUrl}/shorts.v1alpha1.ShortedStocksService/GetMarketByDate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", "User-Agent": "shorted-og/1.0" },
          body: JSON.stringify({ date: cursor, limit: 1, offset: 0 }),
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
        previousDate?: string;
      };
      const top = data.stocks?.[0];
      if (top) {
        return {
          code: top.productCode ?? "",
          name: top.name ?? "",
          percentageShorted: top.percentageShorted ?? 0,
        };
      }
      cursor = data.previousDate;
    } catch {
      return null;
    }
  }
  return null;
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const parsed = parseWeekSlug(slug);
  const weekLabel = parsed ? `Week ${parsed.week}, ${parsed.year}` : slug;

  const endDate = parsed ? getWeekEndDate(parsed.year, parsed.week) : "";

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
            border: "1px solid rgba(255, 169, 77, 0.25)",
            backgroundColor: "rgba(10, 10, 10, 0.65)",
            boxShadow:
              "0 0 40px rgba(255, 169, 77, 0.1), inset 0 0 40px rgba(255, 169, 77, 0.03)",
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
              <span style={{ fontSize: 46, fontWeight: 700, color: "#FFA94D" }}>
                SHORTED REPORTS
              </span>
            </div>

            <div
              style={{
                fontSize: 22,
                color: "#d4a017",
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
                border: "1px solid rgba(255, 169, 77, 0.2)",
                backgroundColor: "rgba(255, 169, 77, 0.08)",
                alignSelf: "flex-start",
              }}
            >
              <span
                style={{
                  fontSize: 24,
                  fontWeight: 700,
                  color: "#FFA94D",
                  letterSpacing: "0.05em",
                }}
              >
                {weekLabel}
              </span>
            </div>

            {stockCode ? (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: "#FFA94D",
                    marginTop: 24,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  Top Shorted
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
                      color: "#FFA94D",
                      letterSpacing: "0.04em",
                      textShadow: "0 0 30px rgba(255,169,77,0.3)",
                    }}
                  >
                    {stockCode}
                  </span>
                  {shortPct && (
                    <span
                      style={{
                        fontSize: 48,
                        fontWeight: 700,
                        color: "#FFA94D",
                        textShadow: "0 0 20px rgba(255,169,77,0.3)",
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
                      color: "#d4a017",
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
                  color: "#FFA94D",
                  marginTop: 32,
                  letterSpacing: "0.02em",
                }}
              >
                Weekly Short Selling Report
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
            color: "#8a7040",
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
