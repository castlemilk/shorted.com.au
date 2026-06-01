/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getStock } from "~/app/actions/getStock";

export const alt = "Stock Short Position Data - Shorted.com.au";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

// Self-healing cache: regenerate the image daily (matches ASIC's T+4 daily
// data cadence). Without this, Next.js serves the image with
// `Cache-Control: immutable, max-age=31536000`, which would freeze any
// transient render failure (e.g. an "N/A" short %) for a full year.
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

async function getStockData(
  code: string,
): Promise<{
  name: string;
  percentageShorted: number;
} | null> {
  try {
    // Reuse the canonical getStock action: it uses the Connect transport
    // (which sends the `Connect-Protocol-Version` header the WAF requires —
    // a bare fetch gets a 403 "automated access detected") and wraps
    // withRetryAndNotFound to survive Cloud Run cold starts (min instances = 0).
    const stock = await getStock(code);
    if (!stock) return null;
    return {
      name: stock.name ?? "",
      percentageShorted: stock.percentageShorted ?? 0,
    };
  } catch (err) {
    // Surface failures in Vercel logs — the previous silent catch is why this
    // rendered "N/A" undiagnosed.
    console.error(`[opengraph-image] getStock failed for ${code}:`, err);
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

  const [bgSrc, logoSrc, stockData] = await Promise.all([
    getBackgroundImage(),
    getLogoImage(),
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
            <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
              <span
                style={{
                  fontSize: 46,
                  fontWeight: 800,
                  color: "#FFA94D",
                  letterSpacing: "0.04em",
                }}
              >
                SHORTED
              </span>
              <span
                style={{
                  fontSize: 46,
                  fontWeight: 300,
                  color: "#FFA94D",
                  letterSpacing: "0.04em",
                }}
              >
                REPORTS
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
                fontSize: 20,
                fontWeight: 700,
                color: "#FFA94D",
                marginTop: 36,
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
                marginTop: 12,
              }}
            >
              <span
                style={{
                  fontSize: 72,
                  fontWeight: 800,
                  color: "#FFA94D",
                  letterSpacing: "0.04em",
                  textShadow: "0 0 30px rgba(255,169,77,0.3)",
                }}
              >
                {code}
              </span>
              <span
                style={{
                  fontSize: 56,
                  fontWeight: 700,
                  color: "#FFA94D",
                  textShadow: "0 0 20px rgba(255,169,77,0.3)",
                }}
              >
                {shortPct}
              </span>
            </div>

            {companyName && (
              <div
                style={{
                  fontSize: 24,
                  color: "#d4a017",
                  marginTop: 8,
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
