/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

import packageInfo from "./package.json" assert { type: "json" };

const { version } = packageInfo;
/** @type {import("next").NextConfig} */
const config = {
  publicRuntimeConfig: {
    version,
    shortsUrl: process.env.SHORTS_SERVICE_ENDPOINT ?? "http://localhost:8080",
  },
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


export default config
