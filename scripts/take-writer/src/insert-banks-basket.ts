/**
 * One-off: hand-assembled BASKET editorial take — the big-four banks' record
 * ~$11bn short position. The newsroom pipeline only writes single-stock takes,
 * so this cross-stock piece is assembled by hand and inserted as a DRAFT
 * (published_at = NULL) for review at /admin/takes. Mirrors the parameterized
 * insert in newsroom.ts. Grounding: Shorted's own ASIC×price numbers are stated
 * without citation; the news-sourced framing ($11bn record / valuation thesis)
 * carries [ref-N] markers backed by the citations array below.
 *
 * Run: cd scripts/take-writer && DATABASE_URL=... npx tsx src/insert-banks-basket.ts
 */
import { Pool } from "pg";

const slug = "big-four-bank-shorts-hit-a-record-11bn-cba-is-half";
const headline =
  "The big four banks now carry a record short bet — and CBA is half of it";
const standfirst =
  "Short sellers hold nearly $11bn against Australia's major banks, the largest dollar bet on record. Commonwealth Bank alone is $5.5bn of it — its heaviest short load since 2016.";
const byline = "The Shorted Desk — Banking & Financials";
const stockCode = "CBA"; // heart of the basket; surfaces on /shorts/CBA/news + related
const sentiment = "negative";
const tier = "deep_dive";
const bodyFormat = "mdx";
const model = "hand-assembled";

const body = `Australia's most reliable trade has always been owning the banks. For the better part of a decade, betting against them was a quick way to lose money — they ground higher, paid fat dividends, and shrugged off every bear thesis thrown at them. That consensus has cracked.

Hedge funds now hold close to $11 billion of short positions across Commonwealth Bank, Westpac, NAB and ANZ — the largest dollar value ever assembled against the sector, with the number of shares out on loan back at levels last seen in 2018, the year of the Hayne royal commission. [ref-1] This time the raid is led by domestic long-short managers rather than the offshore property bears of 2016, and their thesis is narrow: the banks, and CBA above all, are priced for a perfection that is starting to slip. [ref-2]

<StatGroup>
<Stat label="Big four short value" value="~$10–11bn" context="ASIC positions at current prices — a record" />
<Stat label="CBA short position" value="$5.5bn" context="2.02% of issue, about half the basket" />
<Stat label="CBA short, one year ago" value="1.02%" context="it has roughly doubled" />
<Stat label="Highest since" value="2016" context="the original housing 'big short'" />
</StatGroup>

## CBA is the whole story

Strip the basket back and one name does the heavy lifting. Shorted's tally of ASIC positions against current market prices puts the four-bank short bet near $10 billion; Commonwealth Bank alone is $5.5 billion of it. At 2.02% of shares on issue, CBA's short interest has roughly doubled over the past twelve months — it sat at just 1.02% a year ago and 1.40% only a quarter back — and it now stands at its highest level since 2016, the era of the original short against Australian housing.

What changed is not the loan book but the price. CBA spent two years detaching from every valuation anchor analysts could throw at it, at one point trading on 26 times forward earnings — an extraordinary multiple for a mature, low-growth domestic lender. [ref-1] That premium is the short thesis in a single number: you do not need the bank to fail, you only need the multiple to mean-revert. Its record one-day fall after the federal budget, and the slide from $174 to around $160, is exactly the air-pocket the bears were positioned for. [ref-2]

<PullQuote>You do not need the bank to fail — you only need the multiple to mean-revert.</PullQuote>

<BankShortBasket banks="CBA,WBC,NAB,ANZ" window="1y" mode="dollar" />

## The other three are stirring too

This is not purely a CBA trade. Westpac's short interest has climbed to 1.59% and NAB's to 1.61%, both up sharply on three months ago, as the same worry spreads across the majors: competition for deposits is squeezing net interest margins, with Westpac's recently slipping to 1.94%. [ref-1] In dollar terms WBC carries about $1.9 billion of shorts and NAB a near-identical $1.9 billion — meaningful, if a fraction of CBA's load.

ANZ is the conspicuous holdout. At 0.75% of issue and roughly $0.8 billion, its short interest is barely half the others' and has moved the least. The market is not betting against "the banks" as a bloc — it is betting against the valuations, and ANZ, the cheapest and least loved of the four, simply offers the bears the least to work with.

## The test arrives

A short position is a clock, not a verdict. The bears are paying to borrow these shares and wearing the dividends while they wait, so the trade needs a catalyst before the cost compounds. The next one is the RBA: a hold and a dovish signal would force the banks higher and squeeze the shorts; a hawkish turn, against rising provisions and a softening housing market, would hand them their thesis. [ref-2]

For now the scoreboard reads simply: the most crowded long in the Australian market has attracted its largest-ever crowd of doubters — and they have concentrated almost all of their conviction on the one stock that ran the furthest. Whether that is prescience or an expensive lesson in fighting momentum is, as ever, a question of timing.`;

const citations = [
  {
    refId: "ref-1",
    type: "news",
    source: "fool.com.au",
    url: "https://www.fool.com.au/2026/06/11/hedge-funds-are-shorting-the-big-four-bank-shares-should-investors-be-worried/",
    headline:
      "Hedge funds are shorting the big four bank shares. Should investors be worried?",
    date: "2026-06-11",
  },
  {
    refId: "ref-2",
    type: "news",
    source: "saltfinancialgroup.com.au",
    url: "https://www.saltfinancialgroup.com.au/news/jmhrzmpdj7639ex-etlpw-bbadt-zk5zr-8k67n-bp8aa-wa2ls-na6f2-jbn4g-ld9nm",
    headline:
      "$11B Short Bet Signals Risk for Australian Bank Shares: What Investors Need to Know",
    date: "2026-06-12",
  },
];

async function main() {
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const res = await pool.query(
    `INSERT INTO editorial_takes (
       slug, headline, stock_code, body_md, sentiment, word_count, model, tier,
       citations, body_format, standfirst, byline, published_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,NULL)
     ON CONFLICT (slug) DO UPDATE SET
       headline=EXCLUDED.headline, body_md=EXCLUDED.body_md, tier=EXCLUDED.tier,
       sentiment=EXCLUDED.sentiment, word_count=EXCLUDED.word_count,
       citations=EXCLUDED.citations, body_format=EXCLUDED.body_format,
       standfirst=EXCLUDED.standfirst, byline=EXCLUDED.byline, updated_at=NOW()
     RETURNING slug, word_count, published_at`,
    [
      slug, headline, stockCode, body, sentiment, wordCount, model, tier,
      JSON.stringify(citations), bodyFormat, standfirst, byline,
    ],
  );
  console.log("Inserted/updated draft:", res.rows[0]);
  console.log(`Word count: ${wordCount}`);
  console.log(`Review at /admin/takes or: list-drafts --slug=${slug}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
