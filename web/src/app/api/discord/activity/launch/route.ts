import { NextResponse, type NextRequest } from "next/server";

import { DEFAULT_EMBED_CODE } from "~/app/embed/chart/params";
import type { LaunchAnswer } from "~/@/lib/discord/activity";
import { recallLaunch } from "~/@/lib/discord/launch";
import { isSnowflake, resolveSettings } from "~/@/lib/discord/settings";
import { firestoreSettingsStore } from "~/@/lib/discord/settings-store";

/**
 * Which chart the Activity opens when no button said (docs/discord-bot.md,
 * "Settings"). The Activity asks once, as it loads, with the channel and
 * server Discord put in its URL:
 *
 *   1. the chart a command just asked for in this channel, in interactive
 *      mode (launch.ts), else
 *   2. the server's default stock, chart and period (settings.ts), else
 *   3. nothing, and the Activity opens its own default.
 *
 * Neither is secret: a server's defaults are what its members see in every
 * chart, and a hand-off is the chart a command posted to the channel. Reads
 * go through the settings cache, so a busy server costs one read a minute.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const channel = params.get("channel");
  const guild = params.get("guild");

  if (isSnowflake(channel)) {
    const state = await recallLaunch(channel).catch(() => null);
    if (state) {
      return NextResponse.json(
        { source: "command", state } satisfies LaunchAnswer,
        { headers: NO_STORE },
      );
    }
  }

  if (isSnowflake(guild)) {
    const stored = await firestoreSettingsStore.get({
      kind: "guild",
      id: guild,
    });
    if (stored) {
      const settings = resolveSettings(stored);
      return NextResponse.json(
        {
          source: "server",
          state: {
            code: settings.code ?? DEFAULT_EMBED_CODE,
            view: settings.view,
            period: settings.period,
          },
        } satisfies LaunchAnswer,
        { headers: NO_STORE },
      );
    }
  }

  return NextResponse.json(
    { source: "none", state: null } satisfies LaunchAnswer,
    {
      headers: NO_STORE,
    },
  );
}
