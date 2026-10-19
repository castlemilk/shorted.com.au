import { siteConfig } from "~/@/config/site";
import {
  CHART_PERIOD_PHRASE,
  type ChartPeriod,
  type ChartViewId,
} from "~/@/components/charts/chart-views";
import {
  DEFAULT_CHART_PERIOD,
  DEFAULT_CHART_VIEW,
  buildEmbedSnippet,
  chartImageUrl,
  chartShareUrl,
  chartSubject,
  type EmbedTarget,
} from "./snippet";

/**
 * Ready-to-paste share copy for each place people take a chart.
 *
 * WHY A LINK, NOT THE EMBED SNIPPET: chat apps and social networks do not
 * render HTML. Pasted into Discord, the <figure> snippet arrives as a wall of
 * markup (reported 2026-10-19, WBT in a Discord channel). What those apps DO
 * render is a link's preview card, so every channel here except "website" is a
 * link plus a line of text, and the card does the showing: for a chart the
 * link is its share page (/chart/<code>), whose og:image is the chart itself.
 *
 * Copy rules: say what the chart is and where the data comes from; no emoji,
 * no hype. A ticker is written "ASX:WBT" where a network reads "$WBT" as a US
 * cashtag. A link is never wrapped in <angle brackets>: Discord suppresses the
 * preview of a link written that way.
 */

export type ShareChannelId =
  | "discord"
  | "slack"
  | "x"
  | "linkedin"
  | "reddit"
  | "markdown"
  | "website";

export interface ShareChannel {
  id: ShareChannelId;
  label: string;
  /** What the copied text is for, and what the reader will see. */
  hint: string;
  /** What the Copy button writes. */
  text: string;
  /** Show `text` as code (HTML, Markdown) rather than as a message. */
  code?: boolean;
  /** The network's own composer, prefilled, when it has one. */
  intent?: { label: string; href: string };
}

export interface ShareKit {
  /** Absolute URL to share. Unfurls into a preview card. */
  url: string;
  /** "WBT share price and short interest, past month" */
  headline: string;
  /** The chart's social card (charts only): also offered as a download. */
  imageUrl: string | null;
  /** File name for the downloaded image. */
  imageFileName: string | null;
  channels: ShareChannel[];
}

export const SHARE_CHANNEL_IDS: readonly ShareChannelId[] = [
  "discord",
  "slack",
  "x",
  "linkedin",
  "reddit",
  "markdown",
  "website",
];

export function isShareChannelId(v: unknown): v is ShareChannelId {
  return (
    typeof v === "string" &&
    (SHARE_CHANNEL_IDS as readonly string[]).includes(v)
  );
}

interface ShareSubject {
  url: string;
  headline: string;
  /** Headline for a network that reads "$CODE" as a US ticker. */
  socialHeadline: string;
  /** "official ASIC short position reports" etc. */
  source: string;
  imageUrl: string | null;
  imageFileName: string | null;
  /** Alt text for the Markdown image. */
  imageAlt: string;
}

function chartSubjectFor(
  code: string,
  view: ChartViewId,
  period: ChartPeriod,
): ShareSubject {
  const subject = chartSubject(view);
  const when = CHART_PERIOD_PHRASE[period];
  return {
    url: chartShareUrl(code, view, period),
    headline: `${code} ${subject}, ${when}`,
    socialHeadline: `ASX:${code} ${subject}, ${when}`,
    source: buildEmbedSnippet({ kind: "chart", code, view, period }).source,
    imageUrl: chartImageUrl(code, view, period),
    imageFileName: `${code}-${view}-${period}.png`,
    imageAlt: `${code} ${subject} chart`,
  };
}

function subjectFor(target: EmbedTarget): ShareSubject {
  if (target.kind === "chart") {
    return chartSubjectFor(
      target.code.trim().toUpperCase(),
      target.view ?? DEFAULT_CHART_VIEW,
      target.period ?? DEFAULT_CHART_PERIOD,
    );
  }
  // The other widgets share the page they were built from: each already has a
  // social card of its own (/top, /statistics, /industry-intelligence).
  const snippet = buildEmbedSnippet(target);
  const headline =
    snippet.deepLinkAnchor.charAt(0).toUpperCase() +
    snippet.deepLinkAnchor.slice(1);
  return {
    url: snippet.deepLink,
    headline,
    socialHeadline: headline,
    source: snippet.source,
    imageUrl: null,
    imageFileName: null,
    imageAlt: headline,
  };
}

function intentUrl(base: string, params: Record<string, string>): string {
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}?${q}`;
}

/** Share copy for one widget, for every channel. */
export function buildShareKit(target: EmbedTarget): ShareKit {
  const s = subjectFor(target);
  const credit = `Data from ${siteConfig.name}, sourced from ${s.source}.`;
  const xText = `${s.socialHeadline}, from ${s.source}`;

  const markdown = s.imageUrl
    ? `[![${s.imageAlt}](${s.imageUrl})](${s.url})\n\n[${s.headline}](${s.url}) · data from [Shorted.com.au](${siteConfig.url}), sourced from ${s.source}`
    : `[${s.headline}](${s.url}) · data from [Shorted.com.au](${siteConfig.url}), sourced from ${s.source}`;

  const channels: ShareChannel[] = [
    {
      id: "discord",
      label: "Discord",
      hint: "Paste into a channel or DM. Discord turns the link into a card with the chart.",
      text: `**${s.headline}**\n${s.url}`,
    },
    {
      id: "slack",
      label: "Slack",
      hint: "Paste into a message. Slack unfurls the link into a preview.",
      text: `${s.headline}: ${s.url}`,
    },
    {
      id: "x",
      label: "X",
      hint: "Opens a prefilled post. X shows the link as a card with the chart.",
      text: `${xText}\n${s.url}`,
      intent: {
        label: "Post on X",
        href: intentUrl("https://x.com/intent/tweet", {
          text: xText,
          url: s.url,
          via: "shorted___",
        }),
      },
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      hint: "Paste as a post, or share the link straight to LinkedIn. It adds the preview card.",
      text: `${s.socialHeadline}.\n\n${credit}\n\n${s.url}`,
      intent: {
        label: "Share on LinkedIn",
        href: intentUrl("https://www.linkedin.com/sharing/share-offsite/", {
          url: s.url,
        }),
      },
    },
    {
      id: "reddit",
      label: "Reddit",
      hint: "Submit it as a link post, or paste the Markdown link into a comment.",
      text: `[${s.socialHeadline}](${s.url})`,
      code: true,
      intent: {
        label: "Post to Reddit",
        href: intentUrl("https://www.reddit.com/submit", {
          url: s.url,
          title: s.socialHeadline,
        }),
      },
    },
    {
      id: "markdown",
      label: "Markdown",
      hint: s.imageUrl
        ? "For GitHub, Notion, Obsidian and forums that render Markdown. The image is the latest snapshot and links to the live chart."
        : "For GitHub, Notion, Obsidian and forums that render Markdown.",
      text: markdown,
      code: true,
    },
    {
      id: "website",
      label: "Website",
      hint: "For a blog, CMS or any page that accepts HTML. The chart stays live and updates daily. Please keep the credit line.",
      text: buildEmbedSnippet(target).html,
      code: true,
    },
  ];

  return {
    url: s.url,
    headline: s.headline,
    imageUrl: s.imageUrl,
    imageFileName: s.imageFileName,
    channels,
  };
}
