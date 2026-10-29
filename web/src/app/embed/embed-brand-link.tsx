"use client";

import { usePathname } from "next/navigation";

import { DISCORD_ACTIVITY_PATH } from "~/config/discord-activity.mjs";

/**
 * The credit every embed carries in its corner, except the Discord Activity.
 * There it has its own way out (through Discord's SDK), and a plain link is
 * worse than nothing: Discord's mobile webview can follow it in place and load
 * the whole site, header and footer included, inside the Activity (reported
 * 2026-10-29).
 */
export function EmbedBrandLink() {
  const pathname = usePathname();
  if (pathname?.startsWith(DISCORD_ACTIVITY_PATH)) return null;
  return (
    <div className="fixed bottom-1 right-2 z-50">
      <a
        href="https://shorted.com.au"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[10px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      >
        shorted.com.au
      </a>
    </div>
  );
}
