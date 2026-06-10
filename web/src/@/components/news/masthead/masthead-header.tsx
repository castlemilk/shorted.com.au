/**
 * MastheadHeader — classic newspaper masthead for the /news front page.
 *
 * Top hairline, section wordmark in the serif display face, today's date,
 * then the traditional double rule (thick amber over thin border).
 *
 * Server component. The date is rendered at build/revalidate time which is
 * acceptable — the page revalidates every 10 minutes.
 */
export function MastheadHeader() {
  const today = new Date().toLocaleDateString("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <header>
      {/* Top hairline rule */}
      <div className="border-t border-border" aria-hidden />

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1 py-4">
        <h1 className="font-serif text-3xl tracking-tight md:text-4xl">
          Shorted <span className="italic text-primary">Newsroom</span>
        </h1>
        <p className="pb-1 text-xs text-muted-foreground md:text-sm">
          {today}
        </p>
      </div>

      {/* Classic masthead double rule: 2px amber over 1px hairline */}
      <div className="h-0.5 bg-primary" aria-hidden />
      <div className="mt-[3px] border-t border-border" aria-hidden />
    </header>
  );
}
