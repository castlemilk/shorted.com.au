/* eslint-disable @next/next/no-img-element */
import { type Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "~/@/components/ui/button";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { siteConfig } from "~/@/config/site";
import { COMMANDS } from "~/@/lib/discord/commands";
import {
  discordActivityEnabled,
  discordApplicationId,
} from "~/@/lib/discord/config";
import { chartCardUrl } from "~/@/lib/discord/messages";
import { installLinks } from "~/@/lib/discord/setup";
import { eyebrow, lede, pageTitle, sectionTitle } from "~/@/lib/typography";
import { cn } from "~/@/lib/utils";

const URL = `${siteConfig.url}/docs/discord`;
const TITLE = "Shorted for Discord: ASX short interest charts in your server";
const DESCRIPTION =
  "Add the Shorted app to Discord to search ASX stocks, post short interest and share price charts, and flip their period and view in place. Free, read-only, no bot permissions.";

/** The example on the page: what `/chart BHP view:combined period:6m` posts. */
const EXAMPLE = chartCardUrl(
  { code: "BHP", view: "combined", period: "6m" },
  new Date(),
);

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: URL,
    siteName: siteConfig.name,
    type: "article",
    locale: "en_AU",
    images: [{ url: EXAMPLE, width: 1200, height: 630 }],
  },
  twitter: {
    site: "@shorted___",
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [EXAMPLE],
  },
};

type Option = { name: string; required?: boolean };

/** `/chart <code> [view] [period]`, from the registered command itself. */
function usage(name: string, options: unknown): string {
  const args = ((options ?? []) as Option[]).map((o) =>
    o.required ? `<${o.name}>` : `[${o.name}]`,
  );
  return [`/${name}`, ...args].join(" ");
}

/**
 * The public onboarding page for the Discord app: how to add it, what each
 * command posts, and what it can and cannot see. The commands are rendered
 * from the list the bot registers (lib/discord/commands.ts), and the install
 * links from the committed app (src/config/discord-app.json), so the page
 * cannot describe a command the bot lacks or link to an app that is not set
 * up. Operator setup lives in docs/discord-bot.md.
 */
