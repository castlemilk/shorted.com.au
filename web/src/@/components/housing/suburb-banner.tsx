"use client";

import { SuburbBannerMap } from "./suburb-banner-map";

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
  name, sub, stat, statSub, banner, stateCode, salCode,
}: {
  name: string;
  sub: string;
  stat?: string;
  statSub?: string;
  banner?: SuburbBannerData;
  stateCode: string;
  salCode: string;
}) {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: proto string fields default to "" which must be treated as falsy
  const key = banner?.bgKey || banner?.archetype || "leafy-suburban";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border">
      {banner?.bgUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- full-bleed local/remote background, not a next/image-optimizable case (fill+dark: toggle pair)
        <img src={banner.bgUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- baked local AVIF, dark:-toggled sibling pair (next/image fill can't express the pair cleanly) */}
          <img
            src={`/housing-banners/bg/${key}.light.avif`}
            alt=""
            className="absolute inset-0 h-full w-full object-cover dark:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- see light variant above */}
          <img
            src={`/housing-banners/bg/${key}.dark.avif`}
            alt=""
            className="absolute inset-0 hidden h-full w-full object-cover dark:block"
          />
        </>
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-background/85 via-background/45 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-background/60 to-transparent" />

      <div className="relative flex min-h-[200px] items-center justify-between gap-4 p-6 sm:min-h-[260px] sm:p-8">
        <div className="max-w-[62%]">
          <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Housing</div>
          <h1 className="mt-1 font-serif text-4xl font-semibold capitalize text-foreground sm:text-6xl">
            {name.toLowerCase()}
          </h1>
          <p className="mt-1 font-mono text-sm text-muted-foreground">{sub}</p>
          {stat ? <p className="mt-3 font-mono text-2xl font-semibold text-primary">{stat}</p> : null}
          {statSub ? <p className="font-mono text-xs text-muted-foreground">{statSub}</p> : null}
        </div>

        <div className="hidden aspect-square w-40 shrink-0 rounded-xl border border-border/60 bg-card/70 p-2 backdrop-blur-sm sm:block sm:w-52">
          <SuburbBannerMap stateCode={stateCode} salCode={salCode} />
        </div>
      </div>

      {banner?.blurb ? (
        <p className="relative px-6 pb-5 text-sm text-muted-foreground sm:px-8">{banner.blurb}</p>
      ) : null}
    </div>
  );
}
