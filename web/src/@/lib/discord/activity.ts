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
