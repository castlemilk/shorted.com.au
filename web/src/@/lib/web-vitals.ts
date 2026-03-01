/**
 * Web Vitals monitoring — reports LCP, INP, CLS, FCP, TTFB to Google Analytics 4.
 * Import and call reportWebVitals() once from the root layout or a client component.
 */

type MetricName = "CLS" | "FCP" | "INP" | "LCP" | "TTFB";

interface WebVitalMetric {
  name: MetricName;
  value: number;
  rating: "good" | "needs-improvement" | "poor";
  id: string;
  delta: number;
}

function sendToGA4(metric: WebVitalMetric) {
  // gtag must be available (loaded via Google Analytics script)
  if (typeof window === "undefined") return;
  const gtag = (window as unknown as Record<string, unknown>).gtag as
    | ((...args: unknown[]) => void)
    | undefined;
  if (!gtag) return;

  gtag("event", metric.name, {
    event_category: "Web Vitals",
    event_label: metric.id,
    value: Math.round(metric.name === "CLS" ? metric.delta * 1000 : metric.delta),
    non_interaction: true,
    metric_rating: metric.rating,
  });
}

export async function reportWebVitals() {
  if (typeof window === "undefined") return;

  try {
    const { onCLS, onINP, onLCP, onFCP, onTTFB } = await import("web-vitals");

    onCLS(sendToGA4);
    onINP(sendToGA4);
    onLCP(sendToGA4);
    onFCP(sendToGA4);
    onTTFB(sendToGA4);
  } catch {
    // web-vitals not available — skip silently
  }
}
