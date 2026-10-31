import { waitUntil } from "@vercel/functions";
import { NextResponse, type NextRequest } from "next/server";

import type { Interaction } from "~/@/lib/discord/api";
import { chartCard, warmChartCards } from "~/@/lib/discord/chart-card";
import {
  discordActivityEnabled,
  discordPublicKey,
} from "~/@/lib/discord/config";
import { discordData } from "~/@/lib/discord/data";
import { handleInteraction } from "~/@/lib/discord/handler";
import { rememberLaunch } from "~/@/lib/discord/launch";
import { discordRest } from "~/@/lib/discord/rest";
import {
  settingsLinkKey,
  settingsPageUrl,
  signSettingsGrant,
} from "~/@/lib/discord/settings-link";
import { firestoreSettingsStore } from "~/@/lib/discord/settings-store";
import { verifyDiscordRequest } from "~/@/lib/discord/verify";
import { recordProductEvent } from "~/@/lib/product-events";

/**
 * The Shorted Discord bot: Discord POSTs every slash command, autocomplete
 * keystroke and button press here (the developer portal's "Interactions
 * Endpoint URL"), signed with the application's key. Setup, commands and the
 * Activity: docs/discord-bot.md.
 *
 * Node, not Edge: signature verification uses node:crypto, and the replies
 * are built from the same server actions (and caches) as the stock pages.
 * maxDuration bounds a deferred reply, which finishes in the background after
 * the response (waitUntil): a chart reads its stock (6s at most), fetches or
 * draws its card (9s at most) and uploads it, then has the CDN draw the cards
 * one press away.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Whether this deployment can verify Discord's requests, and for which app's
 * key: what `task discord:setup` waits for before pointing Discord here, and
 * the quickest check after a deploy. All of it is public; the key only
 * verifies.
 */
export function GET() {
  const publicKey = discordPublicKey();
  return NextResponse.json(
    {
      service: "shorted-discord",
      configured: publicKey !== null,
      publicKey,
      activity: discordActivityEnabled(),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: NextRequest) {
  const started = Date.now();
  const publicKey = discordPublicKey();
  if (!publicKey) {
    return NextResponse.json(
      { error: "Discord bot is not configured" },
      { status: 503 },
    );
  }

  const body = await request.text();
  const verified = verifyDiscordRequest({
    body,
    signature: request.headers.get("x-signature-ed25519"),
    timestamp: request.headers.get("x-signature-timestamp"),
    publicKey,
  });
  if (!verified) {
    return NextResponse.json(
      { error: "invalid request signature" },
      { status: 401 },
    );
  }

  let interaction: Interaction;
  try {
    interaction = JSON.parse(body) as Interaction;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const response = await handleInteraction(interaction, {
    data: discordData,
    rest: discordRest,
    activityEnabled: discordActivityEnabled(),
    now: () => new Date(),
    waitUntil,
    settingsStore: firestoreSettingsStore,
    rememberLaunch,
    settingsUrl: (grant) => {
      const key = settingsLinkKey();
      return key ? settingsPageUrl(signSettingsGrant(grant, key)) : null;
    },
    renderChart: (state) => chartCard(state, new Date()),
    warmCharts: (state) => warmChartCards(state, new Date()),
    onOutcome: ({ action, status, delivery }) =>
      recordProductEvent({
        feature: "discord",
        action,
        status,
        properties: {
          duration_ms: Date.now() - started,
          event_type: delivery,
          route_group: "/api/discord/*",
        },
      }),
  });
  return NextResponse.json(response, { headers: NO_STORE });
}
