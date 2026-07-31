/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Shared building blocks for `opengraph-image.tsx` generators.
 *
 * Before this existed, `getLogoBase64` was copy-pasted into ELEVEN files and
 * the palette was re-declared per file — which is why the root card was white
 * while every other card was near-black. One brand, one card.
 *
 * SATORI CONSTRAINTS (these are why the code looks the way it does):
 *  - no `radial-gradient` — satori cannot parse it. `linear-gradient` is fine.
 *  - no webfonts unless explicitly passed to `ImageResponse({ fonts })`; we
 *    deliberately use system/Georgia stacks so a card can never fail in CI or
 *    prod on a missing font download.
 *  - every element that contains more than one child needs an explicit
 *    `display: "flex"`.
 *
 * RUNTIME: nodejs, not edge. The logo is read off disk; edge was tried and
 * abandoned over WASM build issues (see the `.disabled` files at app root).
 */

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

/** Brand palette — the dark card the Twitter/feature generators established. */
export const OG = {
  bg: "#0a0a0a",
  bgAlt: "#141414",
  text: "#fafafa",
  textDim: "#a1a1aa",
  orange: "#FFA94D",
  orangeDim: "#d4a017",
  red: "#f87171",
  green: "#4ade80",
  border: "#27272a",
} as const;

/** Serif display stack, mirroring the site's typography tokens. */
export const OG_SERIF = "Georgia, 'Times New Roman', serif";

let cachedLogo: string | null = null;

/**
 * Brand mark as a data URI. Reads from disk, falling back to an HTTP fetch
 * (which covers runtimes where `process.cwd()` isn't the app root), and
 * finally to "" so a missing logo degrades to a card without a mark rather
 * than throwing — a crawler must never get a 500 from a share fetch.
 */
export async function getOgLogo(): Promise<string> {
  if (cachedLogo !== null) return cachedLogo;

  for (const rel of ["public/icon-512.png", "public/logo.png"]) {
    try {
      const data = await readFile(join(process.cwd(), rel));
      cachedLogo = `data:image/png;base64,${data.toString("base64")}`;
      return cachedLogo;
    } catch {
      // try the next candidate
    }
  }

  try {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://shorted.com.au";
    const res = await fetch(`${siteUrl}/icon-512.png`);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      cachedLogo = `data:image/png;base64,${buf.toString("base64")}`;
      return cachedLogo;
    }
  } catch {
    // fall through
  }

  cachedLogo = "";
  return cachedLogo;
}

/**
 * The standard card: dark canvas, thin orange top rule, eyebrow, headline,
 * optional stat row, and a footer carrying the brand mark.
 *
 * Callers pass plain data, not JSX, so every card stays visually identical
 * and a new route cannot accidentally invent a new layout.
 */
export interface OgCardProps {
  /** Small uppercase label above the headline, e.g. "ASX SHORT SELLING". */
  eyebrow: string;
  /** The main line. Keep it short — satori does not hyphenate. */
  title: string;
  /** Optional supporting sentence under the headline. */
  subtitle?: string;
  /** Up to three figures rendered as a stat row. */
  stats?: Array<{ label: string; value: string; tone?: "up" | "down" | "flat" }>;
  /** Footer right-hand text. Defaults to the domain. */
  footer?: string;
  logoSrc: string;
}

function toneColor(tone?: "up" | "down" | "flat"): string {
  if (tone === "up") return OG.red; // rising short interest reads bearish
  if (tone === "down") return OG.green;
  return OG.text;
}

export function OgCard({
  eyebrow,
  title,
  subtitle,
  stats,
  footer = "shorted.com.au",
  logoSrc,
}: OgCardProps) {
  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: OG.bg,
        // linear-gradient only: satori cannot parse radial-gradient.
        backgroundImage: `linear-gradient(135deg, ${OG.bg} 0%, ${OG.bgAlt} 55%, ${OG.bg} 100%)`,
        padding: "56px 64px",
        position: "relative",
      }}
    >
      {/* top rule */}
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
        {eyebrow}
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 20,
          fontSize: title.length > 46 ? 60 : 76,
          lineHeight: 1.08,
          fontFamily: OG_SERIF,
          color: OG.text,
          fontWeight: 700,
          maxWidth: 1010,
        }}
      >
        {title}
      </div>

      {subtitle && (
        <div
          style={{
            display: "flex",
            marginTop: 20,
            fontSize: 28,
            lineHeight: 1.35,
            color: OG.textDim,
            maxWidth: 940,
          }}
        >
          {subtitle}
        </div>
      )}

      {stats && stats.length > 0 && (
        <div style={{ display: "flex", marginTop: 40, gap: 56 }}>
          {stats.slice(0, 3).map((s) => (
            <div
              key={s.label}
              style={{ display: "flex", flexDirection: "column" }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: 18,
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                  color: OG.textDim,
                }}
              >
                {s.label}
              </div>
              <div
                style={{
                  display: "flex",
                  marginTop: 6,
                  fontSize: 46,
                  fontWeight: 700,
                  color: toneColor(s.tone),
                }}
              >
                {s.value}
              </div>
            </div>
          ))}
        </div>
      )}

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
          {logoSrc && (
            <img src={logoSrc} width={48} height={48} style={{ borderRadius: 8 }} />
          )}
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontWeight: 700,
              color: OG.text,
            }}
          >
            Shorted
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 22, color: OG.textDim }}>
          {footer}
        </div>
      </div>
    </div>
  );
}

/**
 * Head-to-head variant: two subjects either side of a divider.
 *
 * Kept in this module rather than hand-rolled at the call site so the VS card
 * inherits the same canvas, rule and footer as every other card — the exact
 * drift that produced a white root card and black everything-else.
 */
export interface OgVersusProps {
  eyebrow: string;
  left: { code: string; name?: string; value: string; caption: string };
  right: { code: string; name?: string; value: string; caption: string };
  footer?: string;
  logoSrc: string;
}

function VersusSide({
  side,
}: {
  side: { code: string; name?: string; value: string; caption: string };
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 54,
          fontWeight: 700,
          color: OG.text,
          fontFamily: OG_SERIF,
        }}
      >
        {side.code}
      </div>
      {side.name && (
        <div
          style={{
            display: "flex",
            marginTop: 4,
            fontSize: 22,
            color: OG.textDim,
            maxWidth: 420,
          }}
        >
          {side.name}
        </div>
      )}
      <div
        style={{
          display: "flex",
          marginTop: 22,
          fontSize: 78,
          fontWeight: 700,
          color: OG.orange,
        }}
      >
        {side.value}
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 6,
          fontSize: 20,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: OG.textDim,
        }}
      >
        {side.caption}
      </div>
    </div>
  );
}

export function OgVersus({
  eyebrow,
  left,
  right,
  footer = "shorted.com.au",
  logoSrc,
}: OgVersusProps) {
  return (
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
        {eyebrow}
      </div>

      <div
        style={{
          display: "flex",
          marginTop: 48,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <VersusSide side={left} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "0 28px",
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 34,
              fontWeight: 700,
              color: OG.textDim,
              fontFamily: OG_SERIF,
            }}
          >
            vs
          </div>
        </div>
        <VersusSide side={right} />
      </div>

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
          {logoSrc && (
            <img src={logoSrc} width={48} height={48} style={{ borderRadius: 8 }} />
          )}
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontWeight: 700,
              color: OG.text,
            }}
          >
            Shorted
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 22, color: OG.textDim }}>
          {footer}
        </div>
      </div>
    </div>
  );
}
