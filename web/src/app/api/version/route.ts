import { NextResponse } from "next/server";
import getConfig from "next/config";

interface RuntimeConfig {
  version?: string;
  buildDate?: string;
  gitCommit?: string;
  gitBranch?: string;
  environment?: string;
}

export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { publicRuntimeConfig }: { publicRuntimeConfig: RuntimeConfig } =
    getConfig();

  return NextResponse.json({
    version: publicRuntimeConfig?.version ?? "dev",
    buildDate: publicRuntimeConfig?.buildDate ?? new Date().toISOString(),
    gitCommit: publicRuntimeConfig?.gitCommit ?? "local",
    gitBranch: publicRuntimeConfig?.gitBranch ?? "local",
    environment: publicRuntimeConfig?.environment ?? "development",
    uptime: process.uptime(),
    nodeVersion: process.version,
  });
}

