import {
  SHORTED_SSR_BYPASS_HEADER,
  SHORTED_SSR_USER_AGENT,
} from "~/app/actions/config";
import { DISCORD_PERIODS, DISCORD_VIEWS } from "./commands";
import type { ChartState } from "./custom-id";
import { chartCardUrl } from "./messages";

/**
 * A chart message's card as PNG bytes, uploaded with the message
 * (docs/discord-bot.md, "The chart image").
 *
 * The card used to be an image URL for Discord's media proxy to fetch. Every
 * button press names a new URL, the proxy fetched it cold (1.5 to 5s to
 * render, measured 2026-10-31) through Cloudflare's bot checks, and a slow or
 * refused fetch left the chart blank or stale, which the proxy then kept for
 * that URL. An attachment arrives with the edit itself.
 *
 * The bytes come from the share card's own route, `/chart/<CODE>/image`, at
 * the same `v=<day>` URL a message would otherwise carry, so the CDN caches
 * them: a period or view seen once today comes back in ~70ms, and the render
 * runs in that route's function, not in the one that must answer Discord
 * within three seconds (an in-process render blocked it for a second or more,
 * so a second press during one could miss Discord's window). The request
 * carries the first-party SSR bypass, which the zone's skip rule matches on
 * this host too, so Cloudflare's bot checks let it through.
 *
 * Without the bypass secret, or when the route fails or answers a partial card
 * (a read timed out), the card is drawn here instead, from the same loader.
 * Null when neither gives a whole card: the message then carries the URL.
 */

const FETCH_TIMEOUT_MS = 6000;
/** A neighbour can render cold; nothing waits on it. */
const WARM_TIMEOUT_MS = 12_000;
const WARM_CONCURRENCY = 2;
/** Each of an in-process render's reads gets this long. */
const READ_TIMEOUT_MS = 5000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * What carries the request through Cloudflare's bot checks on our own host:
 * the SSR marker and its secret (CLAUDE.md, "Cloudflare SSR Bypass"). Null
 * without the secret, when the request would only be challenged.
 */
function firstPartyHeaders(): Record<string, string> | null {
  const secret = process.env.SHORTED_SSR_BYPASS_SECRET?.trim();
  return secret
    ? {
        "User-Agent": SHORTED_SSR_USER_AGENT,
        [SHORTED_SSR_BYPASS_HEADER]: secret,
      }
    : null;
}

/** The route's card, or null when it fails, times out or is partial. */
async function fetchCard(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const response = await fetch(url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("image/png") ||
    response.headers.get("x-chart-card") === "partial"
  ) {
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return isPng(bytes) ? bytes : null;
}

/**
 * The card drawn in this process. satori and resvg are imported on demand,
 * so they stay out of the endpoint's cold start.
 */
export async function renderChartCard(
  state: ChartState,
): Promise<Uint8Array | null> {
  try {
    const [{ ImageResponse }, { loadChartCard }, { OG_SIZE }] =
      await Promise.all([
        import("next/og"),
        import("~/app/chart/[code]/image/load-card"),
        import("~/@/lib/og/card"),
      ]);
    const { card, complete } = await loadChartCard(state, READ_TIMEOUT_MS);
    if (!complete) return null;
    const response = new ImageResponse(card, OG_SIZE);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    console.error(`[discord] chart card for ${state.code} failed:`, error);
    return null;
  }
}

/** The card for a chart message: the route's cached card, else drawn here. */
export async function chartCard(
  state: ChartState,
  now: Date,
): Promise<Uint8Array | null> {
  const headers = firstPartyHeaders();
  if (headers) {
    try {
      const fetched = await fetchCard(
        chartCardUrl(state, now),
        headers,
        FETCH_TIMEOUT_MS,
      );
      if (fetched) return fetched;
    } catch (error) {
      console.error(
        `[discord] chart card fetch for ${state.code} failed:`,
        error,
      );
    }
  }
  return renderChartCard(state);
}

/** The charts one press away: the other periods, and the other views. */
export function neighbours(state: ChartState): ChartState[] {
  return [
    ...DISCORD_PERIODS.filter((p) => p.id !== state.period).map((p) => ({
      ...state,
      period: p.id,
    })),
    ...DISCORD_VIEWS.filter((v) => v.id !== state.view).map((v) => ({
      ...state,
      view: v.id,
    })),
  ];
}

/**
 * Has the CDN draw the charts one press away from a message, so the first
 * press on each finds its card cached. Best effort and in the background:
 * nothing waits on it, and a failure costs only that press's speed.
 */
export async function warmChartCards(
  state: ChartState,
  now: Date,
): Promise<void> {
  const headers = firstPartyHeaders();
  if (!headers) return;
  const queue = neighbours(state).map((s) => chartCardUrl(s, now));
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      await fetchCard(url, headers, WARM_TIMEOUT_MS).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker));
}
