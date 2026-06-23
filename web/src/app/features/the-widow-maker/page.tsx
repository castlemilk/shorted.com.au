import type { Metadata } from "next";
import Link from "next/link";

import { Hero } from "@/components/features/housing/hero";
import { Section } from "@/components/features/housing/section";
import { StatStrip } from "@/components/features/housing/stat-strip";
import { PullQuote } from "@/components/features/housing/pull-quote";
import { Cite } from "@/components/features/housing/cite";
import { FeatureChartFrame } from "@/components/features/housing/feature-chart-frame";
import { SourcesList } from "@/components/features/housing/sources-list";
import { ScrollReveal } from "@/components/features/housing/scroll-reveal";
import {
  BANK_POWER_STATS,
  NEGATIVE_GEARING_STATS,
} from "@/components/features/housing/data/stats";
import {
  BankShortBasket,
  BorrowingPowerSlider,
  BuyingPowerChart,
  InternationalCorrectionsChart,
  PolicyPriceChart,
} from "@/components/features/housing/dashboards";
import { LLMMeta } from "@/components/seo/llm-meta";

const URL = "https://shorted.com.au/features/the-widow-maker";
const TITLE = "The Widow-Maker: why betting against Australian housing keeps failing";
const DESCRIPTION =
  "How negative gearing, the 1999 CGT discount and the buying power of Australia's big four banks built an unkillable housing market — and what Japan, China and the US reveal about the day it breaks. With live data and interactive dashboards.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "Australian housing market",
    "shorting Australian banks",
    "negative gearing",
    "capital gains tax discount",
    "house prices Australia",
    "household debt",
    "housing bubble",
    "CBA short",
    "Japan property crash",
    "China Evergrande",
  ],
  authors: [{ name: "The Shorted Desk" }],
  alternates: { canonical: URL },
  openGraph: {
    type: "article",
    url: URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Shorted",
    locale: "en_AU",
    publishedTime: "2026-06-23T00:00:00.000Z",
    authors: ["The Shorted Desk"],
  },
  twitter: {
    card: "summary_large_image",
    title: "The Widow-Maker: why shorting Australian housing keeps failing",
    description: DESCRIPTION,
    creator: "@shorted___",
  },
};

const PARA =
  "mt-5 font-serif text-lg leading-relaxed text-foreground/90 sm:text-[1.2rem]";

const articleSchema = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: TITLE,
  description: DESCRIPTION,
  datePublished: "2026-06-23",
  dateModified: "2026-06-23",
  inLanguage: "en-AU",
  author: { "@type": "Organization", name: "The Shorted Desk", url: "https://shorted.com.au" },
  publisher: {
    "@type": "Organization",
    name: "Shorted",
    url: "https://shorted.com.au",
  },
  mainEntityOfPage: { "@type": "WebPage", "@id": URL },
  about: [
    "Australian housing market",
    "Short selling of Australian banks",
    "Negative gearing and capital gains tax",
  ],
};

