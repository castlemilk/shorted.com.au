type CloudflareWebAnalyticsProps = {
  enabled?: boolean;
  token?: string;
};

const CLOUDFLARE_WEB_ANALYTICS_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

function isManualCloudflareWebAnalyticsEnabled() {
  return process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_MANUAL_ENABLED === "1";
}

export function CloudflareWebAnalytics({
  enabled = isManualCloudflareWebAnalyticsEnabled(),
  token = process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN,
}: CloudflareWebAnalyticsProps) {
  if (!enabled) {
    return null;
  }

  const normalizedToken = token?.trim();
  if (!normalizedToken) {
    return null;
  }

  return (
    <script
      id="cloudflare-web-analytics"
      data-testid="cloudflare-web-analytics"
      defer
      src={CLOUDFLARE_WEB_ANALYTICS_SRC}
      data-cf-beacon={JSON.stringify({ token: normalizedToken })}
    />
  );
}
