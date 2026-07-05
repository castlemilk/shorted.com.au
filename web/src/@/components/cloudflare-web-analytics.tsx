import Script from "next/script";

type CloudflareWebAnalyticsProps = {
  token?: string;
};

const CLOUDFLARE_WEB_ANALYTICS_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

export function CloudflareWebAnalytics({
  token = process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN,
}: CloudflareWebAnalyticsProps) {
  const normalizedToken = token?.trim();
  if (!normalizedToken) {
    return null;
  }

  return (
    <Script
      id="cloudflare-web-analytics"
      data-testid="cloudflare-web-analytics"
      src={CLOUDFLARE_WEB_ANALYTICS_SRC}
      strategy="afterInteractive"
      data-cf-beacon={JSON.stringify({ token: normalizedToken, spa: true })}
    />
  );
}
