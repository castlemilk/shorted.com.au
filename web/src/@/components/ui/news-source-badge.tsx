interface NewsSourceConfig {
  name: string;
  url: string;
  logo: string;
  bgClass: string;
}

// Logos served from /assets/news-sources/ to avoid CORS/blocking issues with remote favicons
const NEWS_SOURCES: Record<string, NewsSourceConfig> = {
  asx: {
    name: "ASX",
    url: "https://www.asx.com.au",
    logo: "/assets/news-sources/asx.png",
    bgClass: "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 border-yellow-300 dark:border-yellow-700",
  },
  stockhead: {
    name: "Stockhead",
    url: "https://stockhead.com.au",
    logo: "/assets/news-sources/stockhead.png",
    bgClass: "bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-700",
  },
  smallcaps: {
    name: "Small Caps",
    url: "https://smallcaps.com.au",
    logo: "/assets/news-sources/smallcaps.png",
    bgClass: "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700",
  },
  motleyfool: {
    name: "Motley Fool",
    url: "https://www.fool.com.au",
    logo: "/assets/news-sources/motleyfool.png",
    bgClass: "bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-700",
  },
  kalkine: {
    name: "Kalkine",
    url: "https://kalkinemedia.com/au",
    logo: "/assets/news-sources/kalkine.png",
    bgClass: "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700",
  },
  googlenews: {
    name: "Google News",
    url: "https://news.google.com",
    logo: "/assets/news-sources/googlenews.png",
    bgClass: "bg-slate-50 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700",
  },
  livewire: {
    name: "Livewire",
    url: "https://www.livewiremarkets.com",
    logo: "",
    bgClass: "bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-700",
  },
  marketindex: {
    name: "Market Index",
    url: "https://www.marketindex.com.au",
    logo: "",
    bgClass: "bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-300 border-teal-200 dark:border-teal-700",
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
}

export function NewsSourceBadge({
  source,
  showLogo = true,
  className = "",
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

  if (config.url) {
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