export default function WidowMakerFeature() {
  return (
    <article className="bg-background">
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="ASIC, RBA, ABS, ATO, APRA, BIS, OECD"
        dataFrequency="periodic"
        lastUpdated="2026-06-23"
        keywords={[
          "Australian housing market",
          "shorting Australian banks",
          "negative gearing",
          "CGT discount",
        ]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />

      <Hero />

      <div className="mx-auto max-w-3xl px-5 pb-24 pt-6 sm:px-6">
        {/* ── Lede ───────────────────────────────────────────────────── */}
        <p
          className={`${PARA} mt-8 first-letter:float-left first-letter:mr-3 first-letter:font-serif first-letter:text-6xl first-letter:font-medium first-letter:leading-[0.7] first-letter:text-primary`}
        >
          You cannot short a house in Parramatta. So when the world&rsquo;s hedge
          funds decided Australian property was the biggest bubble they had ever
          seen, they did the next best thing: they shorted the four banks that
          wrote the mortgages.<Cite id="atlas-widowmaker" /> For a decade, that
          bet has destroyed the people who placed it.
        </p>
        <p className={PARA}>
          They were not stupid. They were, by most measures, right about the
          danger &mdash; household debt among the highest in the world, prices
          long detached from incomes, an economy leaning on real estate like a
          drunk on a lamppost. They were simply early, which in markets is the
          same thing as wrong. This is the story of the machine that kept proving
          them wrong &mdash; and of the three countries that show what happens
          when it finally breaks.
        </p>

        {/* ── I ──────────────────────────────────────────────────────── */}
        <Section numeral="I" kicker="The trade" title="The bet that bankrupts the brave">
          <p className={PARA}>
            In February 2016, Jonathan Tepper of Variant Perception and John
            Hempton of Bronte Capital toured Sydney&rsquo;s mortgage-broker belt
            undercover. Brokers, they said, coached them to lie on loan
            applications; banks &ldquo;rarely verified payslips.&rdquo; Tepper
            came home and declared &ldquo;one of the biggest housing bubbles in
            history,&rdquo; tipped falls of 30&ndash;50% in Sydney and Melbourne,
            and told clients to short the big four.<Cite id="wolfstreet-2016" />
            <Cite id="fortune-2016" /> Bronte started shorting that month.
          </p>
          <p className={PARA}>
            By mid-2016 the trade was crowded &mdash; about A$6.5bn of shorts
            across the four banks.<Cite id="wolfstreet-2016" /> The logic was
            clean. The execution was a bloodbath.
          </p>

          <PullQuote attribution="Jonathan Tepper, Variant Perception, February 2016">
            &ldquo;Australia now has one of the biggest housing bubbles in
            history. We witnessed a mania in all its crazy excess.&rdquo;
          </PullQuote>

          <p className={PARA}>
            Here is why it bled. A short-seller has to pay the banks&rsquo; fat,
            fully-franked dividends to whoever lent them the stock. The banks
            spent roughly A$7bn buying back their own shares.<Cite id="atlas-widowmaker" />{" "}
            And Commonwealth Bank simply went up &mdash; from A$5.40 at its 1991
            float to about A$192 by mid-2025.<Cite id="fool-cba-2025" /> A
            correction that never comes is the most expensive thing in finance.
            The trade earned a nickname borrowed from the traders who spent
            decades shorting Japanese bonds: the widow-maker.
          </p>
          <p className={PARA}>
            One myth is worth killing first. Steve Eisman, the investor made
            famous by <em>The Big Short</em>, never shorted Australian banks. His
            2019 bet was on Canada.<Cite id="bloomberg-eisman-2019" /> The
            Australian short was its own home-grown obsession.
          </p>

          <ScrollReveal>
            <FeatureChartFrame
              eyebrow="Dashboard ① · live ASIC data"
              title="The bet, in real time"
              subtitle="Combined short position across CBA, Westpac, NAB and ANZ — dollar value and percentage of issue, straight from ASIC. Toggle $ ↔ % and the window."
              note="By June 2026 the aggregate big-four short hit a record ~A$11bn — the largest since ASIC reporting began."
              sourceIds={["hedgeweek-11bn-2026"]}
            >
              <BankShortBasket window="1y" mode="dollar" title="Big four bank short positions" />
            </FeatureChartFrame>
          </ScrollReveal>

          <p className={PARA}>
            By June 2026 the short was bigger than it had ever been &mdash; a
            record ~A$11bn, roughly double in six months.<Cite id="hedgeweek-11bn-2026" />{" "}
            And in May, for the first time in years, it bit: CBA fell 10.4% in a
            single session on 13 May 2026, its worst day in 34 years of listing.
            <Cite id="ibtimes-cba-2026" /> Whether that is the reckoning or
            another false alarm depends on the machine we are about to take apart.
          </p>
        </Section>

        {/* ── II ─────────────────────────────────────────────────────── */}
        <Section numeral="II" kicker="The first prop" title="A tax code that pays you to lose money">
          <p className={PARA}>
            Start with the tax code. Negative gearing lets an investor deduct the
            losses on a rental &mdash; when the rent doesn&rsquo;t cover the
            interest and costs &mdash; against their <em>wage</em> income. Most
            countries ring-fence rental losses against rental income. Australia
            lets you write them straight off your salary.
          </p>
          <p className={PARA}>
            The scale is enormous. In 2022&ndash;23, 1.12&nbsp;million Australians
            &mdash; 49% of all property investors &mdash; ran their rentals at a
            deliberate loss, claiming A$10.4bn in net rental losses.
            <Cite id="ato-taxstats-2223" /> The benefit flows up the income
            ladder: roughly two-thirds of it lands with the top 30% of earners.
            <Cite id="treasury-teis-2023" />
          </p>

          <StatStrip stats={NEGATIVE_GEARING_STATS} className="mt-8" />

          <p className={PARA}>
            It is not new, and it has been touched exactly once. In 1985 the Hawke
            government quarantined negative gearing; in 1987 it caved and brought
            it back.<Cite id="rentwest-ng-history" /> Labor carried a reform plan
            &mdash; limiting it to new builds &mdash; into the 2016 and 2019
            elections and lost both. The settings survived because millions of
            voters had built their retirement on them.<Cite id="pbo-ng-cgt" />
          </p>
        </Section>

        {/* ── III ────────────────────────────────────────────────────── */}
        <Section numeral="III" kicker="The accelerant" title="The 1999 switch that poured on petrol">
          <p className={PARA}>
            If negative gearing lit the fire, the 1999 capital gains tax discount
            poured petrol on it. On 20 September 1999, the Howard government
            scrapped inflation-indexed capital gains and replaced them with a flat
            50% discount on anything held longer than a year.<Cite id="cgt-wikipedia" />
          </p>
          <p className={PARA}>
            Pair that with negative gearing and you get something close to a
            tax-arbitrage machine. The Reserve Bank spelled it out: the
            discount&rsquo;s effect &ldquo;is amplified if the asset can be
            purchased with leverage, because the interest deductions are
            calculated at the full marginal rate while the subsequent capital
            gains are taxed at half&rdquo; &mdash; and &ldquo;property is
            especially affected.&rdquo;<Cite id="rba-impact-taxation-2015" />
          </p>

          <PullQuote attribution="Reserve Bank of Australia, 2015">
            &ldquo;&hellip;amplified if the asset can be purchased with leverage,
            because the interest deductions are calculated at the full marginal
            rate while the subsequent capital gains are taxed at half&hellip;
            property is especially affected.&rdquo;
          </PullQuote>

          <p className={PARA}>
            The data did what the incentives told it to. In the four years after
            the discount, real house prices jumped almost 50%.<Cite id="bis-fred-hpi" />{" "}
            Investors, who had been a fifth of new mortgage lending in the early
            1990s, became a third to nearly a half of it.<Cite id="abs-lending-indicators" />
          </p>

          <ScrollReveal>
            <FeatureChartFrame
              eyebrow="Dashboard ② · 1980–2025"
              title="When the tax code moved, prices followed"
              subtitle="Real house prices (BIS, 2010=100) against the property-tax settings — the 1985-87 negative-gearing experiment and the 1999 CGT discount. Switch the second line between investor share of new lending and the count of negatively-geared landlords."
              note="Real = inflation-adjusted. The ABS investor-share series begins in 2002; before then it sat near 20%."
              sourceIds={["bis-fred-hpi", "abs-lending-indicators", "ato-taxstats-2223"]}
            >
              <PolicyPriceChart />
            </FeatureChartFrame>
          </ScrollReveal>

          <p className={PARA}>
            Note what the chart does <em>not</em> say. Tax policy is a multiplier,
            not the only cause &mdash; supply was throttled, rates fell, the
            population grew. But every honest account of why Australian housing
            detached from the rest of the developed world circles back to these
            two settings.<Cite id="grattan-hot-property-2016" />
          </p>
        </Section>

        {/* ── IV ─────────────────────────────────────────────────────── */}
        <Section numeral="IV" kicker="The engine" title="The buying power of four banks">
          <p className={PARA}>
            Tax policy creates the desire to buy. The banks supply the means.
            House prices are set at the margin by what the next buyer can borrow
            &mdash; and for two decades the big four have been willing to lend
            more, against less, to more people.
          </p>
          <p className={PARA}>
            The result is one of the most indebted household sectors on earth.
            Household debt climbed from 67% of income in 1990 to a peak near 187%
            in 2017&ndash;18 &mdash; among the highest in the advanced world.
            <Cite id="rba-e2" /><Cite id="rba-debt-speech-2018" /> The big four now
            carry roughly A$1.9 trillion of mortgages between them, about 77% of a
            A$2.475 trillion system book.<Cite id="apra-qpex-2025" /><Cite id="statista-mortgages" />
          </p>

          <StatStrip stats={BANK_POWER_STATS} className="mt-8" />

          <ScrollReveal>
            <FeatureChartFrame
              eyebrow="Dashboard ③ · 1990–2025"
              title="The credit that bid up the price"
              subtitle="Household debt-to-income (RBA, left) against the price-to-income index (OECD, right). APRA's macroprudential interventions — the 2014–21 tightening — are marked."
              note="Debt-to-income roughly tripled in a single generation."
              sourceIds={["rba-e2", "oecd-house-prices", "apra-qpex-2025"]}
            >
              <BuyingPowerChart />
            </FeatureChartFrame>
          </ScrollReveal>

          <p className={PARA}>
            How powerful is the lever? The Reserve Bank&rsquo;s own housing model
            implies a sustained one-percentage-point fall in the real mortgage
            rate lifts real prices by around 28% over the long run.
            <Cite id="rba-rdp-2019-01" /> That is the single most important number
            in Australian housing &mdash; and you can feel it for yourself.
          </p>

          <ScrollReveal>
            <div className="my-12">
              <BorrowingPowerSlider />
            </div>
          </ScrollReveal>

          <p className={PARA}>
            This is why APRA, not the RBA, became the de-facto housing regulator.
            When prices ran too hot it capped investor-credit growth (2014),
            throttled interest-only loans (2017), and forced banks to test
            borrowers against a three-percentage-point buffer (2021).
            <Cite id="apra-qpex-2025" /> Each time the brakes worked &mdash; for a
            while.
          </p>
        </Section>

        {/* ── V ──────────────────────────────────────────────────────── */}
        <Section numeral="V" kicker="The cautionary tales" title="What breaking actually looks like">
          <p className={PARA}>
            Bears are not wrong that this can end. They are wrong about how fast.
            Three other markets show the range of outcomes &mdash; and only one of
            them looks like the crash the shorts keep pricing in.
          </p>
          <p className={PARA}>
            <strong className="text-foreground">Japan is the nightmare.</strong>{" "}
            After a 1980s mania built on land collateral, real house prices peaked
            in 1991 and fell 47% over the next eighteen years.<Cite id="bis-fred-hpi" />
            <Cite id="japan-bubble-wikipedia" /> They are still a third below that
            peak today, more than three decades on. The banks that had lent
            against the land spent a decade as zombies.
          </p>
          <p className={PARA}>
            <strong className="text-foreground">America is the fast version.</strong>{" "}
            Subprime lending inflated a bubble that peaked in 2006; real prices
            fell 37% by 2011 before clawing back &mdash; but it took until 2021 to
            reclaim the old high.<Cite id="bis-fred-hpi" /><Cite id="case-shiller-wikipedia" />{" "}
            The crash that broke the global financial system still took five years
            to find a bottom.
          </p>
          <p className={PARA}>
            <strong className="text-foreground">China is the one happening now.</strong>{" "}
            Property and its tentacles are roughly a quarter of GDP;
            <Cite id="imf-china-rogoff-2024" /> after Beijing&rsquo;s
            &ldquo;three red lines,&rdquo; Evergrande defaulted in December 2021 on
            more than US$300bn of debt,<Cite id="aljazeera-evergrande-2021" /> and
            real prices have fallen about 20% since &mdash; and are still falling.
            <Cite id="bis-fred-hpi" />
          </p>

          <ScrollReveal>
            <FeatureChartFrame
              eyebrow="Dashboard ④ · real house prices"
              title="Four bubbles, four endings"
              subtitle="BIS real (inflation-adjusted) house-price indices, aligned to each market's cyclical peak. 'From peak' overlays the trajectories so the crash shapes compare directly; 'Calendar' shows the raw levels. Tap a country to isolate it."
              note="Australia is anchored at its 2017 cyclical peak; on this inflation-adjusted basis it never had a sustained fall."
              sourceIds={["bis-fred-hpi"]}
            >
              <InternationalCorrectionsChart />
            </FeatureChartFrame>
          </ScrollReveal>

          <p className={PARA}>
            And Australia? On the same inflation-adjusted basis, its worst stretch
            this cycle was a dip of about 6% in 2022&ndash;23, erased within two
            years.<Cite id="bis-fred-hpi" /> Put the four on one axis and the
            contrast is the whole argument: three markets fall off a cliff from
            their peak; Australia bends, then makes new highs.
          </p>
        </Section>

        {/* ── VI ─────────────────────────────────────────────────────── */}
        <Section numeral="VI" kicker="The reckoning" title="So does the widow-maker ever pay?">
          <p className={PARA}>
            The May 2026 selloff &mdash; CBA&rsquo;s worst day in 34 years, the
            big four shedding tens of billions in a fortnight &mdash; is the most
            serious crack in years.<Cite id="ibtimes-cba-2026" /> Short interest
            sits at a record.<Cite id="hedgeweek-11bn-2026" /> The bear case has
            never been more quantitatively true: debt is extreme, affordability is
            the second-worst in the world after Hong Kong,<Cite id="demographia-2025" />{" "}
            and the policy props are, for the first time in 40 years, under genuine
            political threat.
          </p>
          <p className={PARA}>
            But all of that has been true before. The machine is still running:
            the tax incentives are intact, the banks are still lending, and every
            previous dip turned out to be a buying opportunity. The honest answer
            is the one no short-seller wants to hear &mdash; the bet that
            Australian housing ends like Japan or America is probably right about
            the destination and hopeless about the timing. Which is precisely what
            makes it a widow-maker.
          </p>
          <p className={PARA}>
            Watch the banks. They are the market&rsquo;s purest expression of the
            housing thesis &mdash; and the place the reckoning, if it comes, will
            show up first.
          </p>

          <div className="mt-10 rounded-xl border border-primary/30 bg-card p-6 shadow-amber-sm">
            <p className="font-serif text-lg text-foreground">
              Track the live short positions in the big four.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              CBA, Westpac, NAB and ANZ — updated daily from ASIC.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 font-mono text-sm">
              {["CBA", "WBC", "NAB", "ANZ"].map((c) => (
                <Link
                  key={c}
                  href={`/shorts/${c}`}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  {c} →
                </Link>
              ))}
            </div>
          </div>
        </Section>

        <SourcesList />
      </div>
    </article>
  );
}
