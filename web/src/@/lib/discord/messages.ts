import { siteConfig } from "~/@/config/site";
import {
  CHART_PERIOD_PHRASE,
  shortFmt,
} from "~/@/components/charts/chart-views";
import {
  CHART_SOURCE,
  chartImageUrl,
  chartShareUrl,
  chartSubject,
} from "~/@/lib/embed/snippet";
import { formatCompanyName } from "~/@/lib/company-name";
import { formatNumber } from "~/@/lib/utils";
import {
  ButtonStyle,
  ComponentType,
  LIMITS,
  MessageFlags,
  truncate,
  type ActionRow,
  type AutocompleteChoice,
  type Button,
  type Embed,
  type MessagePayload,
} from "./api";
import { DISCORD_PERIODS, DISCORD_VIEWS } from "./commands";
import {
  PICK_CUSTOM_ID,
  activityCustomId,
  chartCustomId,
  type ChartState,
} from "./custom-id";
import type { DiscordSettings, SettingsScope } from "./settings";

/**
 * Discord messages, built from data and nothing else: no fetches, no clock
 * unless one is passed in. Every surface prints figures the way the site does
 * (short interest to two decimals, the 30-day change in percentage points
 * with a true minus), and a figure we do not have is left out, never printed
 * as 0 or "undefined".
 */

/**
 * Phosphor Amber, hsl(32 100% 65%): the dark-mode primary in DESIGN.md.
 * Discord is read mostly in its dark theme, and the embed's side bar is the
 * one place the bot can carry the brand colour.
 */
export const EMBED_COLOR = 0xffac4d;

const SITE = siteConfig.url;
// U+2212 for a fall and U+2013 for no change, as the stock header prints them;
// written as escapes because both look like a hyphen.
const MINUS = "\u2212";
const FLAT = "\u2013";

const NO_MENTIONS = {
  parse: [],
} as const satisfies MessagePayload["allowed_mentions"];

const asOfFmt = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

/** "2026-10-19": today in Sydney, the chart image's cache key. */
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Australia/Sydney",
});

export interface StockSummary {
  code: string;
  /** Cleaned company name. */
  name?: string;
  industry?: string;
  /** Percent of shares on issue reported short. */
  shortPct?: number;
  reportedShorts?: number;
  sharesOnIssue?: number;
  daysToCover?: number;
  marketCap?: number;
  /** Change in short interest over 30 days, in percentage points. */
  change30d?: number | null;
  /** Date of the latest ASIC report that contains the stock. */
  asOf?: Date | null;
}

export interface StockHit {
  code: string;
  name: string;
  shortPct?: number;
  industry?: string;
}

/**
 * A search result as a hit: the code upper-cased, the name cleaned, and a
 * zero short percentage left out (it means none reported, not 0.00%).
 */
export function hitFromStock(stock: {
  productCode: string;
  name: string;
  percentageShorted: number;
  industry: string;
}): StockHit {
  return {
    code: stock.productCode.toUpperCase(),
    name: formatCompanyName(stock.name, stock.productCode),
    shortPct: stock.percentageShorted > 0 ? stock.percentageShorted : undefined,
    industry: stock.industry || undefined,
  };
}

/** Discord markdown would read `*`, `_` and friends in a name as formatting. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>[\]()])/g, "\\$1");
}

const finite = (v: number | undefined | null): v is number =>
  typeof v === "number" && Number.isFinite(v);

const known = (v: number | undefined | null): v is number => finite(v) && v > 0;

/**
 * The 30-day change as the stock page's header prints it: "▲ +0.62 pp",
 * "▼ −0.31 pp", "– 0.00 pp". Rounded first, so glyph, sign and digits agree.
 */
export function formatChange(change: number): string {
  const rounded = Number(change.toFixed(2)) || 0;
  if (rounded === 0) return `${FLAT} 0.00 pp`;
  const sign = rounded > 0 ? "+" : MINUS;
  return `${rounded > 0 ? "▲" : "▼"} ${sign}${Math.abs(rounded).toFixed(2)} pp`;
}

export function stockPageUrl(code: string): string {
  return `${SITE}/shorts/${encodeURIComponent(code)}`;
}