export default function DiscordDocsPage() {
  const applicationId = discordApplicationId();
  const links = applicationId ? installLinks(applicationId) : null;
  const activity = discordActivityEnabled();
  const crumbs = [{ label: "Discord", href: "/docs/discord" }];

  return (
    <main className="min-h-screen">
      <BreadcrumbStructuredData items={crumbs} />
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <Breadcrumbs items={crumbs} />
        </div>

        <article className="prose prose-neutral max-w-none dark:prose-invert prose-h3:text-base prose-h3:font-semibold prose-code:before:content-none prose-code:after:content-none">
          <p className={eyebrow}>Integrations</p>
          <h1 className={pageTitle}>Shorted for Discord</h1>
          <p className={lede}>
            Search ASX stocks, post a stock&apos;s short interest with its
            chart, and change the chart in place, without leaving the chat.
          </p>

          <section aria-labelledby="add" className="not-prose mt-8">
            <h2 id="add" className={sectionTitle}>
              Add it
            </h2>
            {links ? (
              <>
                <p className="mt-3 text-muted-foreground">
                  Add it to a server you manage, or to your own account to use
                  it anywhere (including servers that allow external apps).
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <a
                    href={links.server}
                    className={buttonVariants({ size: "lg" })}
                    rel="noopener"
                  >
                    Add to a server
                  </a>
                  <a
                    href={links.user}
                    className={buttonVariants({
                      size: "lg",
                      variant: "outline",
                    })}
                    rel="noopener"
                  >
                    Add to my apps
                  </a>
                </div>
              </>
            ) : (
              <p className="mt-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                The Discord app is being set up. The links to add it will appear
                here as soon as it is live.
              </p>
            )}
            <p className="mt-3 text-sm text-muted-foreground">
              It asks for one permission: to add its slash commands. It cannot
              read messages, and it posts only when someone uses it.
            </p>
          </section>

          <h2 className={cn(sectionTitle, "mt-12")}>First steps</h2>
          <ol>
            <li>
              Type <code>/stock</code> and start typing a code or a company
              name. Suggestions appear as you type; with nothing typed, it
              offers the most shorted stocks.
            </li>
            <li>
              Pick one. Shorted posts the stock&apos;s short interest, its
              30-day change and its chart.
            </li>
            <li>
              Press the buttons under the chart to change the period (1M to Max)
              or the view (short interest, price, or both). The message redraws
              in place, for everyone in the channel.
            </li>
            <li>
              Try <code>/top</code> for the most shorted ASX stocks, then pick
              one from its menu to chart it.
            </li>
          </ol>

          <figure className="not-prose mt-8">
            <img
              src={EXAMPLE}
              width={1200}
              height={630}
              loading="lazy"
              alt="A Shorted chart card for BHP: share price and short interest over the past six months, with the latest readings above the chart."
              className="h-auto w-full rounded-lg border"
            />
            <figcaption className="mt-2 text-sm text-muted-foreground">
              The chart a message carries, here for{" "}
              <code>/chart BHP view:combined period:6m</code>. It is the same
              card as the site&apos;s share links, drawn from the latest data.
            </figcaption>
          </figure>

          <h2 className={cn(sectionTitle, "mt-12")}>Commands</h2>
          <div className="not-prose mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Command
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    What it does
                  </th>
                </tr>
              </thead>
              <tbody>
                {COMMANDS.map((command) => (
                  <tr key={command.name} className="border-b last:border-0">
                    <td className="w-2/5 py-2 pr-4 align-top font-mono sm:w-auto sm:whitespace-nowrap">
                      {usage(command.name, command.options)}
                    </td>
                    <td className="py-2 align-top">
                      {command.description as string}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className={cn(sectionTitle, "mt-12")}>The buttons</h2>
          <ul>
            <li>
              <strong>Periods and views</strong> redraw the chart. The
              highlighted one is what is on screen; pressing it again redraws
              with the latest figures.
            </li>
            <li>
              <strong>Open on Shorted</strong> opens the full interactive chart
              on the site. On a phone held upright it opens turned sideways,
              because Discord&apos;s browser does not rotate; the button beside
              the periods turns it back.
            </li>
            {activity && (
              <li>
                <strong>Interactive</strong> opens that chart inside Discord,
                where you can scrub across it, pin readings, measure between two
                dates and switch stocks.
              </li>
            )}
          </ul>

          <h2 id="settings" className={cn(sectionTitle, "mt-12 scroll-mt-24")}>
            Settings
          </h2>
          <p>
            <code>/settings</code> chooses how the bot opens charts: a default
            stock (so <code>/stock</code> and <code>/chart</code> work with
            nothing typed), the chart (short interest, price or both), the
            period, and whether a command posts a chart message or
            {activity
              ? " opens the interactive chart inside Discord."
              : " opens the interactive chart, once that is switched on."}
          </p>
          <ul>
            <li>
              In a server where you have the Manage Server permission, it
              changes the server&apos;s settings, for everyone in it.
            </li>
            <li>
              Anywhere else, or with <code>for:Just me</code>, it changes your
              own: they apply in DMs, and in servers that have not set theirs.
            </li>
            <li>
              It answers privately with a link to a page where you pick the
              settings and see the chart they make. The link works for 30
              minutes, for whoever has it, so keep it to yourself.
            </li>
            <li>
              Anything typed in a command still wins:{" "}
              <code>/chart BHP view:price</code> is BHP&apos;s price whatever is
              set.
            </li>
          </ul>

          <h2 className={cn(sectionTitle, "mt-12")}>
            What it can see, and what it posts
          </h2>
          <ul>
            <li>
              It answers slash commands, autocomplete and its own buttons.
              Nothing else reaches it: no messages, no member list, no voice.
            </li>
            <li>
              A lookup that fails, or a search with no match, is answered
              privately, to the person who asked. Its messages never ping
              anyone.
            </li>
            <li>
              The figures are public data: ASIC&apos;s daily short position
              reports (published with a four trading-day delay) and end-of-day
              ASX prices. See the <Link href="/methodology">methodology</Link>.
            </li>
            <li>It is free, and it is information, not financial advice.</li>
          </ul>

          <h2 className={cn(sectionTitle, "mt-12")}>Questions</h2>
          <h3>The commands do not show up in my server</h3>
          <p>
            If you added Shorted to your own account, the server has to allow
            external apps (Server Settings, Integrations). Otherwise, ask
            someone who manages the server to add it with{" "}
            <em>Add to a server</em>.
          </p>
          <h3>Why is the short position a few days old?</h3>
          <p>
            ASIC publishes short positions four trading days after the date they
            describe. Each message dates its figures by the report they come
            from, not by the day you ask.
          </p>
          <h3>Can it watch a stock and tell me when it changes?</h3>
          <p>
            Not in Discord yet. The site has{" "}
            <Link href="/alerts">short position alerts</Link>.
          </p>
        </article>
      </div>
    </main>
  );
}
