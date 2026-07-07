const bypassSecretEnvNames = [
  "CLOUDFLARE_TESTING_BYPASS_SECRET",
  "SHORTED_CLOUDFLARE_TESTING_BYPASS_SECRET",
  "TF_VAR_rate_limit_testing_bypass_secret",
] as const;

export const cloudflareTestingBypassHeaderName = "X-Shorted-Testing-Bypass";
export const cloudflareTestingUserAgentMarker = "Shorted-E2E/1.0";
export const cloudflareTestingDefaultUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  `Chrome/131.0.0.0 Safari/537.36 ${cloudflareTestingUserAgentMarker}`;

export function getCloudflareTestingBypassSecret(): string {
  for (const envName of bypassSecretEnvNames) {
    const value = process.env[envName]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

export function cloudflareTestingBypassHeaders(
  options: { includeUserAgent?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (options.includeUserAgent) {
    headers["User-Agent"] = cloudflareTestingDefaultUserAgent;
  }

  const secret = getCloudflareTestingBypassSecret();
  if (secret) {
    headers[cloudflareTestingBypassHeaderName] = secret;
  }

  return headers;
}

export function withCloudflareTestingUserAgent(userAgent?: string): string {
  if (!getCloudflareTestingBypassSecret()) {
    return userAgent?.trim() || cloudflareTestingDefaultUserAgent;
  }

  const baseUserAgent = userAgent?.trim() || cloudflareTestingDefaultUserAgent;
  if (baseUserAgent.includes("Shorted-E2E")) {
    return baseUserAgent;
  }
  return `${baseUserAgent} ${cloudflareTestingUserAgentMarker}`;
}
