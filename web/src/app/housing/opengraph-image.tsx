/* eslint-disable @next/next/no-img-element -- satori (next/og) only accepts <img>, not next/image */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Australian House Prices Tracker";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Static copy, so the card can never fail on a flaky upstream. Cached for a
// day like the data-driven cards.
export const revalidate = 86400;

/**
 * The housing HUB card, in the same visual language as the per-suburb cards:
 * an archetype scene JPEG under a dark scrim and warm serif type. The hub has
 * no suburb to key an archetype from, so it borrows the most representative
 * bake (leafy-suburban) — the same committed asset the suburb cards embed. A
 * missing file degrades to the gradient-only look, never a 500.
 */
export default async function Image() {
  let bgDataUri = "";
  for (const rel of [
    join("public", "housing-banners", "og", "leafy-suburban.jpg"),
    join("web", "public", "housing-banners", "og", "leafy-suburban.jpg"),
  ]) {
    try {
      bgDataUri = `data:image/jpeg;base64,${readFileSync(join(process.cwd(), rel)).toString("base64")}`;
      break;
    } catch {
      // try the next candidate
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          backgroundColor: "#0C0C0C",
          color: "#E8DDB5",
          fontFamily: "Georgia, serif",
        }}
      >
        {bgDataUri ? (
          <img
            src={bgDataUri}
            alt=""
            width={size.width}
            height={size.height}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : null}

        {bgDataUri ? (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              display: "flex",
              backgroundColor: "rgba(8,8,8,0.6)",
            }}
          />
        ) : null}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            backgroundImage:
              "linear-gradient(150deg, rgba(255,169,77,0.20) 0%, rgba(12,12,12,0) 55%)",
          }}
        />

        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            padding: "64px 72px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              fontFamily: "monospace",
              fontSize: 22,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: "#FFA94D",
            }}
          >
            Shorted · Housing
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex" }}>
              <span
                style={{
                  fontSize: 84,
                  lineHeight: 1.05,
                  fontWeight: 600,
                  color: "#F3EAC8",
                }}
              >
                Australian house prices
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                fontFamily: "monospace",
                fontSize: 28,
                color: "#B7A98A",
              }}
            >
              <span>ABS &amp; RBA data</span>
              <span style={{ color: "#6b5530" }}>·</span>
              <span>Every suburb, mapped</span>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: "2px solid rgba(255,169,77,0.5)",
              paddingTop: 24,
              fontFamily: "monospace",
              fontSize: 22,
              color: "#9C8F72",
            }}
          >
            <span>shorted.com.au</span>
            <span>House prices &amp; demographics</span>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
