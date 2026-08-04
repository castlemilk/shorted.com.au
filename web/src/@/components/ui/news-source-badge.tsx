"use client";

interface NewsSourceConfig {
  name: string;
  url: string;
  logo: string;
  bgClass: string;
}

// Source badges are differentiated inside the warm amber family only (see
// DESIGN.md): no cool hues, and no true red/green, which stay quarantined for
// market direction. The badge already carries a name and often a logo, so the
// tint is a secondary cue rather than the identity. Alpha tints read correctly
// on warm paper and on CRT black, so only the text needs a `dark:` sibling.
const AMBER =
  "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30";
const ORANGE =
  "bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/30";
const YELLOW =
  "bg-yellow-500/10 text-yellow-800 dark:text-yellow-300 border-yellow-500/30";
const OLIVE =
  "bg-lime-600/10 text-lime-800 dark:text-lime-300 border-lime-600/30";
const STONE =
  "bg-stone-500/10 text-stone-700 dark:text-stone-300 border-stone-500/30";

// Logos served from /assets/news-sources/ to avoid CORS/blocking issues with remote favicons
const NEWS_SOURCES: Record<string, NewsSourceConfig> = {
  asx: {
    name: "ASX",
    url: "https://www.asx.com.au",
    logo: "/assets/news-sources/asx.png",
    bgClass: AMBER,
  },
  stockhead: {
    name: "Stockhead",
    url: "https://stockhead.com.au",
    logo: "/assets/news-sources/stockhead.png",
    bgClass: STONE,
  },
  smallcaps: {
    name: "Small Caps",
    url: "https://smallcaps.com.au",
    logo: "/assets/news-sources/smallcaps.png",
    bgClass: OLIVE,
  },
  motleyfool: {
    name: "Motley Fool",
    url: "https://www.fool.com.au",
    logo: "/assets/news-sources/motleyfool.png",
    bgClass: ORANGE,
  },
  kalkine: {
    name: "Kalkine",
    url: "https://kalkinemedia.com/au",
    logo: "/assets/news-sources/kalkine.png",
    bgClass: YELLOW,
  },
  googlenews: {
    name: "Google News",
    url: "https://news.google.com",
    logo: "/assets/news-sources/googlenews.png",
    bgClass: STONE,
  },
  livewire: {
    name: "Livewire",
    url: "https://www.livewiremarkets.com",
    logo: "",
    bgClass: ORANGE,
  },
  marketindex: {
    name: "Market Index",
    url: "https://www.marketindex.com.au",
    logo: "",
    bgClass: OLIVE,
  },
  abc: {
    name: "ABC News",
    url: "https://www.abc.net.au/news",
    logo: "",
    bgClass: AMBER,
  },
  smh: {
    name: "SMH",
    url: "https://www.smh.com.au/business",
    logo: "",
    bgClass: STONE,
  },
  theage: {
    name: "The Age",
    url: "https://www.theage.com.au/business",
    logo: "",
    bgClass: YELLOW,
  },
  afr: {
    name: "AFR",
    url: "https://www.afr.com/markets",
    logo: "",
    bgClass: ORANGE,
  },
  businessnews: {
    name: "Business News AU",
    url: "https://www.businessnewsaustralia.com",
    logo: "",
    bgClass: OLIVE,
  },
};

const DEFAULT_SOURCE: NewsSourceConfig = {
  name: "",
  url: "",
  logo: "",
  bgClass: "bg-muted text-muted-foreground border-border",
};

interface NewsSourceBadgeProps {
  source: string;
  showLogo?: boolean;
  className?: string;
  /**
   * When false, render the badge span only (no anchor). Use inside rows that
   * are themselves links — nesting an <a> in an <a> is invalid HTML.
   */
  interactive?: boolean;
}

export function NewsSourceBadge({
  source,
  showLogo = true,
  className = "",
  interactive = true,
}: NewsSourceBadgeProps) {
  const config = NEWS_SOURCES[source] ?? DEFAULT_SOURCE;
  const displayName = config.name || source;

  const badge = (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none ${config.bgClass} ${className}`}
    >
      {showLogo && config.logo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={config.logo}
          alt=""
          width={12}
          height={12}
          className="rounded-sm"
          loading="lazy"
        />
      )}
      {displayName}
    </span>
  );

  if (interactive && config.url) {
    return (
      <a
        href={config.url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:opacity-80 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {badge}
      </a>
    );
  }

  return badge;
}

/** Check if a source is ASX announcements */
export function isASXSource(source: string): boolean {
  return source === "asx";
}

/** Get the source config for external use */
export function getNewsSourceConfig(source: string): NewsSourceConfig {
  return NEWS_SOURCES[source] ?? DEFAULT_SOURCE;
}
