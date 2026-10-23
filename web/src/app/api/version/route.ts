import { NextResponse } from "next/server";
import getConfig from "next/config";

interface RuntimeConfig {
  version?: string;
  buildDate?: string;
  gitCommit?: string;
  gitBranch?: string;
  environment?: string;
}

export const dynamic = "force-dynamic";

export async function GET() {
  // next/config can be unavailable in the App Router's standalone runtime.
  const config = getConfig() as
    | { publicRuntimeConfig?: RuntimeConfig }
    | undefined;
  const publicRuntimeConfig = config?.publicRuntimeConfig;

  return NextResponse.json(
    {
      version: publicRuntimeConfig?.version ?? "dev",
      buildDate: publicRuntimeConfig?.buildDate ?? new Date().toISOString(),
      gitCommit: publicRuntimeConfig?.gitCommit ?? "local",
      gitCommitFull: process.env.NEXT_PUBLIC_RELEASE_COMMIT ?? "local",
      gitBranch: publicRuntimeConfig?.gitBranch ?? "local",
      environment: publicRuntimeConfig?.environment ?? "development",
      uptime: process.uptime(),
      nodeVersion: process.version,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
