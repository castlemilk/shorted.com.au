/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "Industry Short Positions - Shorted.com.au";
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
    const ext = path.split(".").pop() ?? "png";
    const mime = ext === "webp" ? "image/webp" : "image/png";
    const data = await readFile(join(process.cwd(), path));
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    // ignore
  }
  try {
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "https://shorted.com.au";
    const res = await fetch(`${siteUrl}/${path.replace(/^public\//, "")}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = path.split(".").pop() ?? "png";
    const mime = ext === "webp" ? "image/webp" : "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
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

// Use the shared sector image mapping to resolve industry name → filename
import { getSectorImagePathPng } from "~/@/lib/sector-images";

async function getSectorImage(industryName: string): Promise<string> {
  // getSectorImagePathPng returns "/assets/sectors/foo.png" — prepend "public"
  const relPath = getSectorImagePathPng(industryName);
  const pngSrc = await getAssetBase64(`public${relPath}`);
  if (pngSrc) return pngSrc;
  // Fallback to webp
  return getAssetBase64(`public${relPath.replace(".png", ".webp")}`);
}

// Fetch industry data from API
interface IndustryOGData {
  name: string;
  stockCount: number;
  avgShortPercent: number;
  topStockCode: string;
  topStockPercent: number;
  highlyShortedCount: number;
}

async function getIndustryOGData(
  slug: string,
): Promise<IndustryOGData | null> {
  try {
    const apiUrl =
      process.env.NEXT_PUBLIC_API_URL ??
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      "http://localhost:9091";
    const res = await fetch(
      `${apiUrl}/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", "User-Agent": "shorted-og/1.0" },
        body: JSON.stringify({
          period: "3m",
          limit: 50,
          viewMode: 0,
        }),
        next: { revalidate: 3600 },
      },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      stocks?: Array<{
        productCode?: string;
        industry?: string;
        shortPosition?: number;
      }>;
    };

    const INVALID = new Set(["Class Pend", "Not Applic", "Not Applicable", ""]);
    const matching: Array<{ code: string; percent: number; industry: string }> =
      [];

    for (const stock of data.stocks ?? []) {
      let industry = stock.industry?.trim() ?? "Other";
      if (INVALID.has(industry)) industry = "Other";

      const stockSlug = industry
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      if (stockSlug === slug) {
        matching.push({
          code: stock.productCode ?? "",
          percent: stock.shortPosition ?? 0,
          industry,
        });
      }
    }

    if (matching.length === 0) return null;

    matching.sort((a, b) => b.percent - a.percent);
    const top = matching[0]!;
    const totalPercent = matching.reduce((sum, s) => sum + s.percent, 0);
    const highlyShorted = matching.filter((s) => s.percent > 10).length;

    return {
      name: top.industry,
      stockCount: matching.length,
      avgShortPercent: totalPercent / matching.length,
      topStockCode: top.code,
      topStockPercent: top.percent,
      highlyShortedCount: highlyShorted,
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

  const [bgSrc, logoSrc, industryData] = await Promise.all([
    getBackgroundImage(),
    getLogoImage(),
    getIndustryOGData(slug),
  ]);

  const industryName = industryData?.name ?? slug.replace(/-/g, " ");
  const sectorSrc = await getSectorImage(industryName);
  const stockCount = industryData?.stockCount ?? 0;
  const avgShort = industryData?.avgShortPercent ?? 0;
  const topCode = industryData?.topStockCode ?? "";
  const topPct = industryData?.topStockPercent ?? 0;
  const highlyShorted = industryData?.highlyShortedCount ?? 0;

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
              opacity: 0.4,
            }}
          />
        )}

        {/* Gradient overlay */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            background:
              "linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.75) 100%)",
          }}
        />

        {/* Main card */}
        <div
          style={{
            position: "absolute",
            top: 32,
            left: 48,
            right: 48,
            bottom: 32,
            display: "flex",
            borderRadius: 20,
            border: "1px solid rgba(255, 169, 77, 0.2)",
            backgroundColor: "rgba(10, 10, 10, 0.7)",
            boxShadow:
              "0 0 60px rgba(255, 169, 77, 0.08), inset 0 0 60px rgba(255, 169, 77, 0.02)",
            overflow: "hidden",
          }}
        >
          {/* Left section - sector image + branding */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: 340,
              flexShrink: 0,
              borderRight: "1px solid rgba(255, 169, 77, 0.12)",
              background:
                "linear-gradient(180deg, rgba(255,169,77,0.06) 0%, rgba(255,169,77,0.02) 100%)",
              padding: "40px 30px",
            }}
          >
            {/* Sector medallion */}
            {sectorSrc && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 200,
                  height: 200,
                  borderRadius: 100,
                  border: "2px solid rgba(255, 169, 77, 0.3)",
                  boxShadow:
                    "0 0 40px rgba(255, 169, 77, 0.15), inset 0 0 20px rgba(255, 169, 77, 0.05)",
                  overflow: "hidden",
                  marginBottom: 24,
                }}
              >
                <img
                  src={sectorSrc}
                  width={192}
                  height={192}
                  style={{ borderRadius: 96 }}
                />
              </div>
            )}

            {/* Shorted logo */}
            {logoSrc && (
              <img
                src={logoSrc}
                width={80}
                height={80}
                style={{ marginTop: 8, opacity: 0.9 }}
              />
            )}

            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "#FFA94D",
                letterSpacing: "0.15em",
                marginTop: 8,
                textTransform: "uppercase",
              }}
            >
              SHORTED.COM.AU
            </div>
          </div>

          {/* Right section - data */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              padding: "44px 50px",
              justifyContent: "space-between",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: "#d4a017",
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                Industry Short Positions
              </div>
              <div
                style={{
                  fontSize: 48,
                  fontWeight: 800,
                  color: "#FFA94D",
                  letterSpacing: "-0.01em",
                  lineHeight: 1.1,
                  textShadow: "0 0 30px rgba(255,169,77,0.2)",
                }}
              >
                {industryName}
              </div>
            </div>

            {/* Stats grid */}
            <div
              style={{
                display: "flex",
                gap: 20,
                marginTop: 32,
              }}
            >
              {/* Avg Short % */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                  padding: "18px 22px",
                  borderRadius: 12,
                  border: "1px solid rgba(255, 169, 77, 0.2)",
                  backgroundColor: "rgba(255, 169, 77, 0.06)",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#8a7040",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  Avg Short %
                </div>
                <div
                  style={{
                    fontSize: 38,
                    fontWeight: 800,
                    color: "#FFA94D",
                    marginTop: 4,
                    textShadow: "0 0 20px rgba(255,169,77,0.3)",
                  }}
                >
                  {avgShort > 0 ? `${avgShort.toFixed(1)}%` : "N/A"}
                </div>
              </div>

              {/* Stocks Tracked */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                  padding: "18px 22px",
                  borderRadius: 12,
                  border: "1px solid rgba(255, 169, 77, 0.2)",
                  backgroundColor: "rgba(255, 169, 77, 0.06)",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#8a7040",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  Stocks Tracked
                </div>
                <div
                  style={{
                    fontSize: 38,
                    fontWeight: 800,
                    color: "#FFA94D",
                    marginTop: 4,
                  }}
                >
                  {stockCount}
                </div>
              </div>

              {/* Highly Shorted */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                  padding: "18px 22px",
                  borderRadius: 12,
                  border: "1px solid rgba(255, 169, 77, 0.2)",
                  backgroundColor: "rgba(255, 169, 77, 0.06)",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#8a7040",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  Above 10%
                </div>
                <div
                  style={{
                    fontSize: 38,
                    fontWeight: 800,
                    color: highlyShorted > 0 ? "#ef4444" : "#FFA94D",
                    marginTop: 4,
                  }}
                >
                  {highlyShorted}
                </div>
              </div>
            </div>

            {/* Top shorted stock callout */}
            {topCode && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 20,
                  marginTop: 24,
                  padding: "14px 24px",
                  borderRadius: 12,
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  backgroundColor: "rgba(239, 68, 68, 0.08)",
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#ef4444",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}
                >
                  Most Shorted
                </div>
                <div
                  style={{
                    fontSize: 32,
                    fontWeight: 800,
                    color: "#FFA94D",
                    letterSpacing: "0.04em",
                  }}
                >
                  {topCode}
                </div>
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 700,
                    color: "#ef4444",
                  }}
                >
                  {topPct.toFixed(1)}%
                </div>
              </div>
            )}

            {/* Footer */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: "auto",
                paddingTop: 16,
                fontSize: 14,
                color: "#6b5530",
                letterSpacing: "0.03em",
              }}
            >
              <span>Official ASIC Data</span>
              <span>|</span>
              <span>T+4 Delay</span>
              <span>|</span>
              <span>shorted.com.au</span>
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