/**
 * The chart card (/chart/<CODE>/image), with today's Sydney date appended.
 * Discord's media proxy caches an image by its URL, so without the date a
 * chart posted again tomorrow would show yesterday's picture; the route
 * ignores the parameter, and the CDN keys on it, so each day draws afresh.
 */
export function chartCardUrl(state: ChartState, now: Date): string {
  const url = new URL(chartImageUrl(state.code, state.view, state.period));
  url.searchParams.set("v", dayFmt.format(now));
  return url.toString();
}

function headline({ shortPct, change30d }: StockSummary): string {
  if (!finite(shortPct)) return "No short position in the latest ASIC data";
  const pct = `**${shortFmt(shortPct)}** of shares reported short`;
  return finite(change30d)
    ? `${pct} · ${formatChange(change30d)} in 30 days`
    : pct;
}

function stockFields(s: StockSummary): NonNullable<Embed["fields"]> {
  const rows: [name: string, value: string | false][] = [
    [
      "Reported short",
      known(s.reportedShorts) && `${formatNumber(s.reportedShorts)} shares`,
    ],
    [
      "Shares on issue",
      known(s.sharesOnIssue) && formatNumber(s.sharesOnIssue),
    ],
    ["Days to cover", known(s.daysToCover) && s.daysToCover.toFixed(1)],
    ["Market cap", known(s.marketCap) && `$${formatNumber(s.marketCap)}`],
    ["Industry", !!s.industry && truncate(s.industry, LIMITS.embedFieldValue)],
  ];
  return rows.flatMap(([name, value]) =>
    value ? [{ name, value, inline: true }] : [],
  );
}

function footer(summary: StockSummary, state: ChartState): string {
  const source = CHART_SOURCE[state.view];
  const asOf =
    summary.asOf && state.view !== "price"
      ? `, short positions as of ${asOfFmt.format(summary.asOf)}`
      : "";
  return truncate(
    `Source: ${source}${asOf} · shorted.com.au`,
    LIMITS.embedFooter,
  );
}

/**
 * The chart's share page, turned sideways on a phone held upright. Discord's
 * in-app browser keeps to portrait, so turning the phone does nothing there;
 * the page draws the chart sideways instead. Anywhere else the flag is
 * ignored.
 */
export function openOnShortedUrl(state: ChartState): string {
  const url = new URL(chartShareUrl(state.code, state.view, state.period));
  url.searchParams.set("landscape", "1");
  return url.toString();
}

function button(label: string, customId: string, active: boolean): Button {
  return {
    type: ComponentType.BUTTON,
    // The active control stays clickable: pressing it redraws the chart, which
    // is the refresh button the row has no room for.
    style: active ? ButtonStyle.PRIMARY : ButtonStyle.SECONDARY,
    label,
    custom_id: customId,
  };
}

export function chartComponents(
  state: ChartState,
  { activity }: { activity: boolean },
): ActionRow[] {
  const periods: ActionRow = {
    type: ComponentType.ACTION_ROW,
    components: DISCORD_PERIODS.map((p) =>
      button(
        p.label,
        chartCustomId("period", { ...state, period: p.id }),
        p.id === state.period,
      ),
    ),
  };
  const views: Button[] = DISCORD_VIEWS.map((v) =>
    button(
      v.label,
      chartCustomId("view", { ...state, view: v.id }),
      v.id === state.view,
    ),
  );
  if (activity) {
    views.push({
      type: ComponentType.BUTTON,
      style: ButtonStyle.SUCCESS,
      label: "Interactive",
      custom_id: activityCustomId(state),
    });
  }
  views.push({
    type: ComponentType.BUTTON,
    style: ButtonStyle.LINK,
    label: "Open on Shorted",
    url: openOnShortedUrl(state),
  });
  return [periods, { type: ComponentType.ACTION_ROW, components: views }];
}

export interface ChartMessageOptions {
  summary: StockSummary;
  state: ChartState;
  /** Offer the button that opens the chart as a Discord Activity. */
  activity: boolean;
  now: Date;
  /**
   * The chart card as PNG, uploaded with the message (chart-card.ts). Without
   * it the embed points at the card's URL for Discord to fetch.
   */
  card?: Uint8Array | null;
}

