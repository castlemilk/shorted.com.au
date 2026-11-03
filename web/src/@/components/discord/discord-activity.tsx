"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, LoaderCircle, Search, X } from "lucide-react";
import type { DiscordSDK } from "@discord/embedded-app-sdk";

import {
  EMBED_CONTROL_BUTTON,
  StockChartEmbed,
} from "~/@/components/charts/StockChartEmbed";
import { isPortraitPhone } from "~/@/components/charts/portrait-phone";
import {
  NO_INDICATORS,
  type ChartIndicatorId,
} from "~/@/components/charts/chart-indicators";
import { shortFmt } from "~/@/components/charts/chart-views";
import { Input } from "~/@/components/ui/input";
import { siteConfig } from "~/@/config/site";
import {
  activitySignInUrl,
  discordClientIdFromHost,
  inDiscordFrame,
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
 * The chart is the whole page: search and "open on Shorted" are buttons in its
 * header row, and the Activity renders no links at all.
 *
 * Everything it loads goes through Discord's proxy at
 * <client_id>.discordsays.com, whose root URL mapping is shorted.com.au, and
 * Discord's CSP blocks every other host. So all of it is same-origin: the
 * chart's queries already use relative URLs (the site's rewrites), and search
 * uses the SearchService rewrite here. A link out leaves through the SDK, never
 * window.open; if the SDK has not connected, the link is shown to copy.
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

/** How long a link waits for the SDK before it is shown to copy instead. */
const SDK_WAIT_MS = 3000;
/**
 * How long Discord may take to answer an open before the Activity lets the next
 * press through. The answer is not shown either way; this only keeps a command that
 * never settles from holding the Open button busy for good.
 */
const LINK_SETTLE_MS = 10_000;

/**
 * Which control asked for a link. Only the control that asked shows that the link is
 * on its way out: "open" is Open on Shorted, "sign-in" the advanced indicators' sign-in
 * (the menu's sign-in button shows it busy through `signInBusy`), and "link" a link in
 * the page, which no control shows.
 */
type LinkSource = "open" | "sign-in" | "link";

/** `promise`'s value, or null if it has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
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
        <LoaderCircle
          aria-hidden
          className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
        />
      )}
      {open && hits.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[min(18rem,calc(100dvh-6rem))] overflow-auto rounded-md border bg-popover py-1 text-sm shadow-md">
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
  /**
   * The platform Discord launched it on (`discordPlatform`). Only a phone starts
   * the chart turned sideways: the shape of a frame says nothing of the device.
   */
  platform: "mobile" | "desktop" | null;
}

export function DiscordActivity({ launch, platform }: DiscordActivityProps) {
  const initial = useLaunchChart(launch);
  if (!initial) {
    return (
      <div className="h-full w-full p-2" aria-busy aria-label="Loading chart">
        <div className="h-full w-full animate-pulse rounded bg-muted" />
      </div>
    );
  }
  return <ActivityChart initial={initial} platform={platform} />;
}

/**
 * The Activity's chart. The page is the chart: its header row carries the
 * search and "open on Shorted" buttons, and nothing sits above it.
 */
