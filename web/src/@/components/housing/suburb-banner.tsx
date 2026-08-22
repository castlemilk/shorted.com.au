// Server component: no hooks, no handlers — just markup over already-resolved
// props. It carries the page's <h1> and headline price, so it must stay in the
// server HTML. The one interactive child (SuburbBannerMap) is its own "use
// client" module, which makes the boundary start there instead of here.
import { safeBannerUrl } from "@/lib/housing/banner-url";
import { titleCaseName } from "@/lib/housing/states";
import { HousingIcon } from "./housing-icon";
import { HOUSING_ICONS, type HousingIconName } from "./housing-icons.generated";
import { SuburbBannerMap } from "./suburb-banner-map";

function isHousingIconName(value: string): value is HousingIconName {
  return Object.prototype.hasOwnProperty.call(HOUSING_ICONS.icons, value);
}

export type SuburbBannerData = {
  archetype: string;
  blurb: string;
  bgKey: string;
  bgUrl?: string;
};

/**
 * Composite header for a suburb profile: a baked archetype background (or a
 * live RPC-supplied bgUrl override), a serif/mono type stack, and a small
 * static locator map. bgKey selects the light/dark AVIF pair committed under
 * /public/housing-banners/bg — see the RPC's GetSuburbProfileResponse.banner.
 */
export function SuburbBanner({
  name, sub, stat, statDelta, statNote, statSub, banner, stateCode, salCode,
}: {
  name: string;
  sub: string;
  /** Headline figure, e.g. "$3.42M". */
  stat?: string;
  /** Signed year-on-year move rendered beside the figure, e.g. "+4.1% yr". */
  statDelta?: { text: string; positive: boolean };
  /** What the figure is, e.g. "median house · Jun 2026". */
  statNote?: string;
  /** Fallback line when there is no figure at all (unpriced suburb). */
  statSub?: string;
  banner?: SuburbBannerData;
  stateCode: string;
  salCode: string;
}) {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: proto string fields default to "" which must be treated as falsy
  const key = banner?.bgKey || banner?.archetype || "leafy-suburban";
  // An unrecognised override host is declined, not rendered: bg_url is RPC text
  // and an <img src> pointed at an arbitrary host is an outbound request
  // carrying every visitor's IP. The baked archetype below is always available,
  // so declining costs nothing.
  const override = safeBannerUrl(banner?.bgUrl);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border">
      {override ? (
        // eslint-disable-next-line @next/next/no-img-element -- full-bleed background on the LCP path; next/image fill adds a wrapper and buys nothing here
        <img src={override} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        // One fetch, not two: `.banner-art` reads whichever custom property the
        // active theme selects, and the unreferenced url() is never resolved.
        // See the .banner-art rule in globals.css for why this is not a
        // <picture> with prefers-color-scheme.
        <div
          aria-hidden
          className="banner-art absolute inset-0"
          style={
            {
              "--banner-light": `url('/housing-banners/bg/${key}.light.avif')`,
              "--banner-dark": `url('/housing-banners/bg/${key}.dark.avif')`,
            } as React.CSSProperties
          }
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-background/90 via-background/70 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-background/60 to-transparent" />

      <div className="relative flex min-h-[200px] items-center justify-between gap-4 p-6 sm:min-h-[260px] sm:p-8">
        {/* The 62% cap only exists to clear the locator inset, and that inset is
            hidden below sm — capping there squeezed the h1 into 62% of a phone
            screen for nothing. */}
        <div className="max-w-full sm:max-w-[62%]">
          <div className="flex items-center gap-2">
            {banner?.archetype && isHousingIconName(banner.archetype) ? (
              <span className="inline-flex items-center justify-center rounded-full border border-border/60 bg-card/70 p-1 backdrop-blur-sm">
                <HousingIcon name={banner.archetype} size={16} title={banner.archetype} />
              </span>
            ) : null}
            <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Housing</div>
          </div>
          <h1 className="mt-1 font-serif text-4xl font-semibold text-foreground sm:text-6xl">
            {titleCaseName(name)}
          </h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">{sub}</p>
          {stat ? (
            <div className="mt-3.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="font-mono text-2xl font-semibold tabular-nums text-primary sm:text-[27px]">
                {stat}
              </span>
              {statDelta ? (
                <span
                  className="font-mono text-xs font-semibold tabular-nums"
                  style={{
                    color: statDelta.positive ? "var(--semantic-green-text)" : "var(--semantic-red-text)",
                  }}
                >
                  {statDelta.text}
                </span>
              ) : null}
              {statNote ? (
                <span className="font-mono text-[11px] text-muted-foreground">{statNote}</span>
              ) : null}
            </div>
          ) : statSub ? (
            <p className="mt-3 font-mono text-xs text-muted-foreground">{statSub}</p>
          ) : null}

          {banner?.blurb ? (
            <p className="mt-3.5 max-w-[52ch] text-sm text-muted-foreground [text-wrap:pretty]">
              {banner.blurb}
            </p>
          ) : null}
        </div>

        <div className="hidden aspect-square w-40 shrink-0 rounded-xl border border-border/60 bg-card/70 p-2 backdrop-blur-sm sm:block sm:w-52">
          <SuburbBannerMap stateCode={stateCode} salCode={salCode} />
        </div>
      </div>

    </div>
  );
}