/** The card's file name: one per chart, so a redraw names what it shows. */
export function chartCardFileName({ code, view, period }: ChartState): string {
  return `${code}-${view}-${period}.png`;
}

/**
 * A stock's chart: the chart card as the embed's image, the latest readings
 * above it, and two rows of controls that redraw it in place (period, view).
 */
export function buildChartMessage({
  summary,
  state,
  activity,
  now,
  card,
}: ChartMessageOptions): MessagePayload {
  const file = card
    ? {
        name: chartCardFileName(state),
        data: card,
        contentType: "image/png",
        description: truncate(
          `${state.code} ${chartSubject(state.view)} chart, ${CHART_PERIOD_PHRASE[state.period]}`,
          LIMITS.attachmentDescription,
        ),
      }
    : null;
  const title = summary.name ? `${state.code} · ${summary.name}` : state.code;
  const embed: Embed = {
    title: truncate(title, LIMITS.embedTitle),
    url: stockPageUrl(state.code),
    // The card under it prints what it charts and over what period, and the
    // highlighted buttons say the same, so the text is the readings only.
    description: truncate(headline(summary), LIMITS.embedDescription),
    color: EMBED_COLOR,
    fields: stockFields(summary),
    // No thumbnail: the card draws the company's logo on a light tile, and the
    // raw logo (often dark on transparent) would vanish on Discord's dark theme.
    image: {
      url: file ? `attachment://${file.name}` : chartCardUrl(state, now),
    },
    footer: { text: footer(summary, state) },
  };
  return {
    embeds: [embed],
    components: chartComponents(state, { activity }),
    allowed_mentions: NO_MENTIONS,
    ...(file ? { files: [file] } : {}),
  };
}

function pickMenu(hits: StockHit[], placeholder: string): ActionRow {
  return {
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.STRING_SELECT,
        custom_id: PICK_CUSTOM_ID,
        placeholder,
        options: hits.slice(0, LIMITS.selectOptions).map((h) => ({
          label: truncate(`${h.code} · ${h.name}`, LIMITS.selectOptionLabel),
          value: h.code,
          ...(typeof h.shortPct === "number"
            ? { description: `${shortFmt(h.shortPct)} short` }
            : {}),
        })),
      },
    ],
  };
}

function hitLine(hit: StockHit, rank?: number): string {
  const prefix =
    rank === undefined ? "" : `\`${String(rank).padStart(2, " ")}\` `;
  const pct =
    typeof hit.shortPct === "number" ? ` · **${shortFmt(hit.shortPct)}**` : "";
  return `${prefix}[**${hit.code}**](${stockPageUrl(hit.code)}) ${escapeMarkdown(hit.name)}${pct}`;
}

