/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type NextRequest } from "next/server";

// Twitter in-stream image recommendation: 16:9, 1200x675 minimum.
const WIDTH = 1200;
const HEIGHT = 675;

const ORANGE = "#FFA94D";
const ORANGE_DIM = "#d4a017";
const BG = "#0a0a0a";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
  "http://localhost:9091";

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

interface TopShort {
  productCode: string;
  name: string;
  latestShortPosition?: number;
}

async function fetchTopShorts(limit: number): Promise<TopShort[]> {
  // Cloudflare worker intermittently returns 1101. Browser-mimicking
  // headers + retry. Don't use Next fetch cache — we don't want to cache
  // empty results from a flaky upstream.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(
        `${API_URL}/shorts.v1alpha1.ShortedStocksService/GetTopShorts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            Origin: "https://shorted.com.au",
            Referer: "https://shorted.com.au/",
          },
          body: JSON.stringify({
            period: "1y",
            limit,
            offset: 0,
            summaryOnly: true,
          }),
          cache: "no-store",
        },
      );
      if (res.ok) {
        const data = (await res.json()) as { timeSeries?: TopShort[] };
        return data.timeSeries ?? [];
      }
      if (res.status < 500 || attempt === 4) return [];
      await new Promise((r) => setTimeout(r, 800 * attempt));
    } catch {
      if (attempt === 4) return [];
    }
  }
  return [];
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: BG,
        backgroundImage:
          "radial-gradient(circle at 20% 20%, rgba(255,169,77,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(255,169,77,0.06) 0%, transparent 60%)",
        padding: "48px 56px",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {children}
    </div>
  );
}

function Header({ title, subtitle, logoSrc }: { title: string; subtitle: string; logoSrc: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 32 }}>
      {logoSrc ? <img src={logoSrc} width={64} height={64} /> : null}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontSize: 36,
            fontWeight: 800,
            color: ORANGE,
            letterSpacing: "0.04em",
            lineHeight: 1,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 20,
            color: ORANGE_DIM,
            marginTop: 6,
            letterSpacing: "0.04em",
          }}
        >
          {subtitle}
        </div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginTop: "auto",
        paddingTop: 24,
        borderTop: "1px solid rgba(255,169,77,0.15)",
        fontSize: 18,
        color: "#8a7040",
        letterSpacing: "0.04em",
      }}
    >
      <span>shorted.com.au</span>
      <span style={{ fontStyle: "italic" }}>
        Official ASIC data · T+4 delay · Not financial advice
      </span>
    </div>
  );
}

async function renderTopShorts(): Promise<JSX.Element> {
  const [logoSrc, stocks] = await Promise.all([getLogo(), fetchTopShorts(5)]);
  return (
    <Frame>
      <Header
        title="Most Shorted ASX Stocks"
        subtitle="Top 5 by short interest"
        logoSrc={logoSrc}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
        {stocks.slice(0, 5).map((s, i) => {
          const pct = (s.latestShortPosition ?? 0).toFixed(2);
          const barWidth = Math.min(100, (s.latestShortPosition ?? 0) * 3);
          return (
            <div
              key={s.productCode}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 24,
                padding: "10px 24px",
                borderRadius: 12,
                backgroundColor: "rgba(255,169,77,0.06)",
                border: "1px solid rgba(255,169,77,0.15)",
              }}
            >
              <span
                style={{
                  fontSize: 32,
                  fontWeight: 800,
                  color: ORANGE_DIM,
                  width: 48,
                }}
              >
                #{i + 1}
              </span>
              <span
                style={{
                  fontSize: 40,
                  fontWeight: 800,
                  color: ORANGE,
                  width: 160,
                  letterSpacing: "0.04em",
                }}
              >
                {s.productCode}
              </span>
              <div
                style={{
                  display: "flex",
                  flex: 1,
                  height: 24,
                  backgroundColor: "rgba(255,169,77,0.1)",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${barWidth}%`,
                    backgroundColor: ORANGE,
                    height: "100%",
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 36,
                  fontWeight: 700,
                  color: ORANGE,
                  width: 140,
                  textAlign: "right",
                }}
              >
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
      <Footer />
    </Frame>
  );
}

async function renderStockOfDay(): Promise<JSX.Element> {
  const [logoSrc, stocks] = await Promise.all([getLogo(), fetchTopShorts(1)]);
  const top = stocks[0];
  const pct = top ? (top.latestShortPosition ?? 0).toFixed(2) : "0.00";
  const name = top?.name ?? "—";
  const code = top?.productCode ?? "—";
  return (
    <Frame>
      <Header title="Stock of the Day" subtitle="#1 most shorted on the ASX" logoSrc={logoSrc} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          gap: 16,
        }}
      >
        <div
          style={{
            fontSize: 180,
            fontWeight: 900,
            color: ORANGE,
            letterSpacing: "0.04em",
            lineHeight: 1,
            textShadow: "0 0 40px rgba(255,169,77,0.4)",
          }}
        >
          {code}
        </div>
        <div
          style={{
            fontSize: 28,
            color: ORANGE_DIM,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            textAlign: "center",
            maxWidth: 1000,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 16,
            marginTop: 24,
          }}
        >
          <span style={{ fontSize: 80, fontWeight: 800, color: ORANGE }}>{pct}%</span>
          <span style={{ fontSize: 28, color: ORANGE_DIM }}>of shares shorted</span>
        </div>
      </div>
      <Footer />
    </Frame>
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ type: string }> },
) {
  const { type } = await params;
  let element: JSX.Element;
  switch (type) {
    case "top-shorts":
      element = await renderTopShorts();
      break;
    case "stock-of-day":
      element = await renderStockOfDay();
      break;
    default:
      return new Response(`Unknown infographic type: ${type}`, { status: 404 });
  }
  return new ImageResponse(element, {
    width: WIDTH,
    height: HEIGHT,
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
