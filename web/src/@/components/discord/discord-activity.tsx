"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ExternalLink, Loader2, Search } from "lucide-react";
import type { DiscordSDK } from "@discord/embedded-app-sdk";

import { StockChartEmbed } from "~/@/components/charts/StockChartEmbed";
import { shortFmt } from "~/@/components/charts/chart-views";
import { Input } from "~/@/components/ui/input";
import { siteConfig } from "~/@/config/site";
import {
  discordClientIdFromHost,
  isDiscordLaunch,
  type ActivityLaunch,
  type LaunchAnswer,
} from "~/@/lib/discord/activity";
import { normalizeCode, type ChartState } from "~/@/lib/discord/custom-id";
import { hitFromStock, type StockHit } from "~/@/lib/discord/messages";
import { SearchService } from "~/gen/shorts/v1alpha1/search_pb";

/**
 * The Discord Activity: the site's interactive chart (scrub, pin, measure,
 * every period and view) inside Discord, opened from a chart message's
 * "Interactive" button, a command in interactive mode, or the App Launcher.
 *
 * Everything it loads goes through Discord's proxy at
 * <client_id>.discordsays.com, whose root URL mapping is shorted.com.au, and
 * Discord's CSP blocks every other host. So all of it is same-origin: the
 * chart's queries already use relative URLs (the site's rewrites), search uses
 * the SearchService rewrite here, and a link out goes through the SDK
 * (an <a target="_blank"> does nothing inside an Activity).
 *
 * Loaded with ssr:false (it imports @connectrpc/connect, see CLAUDE.md).
 */

let connecting: Promise<DiscordSDK | null> | null = null;

/**
 * One handshake per page load, however often React mounts this (strict mode
 * mounts twice), started on first mount. Off Discord (the page opened
 * directly) there is nothing to connect to.
 */
function connectDiscord(): Promise<DiscordSDK | null> {
  connecting ??= (async () => {
    const clientId = discordClientIdFromHost(window.location.hostname);
    if (
      !clientId ||
      !isDiscordLaunch(new URLSearchParams(window.location.search))
    ) {
      return null;
    }
    const { DiscordSDK, Common, Platform } = await import(
      "@discord/embedded-app-sdk"
    );
    const sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
    await sdk.ready();
    if (sdk.platform === Platform.MOBILE) {
      // Discord can hold an Activity upright on a phone, and a time series
      // reads best turned sideways: let the phone turn it.
      void sdk.commands
        .setOrientationLockState({
          lock_state: Common.OrientationLockStateTypeObject.UNLOCKED,
        })
        .catch((error: unknown) => {
          console.error("[discord-activity] orientation unlock failed:", error);
        });
    }
    // Through Discord's proxy, which signs it on the way: the server records
    // whether launches carry valid proxy headers (api/discord/activity). The
    // answer changes nothing here.
    void fetch("/api/discord/activity", {
      method: "POST",
      cache: "no-store",
      keepalive: true,
    }).catch(() => undefined);
    return sdk;
  })().catch((error: unknown) => {
    console.error("[discord-activity] handshake failed:", error);
    return null;
  });
  return connecting;
}

function useDiscordSdk(): DiscordSDK | null {
  const [sdk, setSdk] = useState<DiscordSDK | null>(null);
  useEffect(() => {
    let live = true;
    void connectDiscord().then((connected) => {
      if (live) setSdk(connected);
    });
    return () => {
      live = false;
    };
  }, []);
  return sdk;
}

// Relative: the request goes to the page's own origin, which inside Discord
// is the proxy, which forwards it to shorted.com.au and its rewrite.
const searchClient = createClient(
  SearchService,
  createConnectTransport({ baseUrl: "" }),
);

