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

// Fetch the take's hero image, downsized via the next/image-style URL
// approach isn't available in OG runtime — we just fetch the PNG and
// inline it. Fails gracefully if the network call doesn't return.
async function getHeroBackdrop(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000 || buf.length > 4_000_000) return null;
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

const sentimentChip = (s: string) => {
  switch (s) {
    case "positive":
      return { label: "Positive", color: "#34d399", bg: "rgba(52,211,153,0.12)", border: "rgba(52,211,153,0.4)" };
    case "negative":
      return { label: "Negative", color: "#fb7185", bg: "rgba(251,113,133,0.12)", border: "rgba(251,113,133,0.4)" };
    default:
      return { label: "Neutral", color: "#FFA94D", bg: "rgba(255,169,77,0.12)", border: "rgba(255,169,77,0.4)" };
  }
};

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const resp = await getEditorialTake(slug);
  const take = resp?.take;
  const [logoSrc, heroSrc] = await Promise.all([
    getLogo(),
    getHeroBackdrop(take?.heroImageUrl),
  ]);

  const headline = take?.headline ?? "Shorted Take";
  const stockCode = take?.stockCode ?? "";
  const sentiment = sentimentChip(take?.sentiment ?? "neutral");
  // Headline scales down for longer text so it never overflows.
  const headlineSize =
    headline.length > 100 ? 40 : headline.length > 75 ? 48 : 56;

  // Citation count, broken into news + report so the OG card can
  // surface the journalistic investment.
  const newsRefs = (take?.citations ?? []).filter((c) => c.type !== "report").length;
  const reportRefs = (take?.citations ?? []).filter((c) => c.type === "report").length;
  const sourcesLabel =
    reportRefs > 0
      ? `${newsRefs} news · ${reportRefs} report${reportRefs === 1 ? "" : "s"}`
      : newsRefs > 0
        ? `${newsRefs} article${newsRefs === 1 ? "" : "s"} cited`
        : "Editorial commentary";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          backgroundColor: "#0a0a0a",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        {/* Hero image faded into the background for visual distinction. */}
        {heroSrc ? (
          <img
            src={heroSrc}
            width={1200}
            height={630}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: 0.32,
            }}
          />
        ) : null}

        {/* Dark overlay so headline text reads cleanly over any hero. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            backgroundImage:
              "linear-gradient(135deg, rgba(10,10,10,0.88) 0%, rgba(10,10,10,0.68) 50%, rgba(10,10,10,0.92) 100%)",
          }}
        />
        {/* Subtle amber accents top-left + bottom-right */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            backgroundImage:
              "radial-gradient(circle at 12% 18%, rgba(255,169,77,0.14) 0%, transparent 45%), radial-gradient(circle at 88% 82%, rgba(255,169,77,0.10) 0%, transparent 55%)",
          }}
        />

        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            padding: "52px 60px",
          }}
        >
          {/* Header row: logo + brand label + ticker chip on the right */}
          <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 32 }}>
            {logoSrc ? <img src={logoSrc} width={52} height={52} /> : null}
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
              <div style={{ fontSize: 15, color: "#a78b58", letterSpacing: "0.04em" }}>
                {sourcesLabel}
              </div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  display: "flex",
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: `1px solid ${sentiment.border}`,
                  backgroundColor: sentiment.bg,
                  fontSize: 18,
                  fontWeight: 700,
                  color: sentiment.color,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                {sentiment.label}
              </div>
              {stockCode ? (
                <div
                  style={{
                    display: "flex",
                    padding: "10px 22px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,169,77,0.45)",
                    backgroundColor: "rgba(255,169,77,0.12)",
                    fontSize: 30,
                    fontWeight: 800,
                    color: "#FFA94D",
                    letterSpacing: "0.05em",
                  }}
                >
                  ${stockCode}
                </div>
              ) : null}
            </div>
          </div>

          {/* Headline fills the middle. White text reads better over the
              faded hero than orange did. */}
          <div
            style={{
              display: "flex",
              fontSize: headlineSize,
              fontWeight: 800,
              color: "#ffffff",
              lineHeight: 1.12,
              letterSpacing: "-0.015em",
              flex: 1,
              maxWidth: 1080,
            }}
          >
            {headline}
          </div>

          {/* Footer */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 24,
              paddingTop: 22,
              borderTop: "1px solid rgba(255,169,77,0.22)",
              fontSize: 17,
              color: "#a78b58",
            }}
          >
            <span style={{ fontWeight: 600, color: "#FFA94D" }}>
              shorted.com.au/news
            </span>
            <span style={{ fontStyle: "italic" }}>
              ASIC data · T+4 delayed · Not financial advice
            </span>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
