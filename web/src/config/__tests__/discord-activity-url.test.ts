import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "querystring";

import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";

// The Activity redirect is decided on the server, and again in the browser for a
// document whose address is still `/`. Next decides it with its own matcher, for
// `next start` and `next dev`. Vercel decides it for production on the keys alone,
// so it also redirects an empty value. The browser must move no address that
// either server would not redirect: moving more would hand the homepage's markup
// to the Activity's router. Under Next the browser rule is exact.

// discord-activity.mjs is plain JavaScript with no imports (its header says why),
// and jest does not transform .mjs files, so it is evaluated from its own source:
// the export keywords come off and the bindings are returned.
const activitySource = readFileSync(
  join(__dirname, "..", "discord-activity.mjs"),
  "utf8",
);
const { discordActivityRedirect, discordActivityUrlScript } = new Function(
  `${activitySource.replace(/^export /gm, "")}\nreturn { discordActivityRedirect, discordActivityUrlScript };`,
)() as {
  discordActivityRedirect: () => { has: { type: string; key: string }[] };
  discordActivityUrlScript: () => string;
};

type Has = Parameters<typeof matchHas>[2];
type Query = Parameters<typeof matchHas>[1];
type Req = Parameters<typeof matchHas>[0];

// Query strings, without the leading `?`, as a launch or a visitor could send them.
const CASES = [
  "frame_id=f&instance_id=i",
  "frame_id=f&instance_id=i&platform=desktop&custom_id=activity%3ABHP%3Acombined%3A6m",
  "instance_id=i&frame_id=f",
  "frame_id=f",
  "instance_id=i",
  "frame_id=&instance_id=i",
  "frame_id=f&instance_id=",
  "frame_id&instance_id=i",
  "frame_id=&frame_id=&instance_id=i",
  "frame_id=f&instance_id=i&instance_id=",
  "frame_id=%20&instance_id=i",
  "FRAME_ID=f&instance_id=i",
  "other=1",
  "",
];

// Next's matcher, which `next start` and `next dev` run.
function nextRedirects(query: string): boolean {
  const parsed = parse(query) as unknown as Query;
  const has = discordActivityRedirect().has as unknown as Has;
  return matchHas({} as Req, parsed, has, []) !== false;
}

// Vercel's rule for the same keys: each one present, whatever its value.
function productionRedirects(query: string): boolean {
  const params = new URLSearchParams(query);
  return discordActivityRedirect().has.every(({ key }) => params.has(key));
}

function browserRedirects(query: string): boolean {
  const written: string[] = [];
  const fakeHistory = {
    state: null,
    replaceState(_state: unknown, _title: string, url: string) {
      written.push(url);
    },
  };
  // The script is one IIFE over `location` and `history`, run as the page runs it.
  // eslint-disable-next-line no-new-func
  new Function(
    "location",
    "history",
    "URLSearchParams",
    discordActivityUrlScript(),
  )(
    { pathname: "/", search: query ? `?${query}` : "", hash: "" },
    fakeHistory,
    URLSearchParams,
  );
  return written.length > 0;
}

describe("the browser moves an address only where the server redirects it", () => {
  it("covers the cases that tell the models apart, so the checks below mean something", () => {
    // Next and production differ on an empty value, and the browser follows Next.
    expect(nextRedirects("frame_id=&instance_id=i")).toBe(false);
    expect(productionRedirects("frame_id=&instance_id=i")).toBe(true);
    expect(browserRedirects("frame_id=&instance_id=i")).toBe(false);
    expect(CASES.some((query) => browserRedirects(query))).toBe(true);
    expect(CASES.some((query) => !browserRedirects(query))).toBe(true);
  });

  it.each(CASES)(
    "for the query %j, the browser moves it only if Next redirects it",
    (query) => {
      if (browserRedirects(query)) expect(nextRedirects(query)).toBe(true);
    },
  );

  it.each(CASES)(
    "for the query %j, the browser moves it only if production redirects it",
    (query) => {
      if (browserRedirects(query))
        expect(productionRedirects(query)).toBe(true);
    },
  );

  it.each(CASES)(
    "for the query %j, the browser moves every address Next redirects",
    (query) => {
      if (nextRedirects(query)) expect(browserRedirects(query)).toBe(true);
    },
  );
});
