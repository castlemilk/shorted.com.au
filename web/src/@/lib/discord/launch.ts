import { getCached, setCached } from "~/@/lib/kv-cache";
import type { ChartState } from "./custom-id";

/**
 * The hand-off from a command to the Activity it opens.
 *
 * A button can tell the Activity which chart it launched (Discord passes the
 * button's custom_id to the Activity's URL); a slash command cannot, because
 * a command has no custom_id. So in interactive mode the bot writes the chart
 * here, keyed by channel, just before it launches the Activity, and the
 * Activity reads it back when it loads (api/discord/activity/launch).
 *
 * Keyed by channel because that is what the Activity knows before anyone signs
 * in: Discord puts `channel_id` in its URL. Everyone in a channel shares one
 * Activity instance, so whoever joins within the two minutes opens the chart
 * the last command asked for, which is the chart being talked about.
 */

export const LAUNCH_TTL_S = 120;

const key = (channelId: string) => `discord:launch:${channelId}`;

export async function rememberLaunch(
  channelId: string,
  state: ChartState,
): Promise<void> {
  await setCached(key(channelId), state, LAUNCH_TTL_S);
}

export async function recallLaunch(
  channelId: string,
): Promise<ChartState | null> {
  return getCached<ChartState>(key(channelId));
}
