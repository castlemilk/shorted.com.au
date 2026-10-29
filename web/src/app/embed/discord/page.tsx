"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { activityLaunchState } from "~/@/lib/discord/activity";

const fallback = (
  <div className="h-[100dvh] w-full p-2">
    <div className="h-full w-full animate-pulse rounded bg-muted" />
  </div>
);

const DiscordActivity = dynamic(
  () =>
    import("~/@/components/discord/discord-activity").then(
      (m) => m.DiscordActivity,
    ),
  { ssr: false, loading: () => fallback },
);

function DiscordActivityInner() {
  const launch = activityLaunchState(useSearchParams());
  return (
    <div className="h-[100dvh] w-full overflow-auto">
      <DiscordActivity launch={launch} />
    </div>
  );
}

/**
 * The Discord Activity (docs/discord-bot.md). Discord loads the site root
 * through its proxy, and the redirect in src/config/discord-activity.mjs
 * brings that request here with its launch parameters. Under /embed/ so it
 * may be framed (next.config.mjs) and is kept out of search (robots.txt and
 * the embed layout's noindex).
 *
 *   /embed/discord?custom_id=activity:BHP:combined:6m   as a button launches it
 *   /embed/discord?code=BHP&view=price                  to try it in a browser
 */
export default function DiscordActivityPage() {
  return (
    <Suspense fallback={fallback}>
      <DiscordActivityInner />
    </Suspense>
  );
}
