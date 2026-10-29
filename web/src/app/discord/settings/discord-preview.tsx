"use client";

/* eslint-disable @next/next/no-img-element */
import { useState, type CSSProperties } from "react";
import { CornerUpRight, ExternalLink } from "lucide-react";

import { siteConfig } from "~/@/config/site";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ActionRow,
  type MessagePayload,
} from "~/@/lib/discord/api";
import { cn } from "~/@/lib/utils";

/**
 * A Discord message drawn the way Discord's dark theme draws it, from the
 * payload the bot would send (messages.ts). The preview is the message, not a
 * picture of one: the title, readings, fields, chart card, footer and buttons
 * all come from the same builder the bot posts with.
 *
 * Its colours are Discord's, not the site's, because it is a picture of
 * Discord. Nothing in it is a control: the buttons are drawn, not wired, and
 * the whole message is one labelled figure for assistive technology.
 */

const SAMPLE_TIME = "Today";

/** Discord's own face, for the one place the site draws Discord. */
export const DISCORD_FONT: CSSProperties = {
  fontFamily:
    '"gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
};

const BUTTON_FILL: Record<number, string> = {
  [ButtonStyle.PRIMARY]: "bg-[#5865f2]",
  [ButtonStyle.SECONDARY]: "bg-[#4e5058]",
  [ButtonStyle.SUCCESS]: "bg-[#248046]",
  [ButtonStyle.DANGER]: "bg-[#da373c]",
  [ButtonStyle.LINK]: "bg-[#4e5058]",
};

/**
 * The image as this deployment serves it: the payload points at
 * shorted.com.au, and a preview on a branch deploy or localhost should draw
 * that branch's card.
 */
export function localImageUrl(url: string): string {
  if (!url.startsWith(siteConfig.url)) return url;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/** The two inline forms the bot writes: **bold** and `code`. */
export function DiscordMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold text-[#f2f3f5]">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={i}
              className="rounded-[3px] bg-[#1e1f22] px-1 py-px font-mono text-[0.85em]"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function ChartCard({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  return (
    <div className="relative mt-3 aspect-[1200/630] w-full overflow-hidden rounded bg-[#1e1f22]">
      {state !== "failed" && (
        <img
          // A new card is a new image: without the key the old card stays up,
          // marked ready, while the next one loads.
          key={src}
          src={src}
          alt={alt}
          width={1200}
          height={630}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-200",
            state === "ready" ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {state === "loading" && (
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-[#1e1f22]"
        />
      )}
      {state === "failed" && (
        <p className="absolute inset-0 grid place-items-center text-sm text-[#949ba4]">
          The chart card could not be drawn just now.
        </p>
      )}
    </div>
  );
}

function Buttons({ rows }: { rows: ActionRow[] }) {
  return (
    <div className="mt-2 space-y-2">
      {rows.map((row, r) => (
        <div key={r} className="flex flex-wrap gap-2">
          {row.components.map((component, c) =>
            component.type === ComponentType.BUTTON ? (
              <span
                key={c}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-[3px] px-4 text-sm font-medium text-white",
                  BUTTON_FILL[component.style] ??
                    BUTTON_FILL[ButtonStyle.SECONDARY],
                )}
              >
                {component.label}
                {component.style === ButtonStyle.LINK && (
                  <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                )}
              </span>
            ) : null,
          )}
        </div>
      ))}
    </div>
  );
}

export interface DiscordMessageProps {
  /** What the person typed, shown above the reply as Discord does. */
  command: string;
  payload: MessagePayload;
  className?: string;
}

/** One reply from the bot, as Discord's dark theme draws it. */
export function DiscordMessage({
  command,
  payload,
  className,
}: DiscordMessageProps) {
  const embed = payload.embeds?.[0];
  const rows = payload.components ?? [];
  const ephemeral = ((payload.flags ?? 0) & MessageFlags.EPHEMERAL) !== 0;
  const color =
    embed?.color !== undefined
      ? `#${embed.color.toString(16).padStart(6, "0")}`
      : undefined;

  return (
    <div
      style={DISCORD_FONT}
      className={cn(
        "px-4 py-3 text-[15px] leading-[1.375] text-[#dbdee1]",
        ephemeral && "bg-[#5865f2]/[0.08]",
        className,
      )}
    >
      <p className="mb-1 flex items-center gap-1 pl-[52px] text-[13px] text-[#949ba4]">
        <CornerUpRight aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium text-[#c4c9ce]">you</span> used
        <span className="text-[#00a8fc]">{command}</span>
      </p>
      <div className="flex gap-3">
        <img
          src="/icon-192.png"
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 shrink-0 rounded-full bg-[#1e1f22]"
        />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-medium text-[#f2f3f5]">Shorted</span>
            <span className="rounded-[3px] bg-[#5865f2] px-1 text-[10px] font-semibold leading-4 text-white">
              APP
            </span>
            <span className="text-xs text-[#949ba4]">{SAMPLE_TIME}</span>
          </p>

          {payload.content && (
            <p className="mt-0.5 break-words">
              <DiscordMarkdown text={payload.content} />
            </p>
          )}

          {embed && (
            <div
              className="mt-1 max-w-[520px] rounded border-l-4 bg-[#2b2d31] py-2.5 pl-3 pr-4"
              style={color ? { borderLeftColor: color } : undefined}
            >
              {embed.title && (
                <p className="font-semibold text-[#00a8fc]">{embed.title}</p>
              )}
              {embed.description && (
                <p className="mt-1 text-sm">
                  <DiscordMarkdown text={embed.description} />
                </p>
              )}
              {embed.fields && embed.fields.length > 0 && (
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                  {embed.fields.map((field) => (
                    <div key={field.name} className="min-w-0">
                      <dt className="font-semibold text-[#f2f3f5]">
                        {field.name}
                      </dt>
                      <dd className="break-words">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {embed.image && (
                <ChartCard
                  src={localImageUrl(embed.image.url)}
                  alt={`The chart card the bot posts for ${embed.title ?? "the stock"}`}
                />
              )}
              {embed.footer && (
                <p className="mt-2 text-xs text-[#b5bac1]">
                  {embed.footer.text}
                </p>
              )}
            </div>
          )}

          {rows.length > 0 && <Buttons rows={rows} />}

          {ephemeral && (
            <p className="mt-1 text-xs text-[#949ba4]">Only you can see this</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The interactive chart as Discord opens it: the Activity page itself, framed
 * like Discord's Activity window. Off Discord the page skips the handshake and
 * draws the chart it is given, so this is what the command opens.
 */
export function DiscordActivityFrame({
  src,
  title,
}: {
  src: string;
  title: string;
}) {
  return (
    <div
      style={DISCORD_FONT}
      className="overflow-hidden rounded-md border border-[#1e1f22] bg-[#1e1f22]"
    >
      <p className="flex items-center gap-2 bg-[#2b2d31] px-3 py-2 text-[13px] font-medium text-[#f2f3f5]">
        <img
          src="/icon-192.png"
          alt=""
          width={16}
          height={16}
          className="h-4 w-4 rounded-sm"
        />
        Shorted
        <span className="font-normal text-[#949ba4]">Activity</span>
      </p>
      <iframe
        key={src}
        src={src}
        title={title}
        loading="lazy"
        className="block h-[440px] w-full border-0 bg-[#0d0d0d]"
      />
    </div>
  );
}