function ActivityChart({
  initial,
  platform,
}: {
  initial: ChartState;
  platform: DiscordActivityProps["platform"];
}) {
  const [code, setCode] = useState(initial.code);
  const [searching, setSearching] = useState(false);
  // The reader's landscape choice lives here, not in the chart, which remounts for
  // each stock. A phone's own launch starts turned while the screen is a portrait
  // phone. The screen is read once, when the chart first appears, and never again:
  // the on-screen keyboard of a search can reshape it during a stock switch, and
  // that must not turn the new chart upright.
  const [landscapePref, setLandscapePref] = useState(
    () => platform === "mobile" && isPortraitPhone(),
  );
  // The indicator picks, kept across a stock switch for the same reason.
  const [indicatorIds, setIndicatorIds] =
    useState<readonly ChartIndicatorId[]>(NO_INDICATORS);
  const [linkFallback, setLinkFallback] = useState<string | null>(null);
  // A link is on its way out: the SDK is still connecting, or Discord has not answered.
  // `opening` names the control that asked, so only that control shows it. One link at a
  // time: a press on any control while one is out does nothing (linkInFlight).
  const [opening, setOpening] = useState<LinkSource | null>(null);
  const linkInFlight = useRef(false);
  // Bumped on each stock switch. A link that started before one reports nothing when it
  // settles: no fallback for a chart the reader has left, and no clearing of the new one's.
  const generation = useRef(0);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  // The frame does not change under a mounted Activity, so this is read once.
  const inDiscord = useMemo(() => inDiscordFrame(window.location), []);
  const stockUrl = `${siteConfig.url}/shorts/${encodeURIComponent(code)}`;

  // The handshake starts as the Activity opens, so a link tapped early has an SDK.
  useEffect(() => {
    if (inDiscord) void connectDiscord();
  }, [inDiscord]);

  const openOutside = useCallback(
    (url: string, source: LinkSource) => {
      if (!inDiscord) {
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      // Inside Discord a link leaves through the SDK and never window.open:
      // Discord's mobile webview follows a plain navigation in place, loading
      // the whole site inside the Activity (reported 2026-10-29). Without an
      // SDK within SDK_WAIT_MS, the address is shown in the chart to copy instead,
      // and the late SDK does not open it afterwards.
      // One link at a time: a press on any control while one is on its way out does nothing.
      if (linkInFlight.current) return;
      linkInFlight.current = true;
      setOpening(source);
      const started = generation.current;
      // Still the reader's question? A stock switch since the press makes it stale.
      const current = () => generation.current === started;
      void withTimeout(connectDiscord(), SDK_WAIT_MS)
        .then(async (sdk) => {
          if (!sdk) {
            if (current()) setLinkFallback(url);
            return;
          }
          // Through a promise, so a command that throws (rather than rejects) reaches the fallback too.
          const sent = Promise.resolve()
            .then(() => sdk.commands.openExternalLink({ url }))
            .then(
              () => {
                // A later open that goes out clears the address it was offered in place of.
                if (current()) setLinkFallback(null);
              },
              (error: unknown) => {
                console.error(
                  "[discord-activity] openExternalLink failed:",
                  error,
                );
                if (current()) setLinkFallback(url);
              },
            );
          // A command that never settles must not hold the guard for good.
          await withTimeout(sent, LINK_SETTLE_MS);
        })
        .finally(() => {
          // A stock switch has already released the guard and cleared the state for this
          // link, so a stale one leaves them to the newer link.
          if (!current()) return;
          linkInFlight.current = false;
          setOpening(null);
        });
    },
    [inDiscord],
  );

  // A link in the page leaves the same way. The Activity renders none today;
  // this is the net under one added later. Installed from mount inside Discord,
  // not once the handshake has finished. A middle click opens a new tab through
  // `auxclick` rather than `click`, so both are caught; other buttons (a right
  // click's menu) are left alone.
  useEffect(() => {
    if (!inDiscord) return;
    const onClick = (event: MouseEvent) => {
      if (event.type === "auxclick" && event.button !== 1) return;
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (!link) return;
      event.preventDefault();
      // Relative links name the site, not the proxy the page is served from.
      openOutside(
        new URL(link.getAttribute("href")!, siteConfig.url).href,
        "link",
      );
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
    };
  }, [inDiscord, openOutside]);

  return (
    <div className="h-full">
      <StockChartEmbed
        // A new stock starts from the launch view and period.
        key={code}
        stockCode={code}
        defaultView={initial.view}
        defaultPeriod={initial.period}
        selectableView
        // Discord can keep a phone's Activity upright whatever the phone does,
        // so the chart offers to turn itself, as the share page does. The choice
        // is the Activity's (see landscapePref), so it survives each stock switch.
        allowLandscape
        landscape={landscapePref}
        onLandscapeChange={setLandscapePref}
        headerActions={
          <>
            <button
              ref={searchButtonRef}
              type="button"
              onClick={() => setSearching(true)}
              aria-haspopup="dialog"
              aria-expanded={searching}
              title="Search stocks"
              className={EMBED_CONTROL_BUTTON}
            >
              <Search aria-hidden className="h-4 w-4" />
              <span className="sr-only">Search stocks</span>
            </button>
            <button
              type="button"
              onClick={() => openOutside(stockUrl, "open")}
              // While this link's SDK is connecting (up to SDK_WAIT_MS), the button says so.
              // Only its own press does: a sign-in on its way out leaves this button idle.
              aria-busy={opening === "open" || undefined}
              title={`Open ${code} on Shorted`}
              className={EMBED_CONTROL_BUTTON}
            >
              {opening === "open" ? (
                <LoaderCircle
                  aria-hidden
                  className="h-3.5 w-3.5 animate-spin"
                />
              ) : (
                <ExternalLink aria-hidden className="h-3.5 w-3.5" />
              )}
              <span className="sr-only">Open {code} on Shorted</span>
            </button>
          </>
        }
        indicators={{
          // The Activity cannot hold a session, so the advanced indicators stay
          // locked here. Their sign-in opens the chart's share page outside
          // Discord, turned sideways, as the other links do.
          unlock: "never",
          initial: indicatorIds,
          onChange: setIndicatorIds,
          // Only the sign-in's own press shows busy here; the Open button keeps its own state.
          signInBusy: opening === "sign-in",
          onSignIn: (chart) =>
            openOutside(
              activitySignInUrl({
                code: chart.stockCode,
                view: chart.view,
                period: chart.period,
              }),
              "sign-in",
            ),
        }}
        chartOverlay={
          linkFallback ? (
            <LinkFallback
              url={linkFallback}
              onDismiss={() => setLinkFallback(null)}
            />
          ) : undefined
        }
      />
      <StockSearchDialog
        open={searching}
        onOpenChange={setSearching}
        returnFocusTo={searchButtonRef}
        onPick={(picked) => {
          // The stock already on screen is no switch: the chart does not remount, so a link
          // still on its way out keeps its guard, its busy state and its fallback.
          if (picked === code) {
            setSearching(false);
            return;
          }
          // A new stock. The last stock's fallback goes, and a link still on its way out
          // no longer holds the guard or the busy state: its own settling reports nothing.
          generation.current += 1;
          linkInFlight.current = false;
          setOpening(null);
          setLinkFallback(null);
          setCode(picked);
          setSearching(false);
        }}
      />
      {/* Always mounted, so a screen reader hears the fallback when it appears. */}
      <p role="status" className="sr-only">
        {linkFallback
          ? `Discord did not open the link. Copy it into your browser: ${linkFallback}`
          : ""}
      </p>
    </div>
  );
}

/**
 * Search, as an upright dialog over the Activity. Typing needs the phone's
 * keyboard in its own orientation, so the search is not drawn inside the turned
 * chart. Portalled, so nothing inside the rotated box positions it, and above
 * the box (z-[60]); Radix takes Escape.
 */
function StockSearchDialog({
  open,
  onOpenChange,
  onPick,
  returnFocusTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (code: string) => void;
  /** The Search button that opened it, which focus returns to however the dialog closed. */
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-background/70" />
        <Dialog.Content
          aria-describedby={undefined}
          // Radix would return focus to whatever had it before the dialog opened. After a
          // pick that is a chart which has since been replaced, so focus goes to the
          // Search button instead (the new chart's, since the ref follows the remount).
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusTo.current?.focus();
          }}
          className="fixed inset-x-0 top-0 z-[70] mx-auto w-full max-w-lg border-b bg-background p-2 sm:top-3 sm:rounded-md sm:border"
        >
          <Dialog.Title className="sr-only">Search ASX stocks</Dialog.Title>
          <div className="flex items-center gap-2">
            <StockSearch onPick={onPick} />
            <Dialog.Close className={EMBED_CONTROL_BUTTON}>
              <X aria-hidden className="h-4 w-4" />
              <span className="sr-only">Close search</span>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A link Discord would not open (no SDK, or it refused): the address as text to
 * copy, drawn over the chart's box (the chart passes it as `chartOverlay`), so it
 * turns with a landscape chart. It sits above the indicator menu (z-30) and under
 * the search dialog (z-[70]). Text
 * rather than an anchor, since an anchor is what Discord's webview follows in
 * place. The announcement is the Activity's always-mounted status region.
 */
function LinkFallback({
  url,
  onDismiss,
}: {
  url: string;
  onDismiss: () => void;
}) {
  return (
    <div
      data-link-fallback
      className="absolute inset-x-2 bottom-2 z-40 flex items-start gap-2 rounded-md border bg-background p-2 text-xs"
    >
      <p className="min-w-0 flex-1">
        Discord did not open the link. Copy it into your browser:
        <span className="block select-all break-all font-mono">{url}</span>
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className={EMBED_CONTROL_BUTTON}
      >
        <X aria-hidden className="h-4 w-4" />
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  );
}

export default DiscordActivity;
