import { NextResponse } from "next/server";

// The build identity comes from next.config.mjs through `env`
// (src/config/build-identity.mjs). Next replaces each `process.env.NAME` read
// below with its value when the artifact is built, so a runtime environment
// change cannot make an old build report a newer release. Keep every read a
// literal `process.env.NAME`: a dynamic lookup is not inlined.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      version: process.env.SHORTED_BUILD_VERSION ?? "dev",
      buildDate: process.env.SHORTED_BUILD_DATE ?? new Date().toISOString(),
      gitCommit: process.env.SHORTED_BUILD_COMMIT ?? "local",
      gitCommitFull: process.env.NEXT_PUBLIC_RELEASE_COMMIT ?? "local",
      gitBranch: process.env.SHORTED_BUILD_BRANCH ?? "local",
      environment: process.env.SHORTED_BUILD_ENVIRONMENT ?? "development",
      uptime: process.uptime(),
      nodeVersion: process.version,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
