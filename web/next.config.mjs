// @ts-nocheck
/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

import packageJson from "./package.json" with { type: "json" };
import { execSync } from "child_process";

// Get version from git if available, fallback to package.json
let version = packageJson.version;
try {
  const gitVersion = execSync("git describe --tags --always --dirty", {
    encoding: "utf8",
  }).trim();
  version = gitVersion;
} catch (e) {
  console.warn("Git not available, using package.json version:", version);
}

// Bundle analyzer configuration (optional - only if installed)
// Install with: npm install --save-dev @next/bundle-analyzer
/**@type {(config: import("next").NextConfig) => import("next").NextConfig} */
let withBundleAnalyzer = (config) => config;
if (process.env.ANALYZE === "true") {
  try {
    const analyzer = await import("@next/bundle-analyzer");
    withBundleAnalyzer = analyzer.default({ enabled: true });
  } catch (e) {
    console.warn("Bundle analyzer not installed, skipping...");
  }
}
/** @type {import("next").NextConfig} */
const shortsApiUrl =
  process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:9091";

const chatApiUrl =
  process.env.NEXT_PUBLIC_CHAT_SERVICE_ENDPOINT ??
  "http://localhost:8080";

const config = {
  output: "standalone", // Enable standalone mode for Docker
  poweredByHeader: false,
  // Proxy Connect-RPC and backend API requests to avoid CORS issues.
  // Client-side code uses relative URLs; Next.js rewrites proxy them to the backend.
  async headers() {
    return [
      {
        // RFC 8288 Link headers for agent discovery (api-catalog per RFC 9727)
        source: "/",
        headers: [
          {
            key: "Link",
            value:
              '</.well-known/api-catalog>; rel="api-catalog", </openapi.json>; rel="service-desc"; type="application/json", </docs/api>; rel="service-doc"',
          },
        ],
      },
      {
        // HSTS for every path. All subdomains (api, www) are HTTPS via
        // Cloudflare; preload directive included but hstspreload.org
        // submission is a separate manual step.
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // Enforced Content-Security-Policy.
        //
        // Scoped to everything EXCEPT /embed/* via negative lookahead: embed
        // routes need `frame-ancestors *` to be iframe-embeddable, and emitting
        // a second CSP header there (the browser intersects multiple CSPs) with
        // a global `frame-ancestors 'self'` would silently break embedding.
        //
        // 'unsafe-inline' / 'unsafe-eval' are required by Next.js hydration and
        // GTM. `frame-src` allowlists the Firebase Auth handler iframe used by
        // signInWithPopup (authDomain *.firebaseapp.com) and Google accounts —
        // without it, Google sign-in breaks. `connect-src https:` covers the
        // Connect-RPC API, Firebase, Algolia and Upstash (proxied via API routes).
        // Promoted from Content-Security-Policy-Report-Only after auditing every
        // external origin the app loads (Feb–Jun 2026).
        source: "/((?!embed).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.googletagmanager.com https://*.google-analytics.com https://va.vercel-scripts.com https://*.cloudflareinsights.com https://apis.google.com https://accounts.google.com https://www.gstatic.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data: https://fonts.gstatic.com",
              "connect-src 'self' https:",
              "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com https://*.google.com",
              "frame-ancestors 'self'",
              "object-src 'none'",
              "base-uri 'self'",
            ].join("; "),
          },
        ],
      },
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/fonts/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/images/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        source: "/assets/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, stale-while-revalidate=604800",
          },
        ],
      },
      {
        // Security headers for all routes
        source: "/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          {
            // Legacy header — a no-op on modern browsers (which dropped the XSS
            // auditor) but still graded by scanners; harmless and the safe value
            // for the older browsers that honour it.
            key: "X-XSS-Protection",
            value: "1; mode=block",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      {
        // Allow embedding of /embed/* routes in iframes (overrides SAMEORIGIN
        // above). These routes are excluded from the global enforced CSP, so
        // they carry their own full policy here — identical hardening but with
        // `frame-ancestors *` so the chart widgets are embeddable anywhere.
        source: "/embed/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "ALLOWALL",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.googletagmanager.com https://*.google-analytics.com https://va.vercel-scripts.com https://*.cloudflareinsights.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data: https://fonts.gstatic.com",
              "connect-src 'self' https:",
              "frame-ancestors *",
              "object-src 'none'",
              "base-uri 'self'",
            ].join("; "),
          },
          {
            key: "Cache-Control",
            value: "public, s-maxage=300, stale-while-revalidate=600",
          },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        // RFC 9727 API catalog — app router can't host dot-prefixed paths
        source: "/.well-known/api-catalog",
        destination: "/api/agent/api-catalog",
      },
      {
        // MCP server card (SEP-1649) for agent discovery
        source: "/.well-known/mcp/server-card.json",
        destination: "/api/agent/mcp-server-card",
      },
      {
        source: "/shorts.v1alpha1.ShortedStocksService/:path*",
        destination: `${shortsApiUrl}/shorts.v1alpha1.ShortedStocksService/:path*`,
      },
      {
        source: "/register.v1.RegisterService/:path*",
        destination: `${shortsApiUrl}/register.v1.RegisterService/:path*`,
      },
      {
        source: "/api/stocks/:path*",
        destination: `${shortsApiUrl}/api/stocks/:path*`,
      },
      {
        source: "/chat.v1.ChatService/:path*",
        destination: `${chatApiUrl}/chat.v1.ChatService/:path*`,
      },
    ];
  },
  publicRuntimeConfig: {
    version,
    buildDate: new Date().toISOString(),
    gitCommit: process.env.VERCEL_GIT_COMMIT_SHA?.substring(0, 7) || 
               process.env.VERCEL_GIT_COMMIT_SHA || 
               "local",
    gitBranch: process.env.VERCEL_GIT_COMMIT_REF || "local",
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    shortsUrl: process.env.SHORTS_SERVICE_ENDPOINT ?? "http://localhost:9091",
  },
  // Optionally, add any other Next.js config below
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "storage.googleapis.com",
        port: "",
        pathname: "**",
      },
      {
        protocol: "https",
        hostname: "media.licdn.com",
        port: "",
        pathname: "**",
      },
    ],
  },
};