/** Lines joined under Discord's description limit, dropping whole lines. */
function fitLines(lines: string[], max: number): string {
  let out = "";
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

export function buildTopMessage(rows: StockHit[]): MessagePayload {
  if (rows.length === 0) {
    return notice(
      "The top shorts table is unavailable right now. Try again in a minute.",
    );
  }
  const embed: Embed = {
    title: `The ${rows.length} most shorted ASX stocks`,
    url: `${SITE}/top`,
    description: fitLines(
      rows.map((r, i) => hitLine(r, i + 1)),
      LIMITS.embedDescription,
    ),
    color: EMBED_COLOR,
    footer: {
      text: "Percent of shares on issue reported short, from ASIC's daily reports · shorted.com.au",
    },
  };
  return {
    embeds: [embed],
    components: [
      pickMenu(rows, "Chart one of these…"),
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.LINK,
            label: "Full table",
            url: `${SITE}/top`,
          },
        ],
      },
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

export function buildSearchMessage(
  query: string,
  hits: StockHit[],
): MessagePayload {
  if (hits.length === 0) {
    return notice(
      `No ASX stocks match “${truncate(query, 60)}”. Try a code like BHP, or part of a company name.`,
    );
  }
  const embed: Embed = {
    title: truncate(`Stocks matching “${query}”`, LIMITS.embedTitle),
    url: `${SITE}/search?q=${encodeURIComponent(query)}`,
    description: fitLines(
      hits.map((h) => hitLine(h)),
      LIMITS.embedDescription,
    ),
    color: EMBED_COLOR,
    footer: { text: "Pick one below to chart it · shorted.com.au" },
  };
  return {
    embeds: [embed],
    components: [pickMenu(hits, "Chart one of these…")],
    allowed_mentions: NO_MENTIONS,
  };
}

export function buildHelpMessage({
  activity,
}: {
  activity: boolean;
}): MessagePayload {
  const lines = [
    "`/stock [code]` A stock's short interest and a chart",
    "`/chart [code] [view] [period]` Short interest, share price, or both",
    "`/search <query>` Find stocks by code or company name",
    "`/top [count]` The most shorted ASX stocks",
    "`/settings` The stock, chart and period the bot opens with, for this server (Manage Server) or just you",
    "",
    "Start typing a company name in `code` to search as you go. With a default stock set, `code` can be left out.",
    "The buttons under a chart redraw it in place for everyone in the channel: pick a period, or switch between short interest, price and both. Pressing the highlighted one again redraws it with the latest figures.",
  ];
  if (activity) {
    lines.push(
      "**Interactive** opens the full chart inside Discord, where you can scrub, zoom and pin readings.",
    );
  }
  return {
    embeds: [
      {
        title: "Shorted for Discord",
        url: SITE,
        description: lines.join("\n"),
        color: EMBED_COLOR,
        footer: {
          text: "Short positions from ASIC's daily reports, published with a four trading-day delay. Not financial advice.",
        },
      },
    ],
    flags: MessageFlags.EPHEMERAL,
    allowed_mentions: NO_MENTIONS,
  };
}

export interface SettingsMessageOptions {
  /** Whose settings: a server's, or the person's own. */
  scope: SettingsScope["kind"];
  settings: DiscordSettings;
  /** The settings page, signed for this scope (settings-link.ts). */
  url: string;
  /** How long the link works. */
  minutes: number;
}

/** What `/settings` answers, privately: the settings now, and the page to change them. */
export function buildSettingsMessage({
  scope,
  settings,
  url,
  minutes,
}: SettingsMessageOptions): MessagePayload {
  const view = DISCORD_VIEWS.find((v) => v.id === settings.view)?.name;
  const period = DISCORD_PERIODS.find((p) => p.id === settings.period)?.name;
  const whose =
    scope === "guild"
      ? "everyone's charts in this server"
      : "your charts in DMs, and in servers that have not set their own";
  return {
    embeds: [
      {
        title: scope === "guild" ? "Settings for this server" : "Your settings",
        description: `These set how ${whose} start. Anything typed in a command still wins: \`/chart BHP view:price\` is BHP's price whatever is set here.`,
        color: EMBED_COLOR,
        fields: [
          {
            name: "Default stock",
            value: settings.code ?? "None: commands ask for one",
            inline: true,
          },
          { name: "Chart", value: view ?? settings.view, inline: true },
          { name: "Period", value: period ?? settings.period, inline: true },
          {
            name: "Opens as",
            value: settings.interactive
              ? "The interactive chart"
              : "A chart message with buttons",
            inline: true,
          },
        ],
        footer: {
          text: `Only you can see this. The link works for ${minutes} minutes; run /settings again for a new one.`,
        },
      },
    ],
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.BUTTON,
            style: ButtonStyle.LINK,
            label: "Change settings",
            url,
          },
        ],
      },
    ],
    flags: MessageFlags.EPHEMERAL,
    allowed_mentions: NO_MENTIONS,
  };
}

/** What a chart command without a code says, with no default stock set. */
export const ASK_FOR_STOCK =
  "Which stock? Give me an ASX code or a company name, e.g. `/stock BHP`, or set a default stock with `/settings`.";

/** A short note only the person who asked can see. */
export function notice(text: string): MessagePayload {
  return {
    content: text,
    flags: MessageFlags.EPHEMERAL,
    allowed_mentions: NO_MENTIONS,
  };
}

export function toAutocompleteChoices(hits: StockHit[]): AutocompleteChoice[] {
  return hits.slice(0, LIMITS.autocompleteChoices).map((h) => {
    const pct =
      typeof h.shortPct === "number" ? ` · ${shortFmt(h.shortPct)} short` : "";
    return {
      name: truncate(`${h.code} · ${h.name}${pct}`, LIMITS.choiceName),
      value: h.code,
    };
  });
}
