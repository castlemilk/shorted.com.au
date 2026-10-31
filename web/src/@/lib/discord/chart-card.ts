import type { ChartState } from "./custom-id";

/** Each of the card's reads gets this long; the render's own budget is handler.ts's. */
const READ_TIMEOUT_MS = 5000;

/**
 * A chart message's card as PNG bytes, drawn here and uploaded with the
 * message (docs/discord-bot.md, "The chart image").
 *
 * The card used to be an image URL for Discord's media proxy to fetch. Every
 * button press names a new URL, the proxy fetched it cold (1.5 to 5s to
 * render, measured 2026-10-31) through Cloudflare's bot checks, and a slow or
 * refused fetch left the chart blank or stale, which the proxy then kept for
 * that URL. An attachment arrives with the edit itself.
 *
 * Null when the card cannot be drawn whole (a read failed or timed out, or
 * the render threw): the message then carries the card's URL, as before,
 * rather than a chart missing a series. The renderer is imported on demand,
 * so satori and resvg stay out of the endpoint's cold start, which counts
 * against Discord's three seconds.
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
