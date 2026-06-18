"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

const BankShortBasket = dynamic(
  () =>
    import("~/@/components/news/mdx/bank-short-basket").then(
      (m) => m.BankShortBasket,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[420px] w-full animate-pulse rounded bg-muted" />
    ),
  },
);

const ShortBasket = dynamic(
  () => import("~/@/components/news/mdx/short-basket").then((m) => m.ShortBasket),
  {
    ssr: false,
    loading: () => (
      <div className="h-[420px] w-full animate-pulse rounded bg-muted" />
    ),
  },
);

type Win = "3m" | "6m" | "1y";
type Mode = "dollar" | "percent";

function EmbedInner() {
  const sp = useSearchParams();
  const rawWin = sp.get("window");
  const win: Win = rawWin === "3m" || rawWin === "6m" || rawWin === "1y" ? rawWin : "1y";
  const mode: Mode = sp.get("mode") === "percent" ? "percent" : "dollar";
  const title = sp.get("title") ?? undefined;
  // A `basket` key renders any registered sector (banks/lithium/ironore) via the
  // generic ShortBasket; otherwise the legacy `banks` codes path is used.
  const basket = sp.get("basket");
  const banks = sp.get("banks")?.toUpperCase() ?? "CBA,WBC,NAB,ANZ";

  return (
    <div className="p-2">
      {basket ? (
        <ShortBasket basket={basket} window={win} mode={mode} title={title} />
      ) : (
        <BankShortBasket banks={banks} window={win} mode={mode} title={title} />
      )}
    </div>
  );
}

/**
 * Embeddable short-basket widget — reuses the editorial MDX components against
 * the baked series (no backend dependency).
 * Usage: <iframe src="https://shorted.com.au/embed/bank-basket?basket=lithium" />
 */
export default function EmbedBankBasket() {
  return (
    <Suspense
      fallback={
        <div className="h-[420px] w-full animate-pulse rounded bg-muted" />
      }
    >
      <EmbedInner />
    </Suspense>
  );
}
