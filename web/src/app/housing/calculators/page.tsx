import type { Metadata } from "next";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { getHousingOverview } from "~/app/actions/getHousing";
import {
  DepositCalculator,
  MortgageSimulator,
  StampDutyCalculator,
} from "@/components/housing/calculators/calculators";
import { isStampDutyState, type StampDutyState } from "@/lib/housing/stamp-duty";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingIcon } from "@/components/housing/housing-icon";

const URL = "https://shorted.com.au/housing/calculators";
const TITLE = "Home Loan & Deposit Calculators — Australian House Prices";
const DESCRIPTION =
  "Free Australian mortgage, deposit and stamp-duty calculators — simulate repayments with extra payments and an offset, see rate-shock scenarios, work out years to a deposit, and estimate transfer duty in every state.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "mortgage repayment calculator Australia",
    "stamp duty calculator by state",
    "home deposit savings calculator",
    "offset account calculator",
    "extra repayments calculator",
  ],
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, creator: "@shorted___" },
};

const PRICE_MIN = 100_000;
const PRICE_MAX = 5_000_000;

function parsePrice(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(PRICE_MAX, Math.max(PRICE_MIN, Math.round(n / 1000) * 1000));
}

function parseState(raw: string | undefined): StampDutyState {
  const up = (raw ?? "").toUpperCase();
  return isStampDutyState(up) ? up : "NSW";
}

interface PageProps {
  searchParams: Promise<{ price?: string; state?: string }>;
}

export default async function HousingCalculatorsPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  // Live default: the national mean dwelling price from the ABS-fed tracker.
  const overview = await getHousingOverview("");
  const national = overview?.metrics?.find(
    (m) => m.regionCode === "AUS" && m.measure === "mean_price",
  );
  const liveDefault = national?.value
    ? Math.round(national.value / 10_000) * 10_000
    : 1_000_000;

  const price = parsePrice(sp.price, liveDefault);
  const state = parseState(sp.state);
  const prefilled = Boolean(sp.price);
  const initialLoan = Math.min(3_000_000, Math.max(50_000, Math.round((price * 0.8) / 10_000) * 10_000));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: TITLE,
    description: DESCRIPTION,
    url: URL,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "AUD" },
  };

  return (
    <DashboardLayout>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="ABS (defaults), state revenue offices (duty schedules)"
        dataFrequency="quarterly"
        keywords={["mortgage calculator", "stamp duty", "home deposit", "Australia"]}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <header>
          <h1 className="flex items-center gap-3 font-serif text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            <HousingIcon name="mortgage" size={36} /> Home loan calculators
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Three calculators for Australian buyers: simulate mortgage
            repayments (with extra payments, a lump sum and an offset account),
            work out how long a deposit will take to save, and estimate stamp
            duty in every state and territory.
            {prefilled ? (
              <> Prefilled with a median price of{" "}
                <span className="font-mono text-foreground">${price.toLocaleString("en-AU")}</span>
                {sp.state ? <> in {state}</> : null} from the suburb you came from.</>
            ) : (
              <> Defaults start from the national mean dwelling price tracked on our{" "}
                <a href="/housing" className="text-foreground underline underline-offset-2 hover:text-primary">house-prices dashboard</a>.</>
            )}
          </p>
        </header>

        <MortgageSimulator initialLoan={initialLoan} />
        <DepositCalculator initialPrice={price} initialState={state} />
        <StampDutyCalculator initialPrice={price} initialState={state} />

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Estimates only, not financial advice; excludes LMI, fees; verify duty
          with your state revenue office. Duty schedules baked from the 2025–26
          general rates; thresholds in some states are indexed annually.
        </p>
      </div>
    </DashboardLayout>
  );
}
