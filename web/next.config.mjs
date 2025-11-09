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
const config = {
  output: "standalone", // Enable standalone mode for Docker
  webpack: (config) => {
    config.resolve.fallback = {
      fs: false,
      net: false,
      dns: false,
      child_process: false,
      tls: false,
    };
    return config;
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
    optimizeFonts: false, // Disable font optimization to avoid network requests during build
    experimental: {
      serverComponentsExternalPackages: ["@bufbuild/protobuf"],
      optimizePackageImports: [
        "@radix-ui/react-icons",
        "lucide-react",
        "@visx/axis",
        "@visx/brush",
        "@visx/group",
        "@visx/hierarchy",
        "@visx/scale",
        "@visx/shape",
      ],
    },
    images: {
      ...config.images,
      domains: [
        "localhost",
        "shorted.com.au",
        "storage.googleapis.com",
        "lh3.googleusercontent.com",
      ],
    },
  }),
);
