import type { ReactNode } from "react";

import bannerManifest from "../../../../public/economy-banners/manifest.json";
import { StateBannerMap } from "./state-banner-map-loader";
import { cn } from "@/lib/utils";
import { eyebrow, pageTitle } from "@/lib/typography";
import type { StateSlug } from "@/lib/economy/map-metrics";

export function StateBanner({
  state,
  name,
  subtitle,
}: {
  state: StateSlug;
  name: string;
  subtitle: ReactNode;
}) {
  const assets = bannerManifest[state];
  const headingId = `state-banner-${state}`;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="state-banner"
      className="relative overflow-hidden rounded-2xl border border-border"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- baked themed AVIF pair; CSS theme switching matches the housing banner */}
      <img
        src={assets.light}
        alt=""
        className="absolute inset-0 h-full w-full object-cover dark:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- dark-mode sibling of the baked light banner */}
      <img
        src={assets.dark}
        alt=""
        className="absolute inset-0 hidden h-full w-full object-cover dark:block"
      />

      <div className="absolute inset-0 bg-gradient-to-r from-background/95 via-background/65 to-background/20" />
      <div className="absolute inset-0 bg-gradient-to-t from-background/70 via-transparent to-background/30" />

      <div className="relative grid min-h-[280px] grid-cols-[minmax(0,1fr)_minmax(8rem,38%)] items-center gap-3 p-5 sm:min-h-[310px] sm:grid-cols-[minmax(0,1fr)_minmax(16rem,44%)] sm:gap-8 sm:p-8">
        <div className="relative z-10 min-w-0">
          <p className={cn(eyebrow, "text-foreground/70")}>
            Australian economy
          </p>
          <h1
            id={headingId}
            className={cn(
              pageTitle,
              "mt-2 text-[clamp(2rem,6vw,4.25rem)] font-semibold leading-[0.95] text-foreground",
            )}
          >
            {name} economy
          </h1>
          <div className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            {subtitle}
          </div>
        </div>

        <div className="relative aspect-[18/13] w-full min-w-0 overflow-hidden rounded-2xl border border-border/60 bg-background/55 p-1.5 shadow-sm sm:p-3">
          <StateBannerMap state={state} name={name} />
        </div>
      </div>
    </section>
  );
}
