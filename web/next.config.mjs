/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

import packageJson from "./package.json" with { type: "json" };

const { version } = packageJson;

// Bundle analyzer configuration (optional - only if installed)
// Install with: npm install --save-dev @next/bundle-analyzer
// @ts-ignore - Bundle analyzer is optional dependency
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
const withBundleAnalyzer =
  process.env.ANALYZE === "true"
    ? // @ts-ignore
      (
        await import("@next/bundle-analyzer").catch(() => ({
          default: (config) => config,
        }))
      ).default
    : (config) => config;

// @ts-expect-error - Bundle analyzer types are optional
withBundleAnalyzer({ enabled: process.env.ANALYZE === "true" });
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
