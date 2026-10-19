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

/**
 * The chart to open: the one on the button that launched the Activity
 * (Discord passes the button's custom_id through), else `?code=&view=&period=`
 * as /embed/chart reads them, which is how the page is tried outside Discord.
 * Launched from the App Launcher there is neither, and it opens the embed's
 * default stock.
 */
export function activityLaunchState(params: ParamSource): ChartState {
  const parsed = parseCustomId(params.get("custom_id"));
  if (parsed?.kind === "activity" || parsed?.kind === "chart") {
    return parsed.state;
  }
  return parseEmbedChartParams(params);
}

/**
 * Discord serves an Activity from `<client_id>.discordsays.com`, so the page
 * knows its application without any configuration.
 */
export function discordClientIdFromHost(hostname: string): string | null {
  const match = /^(\d{15,22})\.discordsays\.com$/.exec(hostname);
  return match?.[1] ?? null;
}