import nextMDX from "@next/mdx";
import rehypePrismPlus from "rehype-prism-plus";
const withMDX = nextMDX({
  extension: /\.mdx|.md?$/,
  options: {
    rehypePlugins: [rehypePrismPlus],
  },
});

export default withBundleAnalyzer(
  withMDX({
    ...config,
    pageExtensions: ["js", "jsx", "mdx", "md", "ts", "tsx"],
    reactStrictMode: true,
    staticPageGenerationTimeout: 180,
    experimental: {
      instrumentationHook: true,
      // Externalize protobuf and connect packages to prevent SSR bundling issues
      serverComponentsExternalPackages: [
        "@bufbuild/protobuf",
        "@connectrpc/connect",
        "@connectrpc/connect-web",
        "firebase-admin",
      ],
      optimizePackageImports: [
        "@radix-ui/react-icons",
        "lucide-react",
        "@visx/axis",
        "@visx/brush",
        "@visx/group",
        "@visx/hierarchy",
        "@visx/scale",
        "@visx/shape",
        "@visx/tooltip",
        "@visx/pattern",
        "@visx/gradient",
        "@visx/event",
        "@visx/vendor",
        "@visx/curve",
        "@visx/responsive",
      ],
    },
    // Optimize bundle splitting
    webpack: (config, { isServer }) => {
      // Existing webpack config for fallbacks
      config.resolve.fallback = {
        fs: false,
        net: false,
        dns: false,
        child_process: false,
        tls: false,
      };

      return config;
    },
    images: {
      ...config.images,
      remotePatterns: [
        {
          protocol: "https",
          hostname: "storage.googleapis.com",
        },
        {
          protocol: "https",
          hostname: "lh3.googleusercontent.com",
        },
        {
          protocol: "https",
          hostname: "shorted.com.au",
        },
        {
          protocol: "http",
          hostname: "localhost",
          port: "3020",
        },
      ],
      formats: ["image/avif", "image/webp"],
      deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
      imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
      minimumCacheTTL: 86400, // 24 hours — company logos from GCS are essentially static
    },
  }),
);
// Force rebuild Wed Feb  4 20:36:09 AEDT 2026
