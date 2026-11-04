import { siteConfig } from "~/@/config/site";
import { chartShareUrl } from "~/@/lib/embed/snippet";
import { parseEmbedChartParams } from "~/app/embed/chart/params";
import { parseCustomId, type ChartState } from "./custom-id";

/**
 * The Discord Activity's launch, read from its URL. Pure and browser-safe:
 * the Activity page runs client-side only.
 */

interface ParamSource {
  get(name: string): string | null;
}

/** Discord launched this page (as opposed to someone opening it directly). */
export function isDiscordLaunch(params: ParamSource): boolean {
  return Boolean(params.get("frame_id") && params.get("instance_id"));
}

/** What api/discord/activity/launch answers. */
export type LaunchAnswer =
  | { source: "command" | "server"; state: ChartState }
  | { source: "none"; state: null };

export interface ActivityLaunch {
  state: ChartState;
  /**
   * Where `state` came from: the button that launched the Activity (Discord
   * passes its custom_id through), the page's own query (`?code=`, as the
   * page is tried outside Discord), or nothing, which leaves the embed's
   * defaults until the server's settings say otherwise.
   */
  source: "button" | "query" | "default";
  /** The channel and server Discord launched it in (its URL carries both). */
  channelId: string | null;
  guildId: string | null;
}

/**
 * The chart to open, as far as the URL says. A launch from the App Launcher,
 * or from a command in interactive mode, says nothing (`source: "default"`):
 * the Activity then asks api/discord/activity/launch, which knows the
 * command's chart and the server's defaults.
 */
export function activityLaunchState(params: ParamSource): ActivityLaunch {
  const context = {
    channelId: params.get("channel_id"),
    guildId: params.get("guild_id"),
  };
  const parsed = parseCustomId(params.get("custom_id"));
  if (parsed?.kind === "activity" || parsed?.kind === "chart") {
    return { state: parsed.state, source: "button", ...context };
  }
  return {
    state: parseEmbedChartParams(params),
    source: params.get("code") ? "query" : "default",
    ...context,
  };
}

/**
 * Discord serves an Activity from `<client_id>.discordsays.com`, so the page
 * knows its application without any configuration.
 */
export function discordClientIdFromHost(hostname: string): string | null {
  const match = /^(\d{15,22})\.discordsays\.com$/.exec(hostname);
  return match?.[1] ?? null;
}

/**
 * The platform Discord launched the Activity on: "mobile" or "desktop". Null
 * outside a Discord launch, and for a value Discord does not send.
 */
export function discordPlatform(
  params: ParamSource,
): "mobile" | "desktop" | null {
  if (!isDiscordLaunch(params)) return null;
  const platform = params.get("platform");
  return platform === "mobile" || platform === "desktop" ? platform : null;
}

/**
 * Whether this page is running inside Discord: it is served from Discord's
 * proxy host, or it carries the launch parameters Discord adds to it. Anywhere
 * else a link opens in a plain tab, as it always did.
 */
export function inDiscordFrame(location: {
  hostname: string;
  search: string;
}): boolean {
  return (
    discordClientIdFromHost(location.hostname) !== null ||
    isDiscordLaunch(new URLSearchParams(location.search))
  );
}

/**
 * Where the Activity's "Sign in on Shorted" opens: the sign-in page, returning
 * to the chart's share page turned sideways, so the reader lands on the chart
 * they were reading. The callback is a relative path, which the sign-in page
 * follows on whatever origin it is opened from (safeAuthCallbackUrl checks a
 * callback against that origin).
 */
export function activitySignInUrl(state: ChartState): string {
  const share = new URL(
    chartShareUrl(state.code, state.view, state.period, state.anchor),
  );
  share.searchParams.set("landscape", "1");
  const callbackUrl = share.pathname + share.search;
  const query = new URLSearchParams({ callbackUrl }).toString();
  return `${siteConfig.url}/signin?${query}`;
}
