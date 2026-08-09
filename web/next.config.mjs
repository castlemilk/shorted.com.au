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
const normalizeApiBaseUrl = (value) => {
  const compact = value?.trim().replace(/\s+/g, "");
  if (!compact) return undefined;
  return compact.replace(/\/+$/, "");
};

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const normalized = normalizeApiBaseUrl(value);
    if (normalized) return normalized;
  }
  return undefined;
};

// Browser rewrites should flow through the public API hostname so client-side
// reads hit the Cloudflare Worker cache. Server actions use direct origins via
// src/app/actions/config.ts.
const shortsApiUrl =
  firstNonEmpty(
    process.env.NEXT_PUBLIC_API_URL,
    process.env.SHORTS_API_URL,
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT,
    process.env.SHORTS_SERVICE_ENDPOINT,
  ) ?? "http://localhost:9091";
const edgeApiUrl =
  firstNonEmpty(
    process.env.NEXT_PUBLIC_EDGE_API_URL,
    process.env.SHORTED_EDGE_API_URL,
    process.env.SHORTS_EDGE_API_URL,
  ) ?? "https://api.shorted.com.au";
// Firebase auth-helper origin for the same-origin sign-in popup. When
// NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN is set to shorted.com.au, the SDK loads
// /__/auth/* from OUR domain and this rewrite proxies it to the real helper
// on <project>.firebaseapp.com — removing the cross-origin iframe handshake
// (~0.5-2s) from signInWithPopup. Inert until the env var is flipped.
// Prereqs before flipping: shorted.com.au in Firebase authorized domains AND
// https://shorted.com.au/__/auth/handler added to the OAuth client's
// redirect URIs.
const firebaseAuthHelperOrigin = `https://${
  (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "rosy-clover-477102-t5")
    .trim()
    .replace(/\s+/g, "")
}.firebaseapp.com`;

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
            // Prod chunks are content-hashed → safe to cache immutably forever.
            // Dev chunks have STABLE names, so `immutable` makes the browser pin
            // stale chunks for a year (breaks HMR/refresh) — never cache in dev.
            value:
              process.env.NODE_ENV === "production"
                ? "public, max-age=31536000, immutable"
                : "no-store, must-revalidate",
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
        source: "/geo/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800",
          },
        ],
      },
      {
        source: "/housing-icons/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
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
            // NOTE: third-party framing is granted by `frame-ancestors *` in
            // the CSP below, NOT by this header. "ALLOWALL" is not a valid
            // X-Frame-Options token and every browser ignores it; it is kept
            // only so this route does not inherit the global SAMEORIGIN (a
            // more specific Next header rule REPLACES the global one for the
            // same key rather than appending, so exactly one XFO is served).
            // Verified 2026-07-28 by framing /embed/chart from example.com.
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
  async redirects() {
    return [
      { source: "/housing/suburbs", destination: "/housing", permanent: true },
      {
        source: "/short-squeeze",
        destination: "/battlegrounds",
        permanent: true,
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
        source: "/edge/v1/:path*",
        destination: `${edgeApiUrl}/edge/v1/:path*`,
      },
      {
        // Same-origin Firebase auth helper (see firebaseAuthHelperOrigin).
        source: "/__/auth/:path*",
        destination: `${firebaseAuthHelperOrigin}/__/auth/:path*`,
      },
      {
        // The auth helper fetches its own SDK config from /__/firebase/.
        source: "/__/firebase/:path*",
        destination: `${firebaseAuthHelperOrigin}/__/firebase/:path*`,
      },
      {
        // Every shorts.v1alpha1 service — the legacy ShortedStocksService and
        // the per-domain services (MarketService, HousingService, ...) from
        // the shorts.proto split. One regex-constrained param instead of a
        // hand-maintained service list: new domain services proxy without
        // touching this file.
        source: "/:service(shorts\\.v1alpha1\\.[A-Za-z]+Service)/:path*",
        destination: `${shortsApiUrl}/:service/:path*`,
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
        source: "/api/algolia/:path*",
        destination: `${shortsApiUrl}/api/algolia/:path*`,
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
    shortsUrl: shortsApiUrl,
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
      // The sitemap (force-dynamic) and feed (ISR regeneration) read
      // web/_blogs from the filesystem AT REQUEST TIME in the lambda —
      // readdirSync isn't statically traced, so without this the directory
      // is missing from the serverless bundle and the routes 500 with
      // ENOENT /var/task/web/_blogs.
      outputFileTracingIncludes: {
        "/sitemap.xml": ["./_blogs/**/*"],
        "/feed.xml": ["./_blogs/**/*"],
        // OG card assets. The scene JPEGs and the state-boundary topojson are
        // read with readFileSync at REQUEST time inside opengraph-image
        // lambdas, and nft does not trace those reads — measured on prod
        // 2026-08-09: the suburb card had shipped scene-less since it landed,
        // and the state silhouettes fell back to plain cards. Inline-literal
        // paths did NOT fix it (tried); these explicit includes are the same
        // mechanism the sitemap/feed routes above rely on.
        "/housing/opengraph-image": ["./public/housing-banners/og/**/*"],
        "/housing/[state]/[suburb]/opengraph-image": [
          "./public/housing-banners/og/**/*",
        ],
        "/housing/[state]/opengraph-image": ["./public/geo/states.topojson"],
        "/economy/[state]/opengraph-image": ["./public/geo/states.topojson"],
      },
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
        // News publisher CDNs — lets NewsCard thumbnails flow through the
        // /_next/image optimizer (resized AVIF/WebP) instead of shipping the
        // publisher's full-size JPEG. KEEP IN SYNC with OPTIMIZED_HOSTS in
        // src/@/components/news/news-image.tsx (unlisted hosts fall back to a
        // plain <img>, so drift degrades quality, it never crashes).
        { protocol: "https", hostname: "stockhead.com.au" },
        { protocol: "https", hostname: "www.stockhead.com.au" },
        { protocol: "https", hostname: "smallcaps.com.au" },
        { protocol: "https", hostname: "www.smallcaps.com.au" },
        { protocol: "https", hostname: "fool.com.au" },
        { protocol: "https", hostname: "www.fool.com.au" },
        { protocol: "https", hostname: "kalkinemedia.com" },
        { protocol: "https", hostname: "www.kalkinemedia.com" },
        // Wikimedia Commons — the ONLY host `politicians.photo_url` holds
        // (measured: 241/241 non-empty URLs). Portraits are served into 32-96px
        // avatar boxes and Commons ships 300-500px PNG/JPEG originals, so
        // routing them through the optimizer is the single biggest transfer win
        // on /politicians. KEEP IN SYNC with OPTIMIZED_PORTRAIT_HOSTS in
        // src/@/components/politicians/politician-avatar.tsx — an unlisted host
        // there falls back to a plain <img>, so drift degrades, never crashes.
        { protocol: "https", hostname: "upload.wikimedia.org" },
      ],
      formats: ["image/avif", "image/webp"],
      deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
      imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
      minimumCacheTTL: 86400, // 24 hours — company logos from GCS are essentially static
    },
  }),
);
// Force rebuild Wed Feb  4 20:36:09 AEDT 2026
