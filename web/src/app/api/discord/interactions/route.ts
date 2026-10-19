import { waitUntil } from "@vercel/functions";
import { NextResponse, type NextRequest } from "next/server";

import type { Interaction } from "~/@/lib/discord/api";
import {
  discordActivityEnabled,
  discordPublicKey,
} from "~/@/lib/discord/config";
import { discordData } from "~/@/lib/discord/data";
import { handleInteraction } from "~/@/lib/discord/handler";
import { discordRest } from "~/@/lib/discord/rest";
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
 * the response (waitUntil); every read inside it gives up after 6s.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

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
  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store" },
  });
}
