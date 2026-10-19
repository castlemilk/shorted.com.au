// Where the Discord Activity lands, and the redirect that sends it there.
//
// No imports, on purpose: next.config.mjs imports this file, and so does
// scripts/tests/discord-activity-redirect.test.mjs, which runs where nothing
// under web/ is installed (the same arrangement as stock-tab-redirects.mjs).
//
// Discord serves an Activity from https://<client_id>.discordsays.com/ through
// a proxy whose root URL mapping points at shorted.com.au. It always loads the
// mapping's root, `/`, with its launch parameters in the query (`frame_id`,
// `instance_id`, `platform`, and `custom_id` when a button launched it). The
// root is the homepage, which is ISR, cannot read the query, and carries
// `frame-ancestors 'self'`, so Discord could not frame it anyway. This
// redirect, matched on the query at the routing layer, sends exactly those
// requests to the Activity page under /embed/ (which may be framed) and leaves
// every other visit to `/` alone. Next forwards the query string, so the
// launch parameters arrive with it, and the destination is relative, so the
// browser stays on the discordsays.com proxy.

export const DISCORD_ACTIVITY_PATH = "/embed/discord";

/**
 * @returns {{
 *   source: string,
 *   has: { type: string, key: string }[],
 *   destination: string,
 *   permanent: boolean,
 * }}
 */
export function discordActivityRedirect() {
  return {
    source: "/",
    has: [
      { type: "query", key: "frame_id" },
      { type: "query", key: "instance_id" },
    ],
    destination: DISCORD_ACTIVITY_PATH,
    permanent: false,
  };
}
