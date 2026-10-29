import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { withTimeout } from "~/app/chart/[code]/image/chart-data";
import { discordActivityEnabled } from "~/@/lib/discord/config";
import { discordData } from "~/@/lib/discord/data";
import { resolveSettings } from "~/@/lib/discord/settings";
import {
  SETTINGS_COOKIE,
  readSettingsGrant,
} from "~/@/lib/discord/settings-link";
import { firestoreSettingsStore } from "~/@/lib/discord/settings-store";
import { eyebrow, lede, pageTitle } from "~/@/lib/typography";
import { DiscordSettingsForm } from "./settings-form";

/**
 * Where `/settings` sends people to change how the bot opens charts, for a
 * server or for themselves (docs/discord-bot.md, "Settings").
 *
 * Who may change what was decided in Discord: the link carries a signed grant
 * for one scope, moved into a cookie by open/route.ts, and the page and its
 * actions read the grant from there. There is no sign-in here.
 *
 * DYNAMIC and NOINDEX: it reads a cookie and one scope's stored settings, and
 * is not content.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Discord settings",
  robots: { index: false, follow: false },
};

/** How long the page waits for the default stock's name before going without. */
const NAME_TIMEOUT_MS = 2500;

type SearchParams = Record<string, string | string[] | undefined>;

function LinkNeeded({ expired }: { expired: boolean }) {
  return (
    <main className="min-h-[70vh]">
      <div className="container mx-auto max-w-xl px-4 py-16">
        <p className={eyebrow}>Shorted for Discord</p>
        <h1 className={pageTitle}>
          {expired ? "This link has expired" : "Open this page from Discord"}
        </h1>
        <p className={lede}>
          Run <code>/settings</code> in Discord. It answers with a link that
          only you can see, and the link opens your settings here for 30
          minutes.
        </p>
        <ul className="mt-6 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            In a server you manage, it changes the server&apos;s settings, for
            everyone in it.
          </li>
          <li>
            Anywhere else, or with <code>for:Just me</code>, it changes your
            own: for DMs, and for servers that have not set theirs.
          </li>
        </ul>
        <p className="mt-8 text-sm">
          <Link
            href="/docs/discord#settings"
            className="text-primary underline-offset-4 hover:underline"
          >
            How settings work
          </Link>
        </p>
      </div>
    </main>
  );
}

export default async function DiscordSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const grant = readSettingsGrant(cookies().get(SETTINGS_COOKIE)?.value);
  if (!grant) return <LinkNeeded expired={params.link === "expired"} />;

  // Fresh: this page edits what is stored, so it never shows a minute-old copy.
  const stored = await firestoreSettingsStore.get(grant.scope, { fresh: true });
  const settings = resolveSettings(stored);
  const summary = settings.code
    ? await withTimeout(
        discordData.stockSummary(settings.code),
        NAME_TIMEOUT_MS,
        null,
      )
    : null;
  const guild = grant.scope.kind === "guild";

  return (
    <main className="min-h-screen">
      <div className="container mx-auto max-w-6xl px-4 py-8 sm:py-12">
        <header className="mb-10 max-w-2xl">
          <p className={eyebrow}>Shorted for Discord</p>
          <h1 className={pageTitle}>
            {guild ? "Settings for this server" : "Your settings"}
          </h1>
          <p className={lede}>
            {guild
              ? "How the bot opens charts for everyone in the server: the stock it starts on, the chart and period, and whether a command posts a message or opens the interactive chart."
              : "How the bot opens charts for you: the stock it starts on, the chart and period, and whether a command posts a message or opens the interactive chart."}
            {stored ? "" : " Nothing is set yet, so these are the defaults."}
          </p>
        </header>
        <DiscordSettingsForm
          scope={grant.scope.kind}
          initial={settings}
          initialName={summary?.name}
          expiresAt={grant.expiresAt}
          activityEnabled={discordActivityEnabled()}
        />
      </div>
    </main>
  );
}
