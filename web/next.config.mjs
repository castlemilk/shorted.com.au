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

const config = {
  output: "standalone", // Enable standalone mode for Docker
  // Proxy Connect-RPC and backend API requests to avoid CORS issues.
  // Client-side code uses relative URLs; Next.js rewrites proxy them to the backend.
  async rewrites() {
    return [
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
    experimental: {
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
      minimumCacheTTL: 60,
    },
  }),
);
// Force rebuild Wed Feb  4 20:36:09 AEDT 2026
