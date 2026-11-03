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
// and its address stays `/`. discordActivityHeadScript is the same rule, run in
// the browser, which puts the address back before Next's router reads it. It
// also clears the whitespace text the proxy adds to <head> (see its JSDoc).

export const DISCORD_ACTIVITY_PATH = "/embed/discord";

// The launch parameters Discord always sends. Next's matcher (`next start` and
// `next dev`) redirects a request only when each one is present with a value.
// Vercel, which serves production, redirects when each one is present, even
// empty (measured against production). The browser rule follows Next, so it
// moves a subset of what production redirects. Discord always sends both with a
// value, so the empty case does not reach a user.
const LAUNCH_PARAMS = ["frame_id", "instance_id"];

// An Activity is served from `<client_id>.discordsays.com`. The head script's
// sweep runs on that host and nowhere else.
const PROXY_HOST_SUFFIX = ".discordsays.com";

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
 * The inline script the root layout renders first in <head>. It has two parts,
 * run in this order, each in its own try/catch, so a failure in one leaves the
 * other to run.
 *
 * The sweep. Discord's proxy adds its own script to <head>, wrapped in newlines:
 * a whitespace text node, the script, another whitespace text node. React 19 does
 * not skip that script, because only an async script with a src can be skipped,
 * so it hydrates the layout's script onto it. That is harmless: the content is
 * static, and the layout's script has suppressHydrationWarning. An injected text
 * node is a different matter: React treats it as a hydration mismatch. Outside a
 * Suspense boundary that mismatch makes React regenerate the root on the client,
 * and production reports it as React #418. So on a `.discordsays.com` host the
 * script removes every whitespace-only
 * text node (space, tab, newline, form feed, carriage return) that is a direct
 * child of document.head, before the page hydrates. Whitespace text in <head>
 * never renders, so removing it changes nothing on the page. Elements, comments,
 * text inside an element and everything outside <head> stay, and no other host
 * is swept.
 *
 * The address. The document Discord's proxy hands over is the Activity page,
 * rendered on the server, but its address is still `/`.
 * Next's router takes its canonical URL from window.location when it first
 * renders (client/components/app-router.js, via createInitialRouterState), so
 * usePathname() answers `/` and every pathname check treats the Activity as the
 * homepage: the site header, the footer and the corner link all render, and
 * hydration fails (React #418 and #423 in production).
 *
 * The script moves the address to the page the server rendered, keeping the
 * query and the hash, before that first render, on any host. It runs from
 * <head>: the RSC payload that hydration needs is pushed from <body>, so it
 * always comes later.
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
 * It is written in ES5 syntax, with no template literals or arrow functions.
 *
 * @returns {string}
 */
export function discordActivityHeadScript() {
  const keys = JSON.stringify(LAUNCH_PARAMS);
  const path = JSON.stringify(DISCORD_ACTIVITY_PATH);
  const suffix = JSON.stringify(PROXY_HOST_SUFFIX);
  return `(function(){try{var h=String(location.hostname),s=${suffix};if(h.length>s.length&&h.slice(h.length-s.length)===s){var n=document.head.childNodes;for(var j=n.length-1;j>=0;j--){var c=n[j];if(c.nodeType===3&&/^[ \\t\\n\\f\\r]*$/.test(c.nodeValue))document.head.removeChild(c)}}}catch(e){}try{if(location.pathname!=="/")return;var q=new URLSearchParams(location.search),k=${keys};for(var i=0;i<k.length;i++){var v=q.getAll(k[i]);if(!(v.length>1||v[0]))return}history.replaceState(history.state,"",${path}+location.search+location.hash)}catch(e){}})();`;
}
