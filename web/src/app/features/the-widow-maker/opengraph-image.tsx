import { ImageResponse } from "next/og";

export const alt =
  "The Widow-Maker — why betting against Australian housing keeps failing";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Social card for the housing feature. Terminal-black canvas, amber bloom and
 * rule, serif display title — mirrors the on-page hero. Self-contained (system
 * fonts only) so it never fails on a missing webfont in CI.
 */
export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0C0C0C",
          backgroundImage:
            "radial-gradient(900px 520px at 50% -10%, rgba(255,169,77,0.18), transparent)",
          padding: "64px 72px",
          color: "#E8DDB5",
          fontFamily: "Georgia, serif",
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
          Shorted · Investigation
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 116, lineHeight: 0.98, fontWeight: 600, color: "#F3EAC8" }}>
            The Widow-Maker
          </div>
          <div style={{ fontSize: 34, lineHeight: 1.25, color: "#B7A98A", maxWidth: 980 }}>
            Why betting against Australian housing keeps failing — negative
            gearing, the banks, and what Japan &amp; China teach.
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
          <span>Record A$11bn short · CBA −10.4% · 4 live dashboards</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
