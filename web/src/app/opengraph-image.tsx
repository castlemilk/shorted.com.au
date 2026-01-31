import { ImageResponse } from "next/og";

export const alt = "Shorted - Official ASIC Short Position Data for ASX Stocks";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0C0C0C",
          backgroundImage:
            "radial-gradient(circle at 25% 25%, #1a1a1a 0%, transparent 50%), radial-gradient(circle at 75% 75%, #1a1a1a 0%, transparent 50%)",
        }}
      >
        {/* Logo and brand */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 40,
          }}
        >
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: 16,
              background: "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginRight: 24,
              fontSize: 48,
              color: "white",
            }}
          >
            S
          </div>
          <span
            style={{
              fontSize: 72,
              fontWeight: 700,
              color: "#ffffff",
              letterSpacing: "-0.02em",
            }}
          >
            Shorted
          </span>
        </div>

        {/* Tagline */}
        <div
          style={{
            fontSize: 36,
            color: "#a1a1aa",
            textAlign: "center",
            maxWidth: 900,
            lineHeight: 1.4,
          }}
        >
          Official ASIC Short Position Data
        </div>

        {/* Data source badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: 16,
            padding: "8px 20px",
            borderRadius: 8,
            backgroundColor: "rgba(249, 115, 22, 0.1)",
            border: "1px solid rgba(249, 115, 22, 0.3)",
          }}
        >
          <span style={{ fontSize: 18, color: "#f97316" }}>
            T+4 Delayed Data from ASIC
          </span>
        </div>

        {/* Features */}
        <div
          style={{
            display: "flex",
            gap: 40,
            marginTop: 48,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontSize: 24,
              color: "#71717a",
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: "#f97316",
              }}
            />
            Official ASIC Data
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontSize: 24,
              color: "#71717a",
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: "#f97316",
              }}
            />
            Interactive Charts
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontSize: 24,
              color: "#71717a",
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: "#f97316",
              }}
            />
            Industry Heatmaps
          </div>
        </div>

        {/* URL */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            fontSize: 24,
            color: "#52525b",
          }}
        >
          shorted.com.au
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
