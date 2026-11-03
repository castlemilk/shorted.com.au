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
// redirect, matched on the query at the routing layer, sends those requests to
// the Activity page under /embed/ (which may be framed) and leaves
// every other visit to `/` alone. Next forwards the query string, so the
// launch parameters arrive with it, and the destination is relative, so the
// browser stays on the discordsays.com proxy.
//
// The proxy follows that redirect on the server, so the browser never sees it
// and its address stays `/`. discordActivityUrlScript is the same rule, run in
// the browser, which puts the address back before Next's router reads it.

export const DISCORD_ACTIVITY_PATH = "/embed/discord";

// The launch parameters Discord always sends. Next's matcher (`next start` and
// `next dev`) redirects a request only when each one is present with a value.
// Vercel, which serves production, redirects when each one is present, even
// empty (measured against production). The browser rule follows Next, so it
// moves a subset of what production redirects. Discord always sends both with a
// value, so the empty case does not reach a user.
const LAUNCH_PARAMS = ["frame_id", "instance_id"];

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
    has: LAUNCH_PARAMS.map((key) => ({ type: "query", key })),
    destination: DISCORD_ACTIVITY_PATH,
    permanent: false,
  };
}

/**
 * The same redirect, for the browser. The document Discord's proxy hands over
 * is the Activity page, rendered on the server, but its address is still `/`.
 * Next's router takes its canonical URL from window.location when it first
 * renders (client/components/app-router.js, via createInitialRouterState), so
 * usePathname() answers `/` and every pathname check treats the Activity as the
 * homepage: the site header, the footer and the corner link all render, and
 * hydration fails (React #418 and #423 in production).
 *
 * The script moves the address to the page the server rendered, keeping the
 * query and the hash, before that first render. It runs from <head>: the RSC
 * payload that hydration needs is pushed from <body>, so it always comes later.
 *
 * It applies the test Next applies to `has`: a query key matches when its value
 * is truthy, so `?frame_id=` (an empty value) does not match, and a repeated key
 * (an array of values) does. It moves only a document whose path is `/` and
 * whose query carries both parameters with a value. Under `next start` and
 * `next dev` that is exactly what the server redirects. Under Vercel the server
 * also redirects an empty value, and this script leaves that address alone, so
 * the script moves a subset of what the server redirects, never more: a document
 * the server did not redirect is the homepage, and moving its address would make
 * the router read the Activity's path over the homepage's markup. The consequence
 * is that an empty launch parameter still gets the site chrome in production.
 *
 * It is static text on purpose. The proxy adds a nonce to every inline script in
 * the page, so this one runs, and a script created at runtime would be blocked.
 *
 * @returns {string}
 */
export function discordActivityUrlScript() {
  const keys = JSON.stringify(LAUNCH_PARAMS);
  const path = JSON.stringify(DISCORD_ACTIVITY_PATH);
  return `(function(){try{if(location.pathname!=="/")return;var q=new URLSearchParams(location.search),k=${keys};for(var i=0;i<k.length;i++){var v=q.getAll(k[i]);if(!(v.length>1||v[0]))return}history.replaceState(history.state,"",${path}+location.search+location.hash)}catch(e){}})();`;
}