function useStockSearch(query: string): { hits: StockHit[]; loading: boolean } {
  const [hits, setHits] = useState<StockHit[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      searchClient
        .searchStocks(
          { query: q, limit: 8, includeDetails: false },
          { signal: controller.signal },
        )
        .then((response) =>
          setHits(
            response.stocks.filter((s) => s.productCode).map(hitFromStock),
          ),
        )
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            console.error("[discord-activity] search failed:", error);
            setHits([]);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return { hits, loading };
}

function StockSearch({ onPick }: { onPick: (code: string) => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const { hits, loading } = useStockSearch(query);

  const pick = (code: string) => {
    onPick(code);
    setQuery("");
    setOpen(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = normalizeCode(query);
    // A code typed in full wins over a fuzzy first match ("CBA" is CBA).
    const code =
      hits.find((h) => h.code === typed)?.code ?? typed ?? hits[0]?.code;
    if (code) pick(code);
  };

  return (
    <form role="search" onSubmit={submit} className="relative min-w-0 flex-1">
      <label htmlFor={id} className="sr-only">
        Search ASX stocks
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        id={id}
        type="search"
        value={query}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search a code or company"
        className="pl-9 [@media(max-height:480px)]:h-8"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {loading && (
        <Loader2
          aria-hidden
          className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
        />
      )}
      {open && hits.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-auto rounded-md border bg-popover py-1 text-sm shadow-md">
          {hits.map((hit) => (
            <li key={hit.code}>
              <button
                type="button"
                // mousedown, not click: the input's blur would close the list
                // before the click landed.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(hit.code);
                }}
                className="flex min-h-10 w-full items-center gap-2 px-3 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
              >
                <span className="w-14 shrink-0 font-semibold">{hit.code}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {hit.name}
                </span>
                {hit.shortPct !== undefined && (
                  <span className="shrink-0 tabular-nums">
                    {shortFmt(hit.shortPct)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** How long the Activity waits to hear which chart to open before its own. */
const LAUNCH_LOOKUP_MS = 2500;

/**
 * The chart to open. A button names it in the URL; a launch from the App
 * Launcher, or from a command in interactive mode, does not, so then the
 * server is asked (api/discord/activity/launch): the chart a command just
 * asked for in this channel, else the server's defaults. Null while asking.
 */
function useLaunchChart(launch: ActivityLaunch): ChartState | null {
  const { source, channelId, guildId, state } = launch;
  const asks = source === "default" && Boolean(channelId ?? guildId);
  const [chart, setChart] = useState<ChartState | null>(asks ? null : state);
  const { code, view, period } = state;

  useEffect(() => {
    if (!asks) return;
    const fallback = { code, view, period };
    const query = new URLSearchParams();
    if (channelId) query.set("channel", channelId);
    if (guildId) query.set("guild", guildId);
    const controller = new AbortController();
    let live = true;
    const timer = setTimeout(() => controller.abort(), LAUNCH_LOOKUP_MS);
    void fetch(`/api/discord/activity/launch?${query.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<LaunchAnswer>) : null))
      .then((answer) => answer?.state ?? fallback)
      .catch(() => fallback)
      .then((next) => {
        if (live) setChart(next);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [asks, channelId, guildId, code, view, period]);

  return chart;
}

export interface DiscordActivityProps {
  /** How the Activity was launched, read from its URL. */
  launch: ActivityLaunch;
}

export function DiscordActivity({ launch }: DiscordActivityProps) {
  const initial = useLaunchChart(launch);
  if (!initial) {
    return (
      <div className="h-full w-full p-2" aria-busy aria-label="Loading chart">
        <div className="h-full w-full animate-pulse rounded bg-muted" />
      </div>
    );
  }
  return <ActivityChart initial={initial} />;
}

function ActivityChart({ initial }: { initial: ChartState }) {
  const [code, setCode] = useState(initial.code);
  const sdk = useDiscordSdk();
  const stockUrl = `${siteConfig.url}/shorts/${encodeURIComponent(code)}`;

  const openOutside = useCallback(
    (url: string) => {
      if (sdk) {
        void sdk.commands.openExternalLink({ url }).catch((error: unknown) => {
          console.error("[discord-activity] openExternalLink failed:", error);
        });
        return;
      }
      window.open(url, "_blank", "noopener");
    },
    [sdk],
  );

  // Inside Discord every link leaves through the SDK. A plain one does
  // nothing on desktop, and Discord's mobile webview can follow it in place,
  // loading the whole site inside the Activity (reported 2026-10-29).
  useEffect(() => {
    if (!sdk) return;
    const onClick = (event: MouseEvent) => {
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (!link) return;
      event.preventDefault();
      // Relative links name the site, not the proxy the page is served from.
      openOutside(new URL(link.getAttribute("href")!, siteConfig.url).href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [sdk, openOutside]);

  return (
    // No minimum height: a phone held sideways leaves the Activity ~330px, and
    // the chart takes what the bar leaves rather than scrolling the frame.
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-2 pt-2 sm:px-3 sm:pt-3 [@media(max-height:480px)]:pt-1">
        <StockSearch onPick={setCode} />
        <button
          type="button"
          onClick={() => openOutside(stockUrl)}
          className="inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground [@media(max-height:480px)]:h-8"
        >
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          {/* Icon only on a phone, where the search field needs the width. */}
          <span className="max-sm:sr-only">{code} on Shorted</span>
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <StockChartEmbed
          // A new stock starts from the launch view and period.
          key={code}
          stockCode={code}
          defaultView={initial.view}
          defaultPeriod={initial.period}
          selectableView
          // Discord can keep a phone's Activity upright whatever the phone
          // does, so the chart offers to turn itself, as the share page does.
          allowLandscape
        />
      </div>
    </div>
  );
}

export default DiscordActivity;
