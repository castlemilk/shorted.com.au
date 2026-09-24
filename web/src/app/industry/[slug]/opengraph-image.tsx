/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getIndustryStocks } from "~/app/actions/industry/getIndustryData";
import { getStock } from "~/app/actions/getStock";
import { getSectorImagePathPng } from "~/@/lib/sector-images";
import {
  OG,
  OG_CONTENT_TYPE,
  OG_SERIF,
  OG_SIZE,
  OgLogoChip,
  getCompanyLogo,
  getOgLogo,
  type CompanyLogo,
} from "~/@/lib/og/card";

export const alt = "Most shorted ASX stocks by industry — Shorted.com.au";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
// Self-healing cache: regenerate daily so a transient fetch failure doesn't
// freeze a broken image for a year via Next.js's default immutable cache.
export const revalidate = 86400;

/**
 * The sector medallion is the same PNG the page's hero renders (lib/sector-images),
 * read off disk with an HTTP fallback for runtimes where cwd is not the app root.
 */
async function getSectorImage(industryName: string): Promise<string> {
  const rel = getSectorImagePathPng(industryName);
  for (const base of [process.cwd(), join(process.cwd(), "web")]) {
    try {
      const data = await readFile(join(base, "public", rel));
      return `data:image/png;base64,${data.toString("base64")}`;
    } catch {
      // try the next candidate
    }
  }
  try {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://shorted.com.au";
    const res = await fetch(`${siteUrl}${rel}`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return "";
    return `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return "";
  }
}

interface LeaderRow {
  code: string;
  shortPercent: number;
  brand: CompanyLogo;
}

function heat(pct: number): string {
  if (pct >= 15) return OG.red;
  if (pct >= 10) return "#fb923c";
  if (pct >= 5) return OG.orange;
  return OG.text;
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  let industryName = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  let stockCount = 0;
  let avgShort = 0;
  let highlyShorted = 0;
  let leaders: LeaderRow[] = [];

  // Best-effort: the same React-cached read the page makes. Any failure leaves
  // the slug-derived name on a plain card — never a 500 for a share fetch.
  try {
    const { industry, stocks } = await getIndustryStocks(slug);
    if (industry) {
      industryName = industry.name;
      stockCount = industry.stockCount;
      avgShort = industry.avgShortPercent;
      highlyShorted = stocks.filter((s) => s.shortPercent > 10).length;
      const top = stocks.slice(0, 3);
      // Company marks are optional garnish with a hard timeout each; a slow GCS
      // read yields a row without a chip, never a blank card.
      const brands = await Promise.all(
        top.map(async (s) => {
          try {
            const stock = await getStock(s.code);
            return getCompanyLogo(stock?.logoUrl);
          } catch {
            return { src: "", aspect: 1 };
          }
        }),
      );
      leaders = top.map((s, i) => ({ code: s.code, shortPercent: s.shortPercent, brand: brands[i] ?? { src: "", aspect: 1 } }));
    }
  } catch (err) {
    console.error(`[opengraph-image] industry fetch failed for ${slug}:`, err);
  }

  const [logoSrc, sectorSrc] = await Promise.all([getOgLogo(), getSectorImage(industryName)]);

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: OG.bg,
          backgroundImage: `linear-gradient(135deg, ${OG.bg} 0%, ${OG.bgAlt} 55%, ${OG.bg} 100%)`,
          padding: "56px 64px",
          position: "relative",
        }}
      >
        {/* top rule — the shared canvas */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 8,
            backgroundImage: `linear-gradient(90deg, ${OG.orange} 0%, ${OG.orangeDim} 100%)`,
          }}
        />

        <div style={{ display: "flex", flex: 1, gap: 44, alignItems: "flex-start" }}>
          {/* copy + stats */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                fontSize: 22,
                letterSpacing: 3,
                textTransform: "uppercase",
                color: OG.orange,
                fontWeight: 600,
              }}
            >
              Most shorted ASX stocks
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 18,
                fontSize: industryName.length > 26 ? 50 : 62,
                lineHeight: 1.06,
                fontFamily: OG_SERIF,
                color: OG.text,
                fontWeight: 700,
                maxWidth: 720,
              }}
            >
              {industryName}
            </div>

            {stockCount > 0 && (
              <div style={{ display: "flex", marginTop: 22, gap: 40 }}>
                {[
                  { label: "Avg short interest", value: `${avgShort.toFixed(1)}%` },
                  { label: "Stocks tracked", value: String(stockCount) },
                  { label: "Above 10%", value: String(highlyShorted), tone: highlyShorted > 0 ? OG.red : OG.text },
                ].map((s) => (
                  <div key={s.label} style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ display: "flex", fontSize: 17, letterSpacing: 1.5, textTransform: "uppercase", color: OG.textDim }}>
                      {s.label}
                    </div>
                    <div style={{ display: "flex", marginTop: 4, fontSize: 34, fontWeight: 700, color: s.tone ?? OG.text }}>
                      {s.value}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {leaders.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", marginTop: 20, gap: 8 }}>
                {leaders.map((row, i) => (
                  <div
                    key={row.code}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                      padding: "6px 14px",
                      borderRadius: 12,
                      border: `1px solid ${OG.border}`,
                      backgroundColor: "rgba(255,255,255,0.03)",
                      width: 620,
                    }}
                  >
                    <div style={{ display: "flex", width: 26, fontSize: 20, color: OG.textDim, fontWeight: 700 }}>
                      {i + 1}
                    </div>
                    {row.brand.src ? <OgLogoChip logo={row.brand} size={36} /> : null}
                    <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: OG.text, fontFamily: OG_SERIF }}>
                      {row.code}
                    </div>
                    <div style={{ display: "flex", marginLeft: "auto", fontSize: 26, fontWeight: 700, color: heat(row.shortPercent) }}>
                      {row.shortPercent.toFixed(2)}% shorted
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* sector medallion — the page hero's own image */}
          {sectorSrc ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 300,
                height: 300,
                borderRadius: 150,
                border: `2px solid rgba(255,169,77,0.35)`,
                boxShadow: "0 0 60px rgba(255,169,77,0.12)",
                backgroundColor: "rgba(255,169,77,0.05)",
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <img src={sectorSrc} width={272} height={272} style={{ borderRadius: 136 }} />
            </div>
          ) : null}
        </div>

        {/* footer pinned to the bottom */}
        <div
          style={{
            display: "flex",
            marginTop: "auto",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${OG.border}`,
            paddingTop: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {logoSrc && <img src={logoSrc} width={48} height={48} style={{ borderRadius: 8 }} />}
            <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: OG.text }}>Shorted</div>
          </div>
          <div style={{ display: "flex", fontSize: 22, color: OG.textDim }}>Official ASIC data · T+4 · shorted.com.au</div>
        </div>
      </div>
    ),
    size,
  );
}
