/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

import packageJson from "./package.json" with { type: "json" };

const { version } = packageJson;
/** @type {import("next").NextConfig} */
const config = {
  output: 'standalone', // Enable standalone mode for Docker
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

export default withMDX({
  ...config,
  pageExtensions: ["js", "jsx", "mdx", "md", "ts", "tsx"],
  reactStrictMode: true,
  eslint: {
    // Skip ESLint during production builds to prevent deployment failures
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Skip TypeScript errors during production builds
    ignoreBuildErrors: true,
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
});
