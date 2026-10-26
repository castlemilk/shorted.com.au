import { NextResponse, type NextRequest } from "next/server";

import { discordPublicKey } from "~/@/lib/discord/config";
import { verifyDiscordProxyRequest } from "~/@/lib/discord/verify";
import { recordProductEvent } from "~/@/lib/product-events";

/**
 * The Activity's proxy authentication, observed (docs/discord-bot.md, "Proxy
 * authentication"). The Activity POSTs here once, after Discord's handshake,
 * through Discord's proxy, which adds its signed headers on the way. Nothing
 * depends on the answer yet: this records whether real launches carry valid
 * headers, and which fields Discord's payload holds (the docs name only its
 * times), before anything is made to require them.
 *
 * It answers 204 to a verified request and to one with no proxy headers (a
 * browser, or proxy authentication off), and 401 to headers that fail, as
 * Discord asks. It records an outcome, never a user id or a header.
 *
 * Node, not Edge: verification uses node:crypto, as the interactions route does.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Payload shapes this instance has logged, so each is logged once. */
const loggedShapes = new Set<string>();

/**
 * The payload's field NAMES, never their values, once per shape per instance.
 * A name is cut to a safe label, so a payload cannot write into the log line.
 */
function logPayloadShape(payload: Record<string, unknown>): void {
  const fields = Object.keys(payload)
    .map((k) => k.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40))
    .sort()
    .slice(0, 30);
  const shape = fields.join(",");
  if (loggedShapes.has(shape)) return;
  loggedShapes.add(shape);
  console.log(JSON.stringify({ type: "discord_proxy_payload_fields", fields }));
}

export function POST(request: NextRequest) {
  const publicKey = discordPublicKey();
  if (!publicKey) {
    return new NextResponse(null, { status: 503, headers: NO_STORE });
  }
  const result = verifyDiscordProxyRequest({
    payload: request.headers.get("x-discord-proxy-payload"),
    signature: request.headers.get("x-signature-ed25519"),
    timestamp: request.headers.get("x-signature-timestamp"),
    publicKey,
    now: Math.floor(Date.now() / 1000),
  });

  recordProductEvent({
    feature: "discord",
    action: "activity_proxy_auth",
    status: result.ok
      ? "success"
      : result.reason === "missing"
        ? "unauthenticated"
        : "error",
    properties: {
      event_type: result.ok ? "verified" : result.reason,
      route_group: "/api/discord/*",
    },
  });
  if (result.ok) logPayloadShape(result.payload);

  const failed = !result.ok && result.reason !== "missing";
  return new NextResponse(null, {
    status: failed ? 401 : 204,
    headers: NO_STORE,
  });
}
