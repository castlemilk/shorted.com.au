/**
 * One-off: hand-assembled SECTOR basket take — the lithium "craze", the bust, and
 * the short squeeze, with the bears now creeping back. Uses the generic
 * <ShortBasket basket="lithium" /> chart (PR #180). Inserted as a DRAFT.
 *
 * Run: cd scripts/take-writer && DATABASE_URL=... npx tsx src/insert-lithium-basket.ts
 */
import { Pool } from "pg";

const slug = "lithium-shorts-got-squeezed-now-theyre-creeping-back";
const headline = "Lithium's short sellers got squeezed — now they're creeping back";
const standfirst =
  "Pilbara Minerals was the ASX's most-shorted stock for years — a proxy bet against collapsing lithium. The 2026 price spike squeezed the bears out; now, at 10% short, they're creeping back.";
const byline = "The Shorted Desk — Mining & Resources";
const stockCode = "PLS";
const sentiment = "negative";
const tier = "deep_dive";
const bodyFormat = "mdx";
const model = "hand-assembled";

const body = `You cannot short a lithium price. There is no liquid contract for the spodumene that comes out of Western Australia's pits, no clean way for a hedge fund to bet the battery-metal boom was overdone. So the bears did the next best thing: they shorted Pilbara Minerals. For years the largest, most liquid pure-play producer on the ASX was the market's proxy for the entire lithium trade — and, more often than not, its single most-shorted stock. [ref-1]

They had reason. The 2021-22 mania minted a generation of battery-metal darlings, then the bust took it all back: spodumene concentrate collapsed from around US$8,000 a tonne to under US$1,000 in barely a year as EV subsidies were wound back and new supply swamped softening demand. More than $15 billion evaporated from ASX lithium stocks; Pilbara halved, Mineral Resources fell two-thirds, and mines were quietly put into care and maintenance. Short interest in Pilbara climbed from roughly 11% in late 2023 to a remarkable 20% a year later. [ref-1]

<StatGroup>
<Stat label="Lithium short value" value="~$3bn" context="ASIC positions at current prices" />
<Stat label="Pilbara short position" value="10.3%" context="~$2bn, ~70% of the basket" />
<Stat label="Short, one quarter ago" value="7.4%" context="the squeeze low — now rebuilding" />
<Stat label="Peak short, Aug 2024" value="22.5%" context="the depths of the bust" />
</StatGroup>

## The proxy short

Because the bet was always really about the commodity, Pilbara dragged the rest of the basket with it — Liontown, Mineral Resources and IGO rotating through the most-shorted list alongside it. At its worst the materials sector accounted for almost two-fifths of all short interest on the exchange. The lithium short was never a view on any one company; it was the cleanest way to be bearish on the energy transition itself.

<ShortBasket basket="lithium" window="1y" mode="dollar" />

## The squeeze

Then the commodity bit back. A supply shock through late 2025 and early 2026 — Zimbabwe's February ban on lithium-concentrate exports, worth perhaps 7% of global supply, layered on top of delayed Chinese restarts — drove spodumene from around US$600 a tonne to above US$2,000. [ref-2] The rally ran straight into the most crowded short on the market. As the price tripled, fund managers noted the bears had barely covered, and the squeeze did the rest: Pilbara's short interest fell from nearly 13% a year ago to roughly 7% a quarter ago as positions were torn up and the stock ran back toward $6. [ref-3]

## Creeping back

Here is where it gets interesting. The shorts are not gone — they are returning. Pilbara's short interest has climbed back from that 7% low to 10.3% over the past quarter, even as the price has held. The bears that got squeezed are re-shorting into the recovery, betting the spike is speculative excess: the Zimbabwe ban can be lifted, the Chinese restarts will come, and a market that tripled on supply scares can deflate just as fast.

The bulls have an answer. Macquarie calls the recent weakness sentiment-driven rather than fundamental, and Pilbara remains one of the lowest-cost producers in the world, profitable across most of the price cycle. That is the whole tension of the lithium trade in a single stock: the same leverage that delivered triple-digit gains is the leverage that erased them once before.

<PullQuote>The same leverage that delivered triple-digit gains is the leverage that erased them once before.</PullQuote>

The bears have been burned here. They are lining up to try again.`;

const citations = [
  {
    refId: "ref-1",
    type: "news",
    source: "stockhead.com.au",
    url: "https://stockhead.com.au/news/short-and-caught-which-lithium-play-remains-the-asxs-most-shorted-stock/",
    headline: "Short and caught: which lithium play remains the ASX's most shorted stock",
    date: "2025-12-01",
  },
  {
    refId: "ref-2",
    type: "news",
    source: "mining.com",
    url: "https://www.mining.com/australian-lithium-miners-plot-expansions-after-price-surge/",
    headline: "Australian lithium miners plot expansions after price surge",
    date: "2026-03-01",
  },
  {
    refId: "ref-3",
    type: "news",
    source: "hedgeweek.com",
    url: "https://www.hedgeweek.com/aussie-fund-managers-challenge-lithium-short-sellers-as-miners-surge/",
    headline: "Aussie fund managers challenge lithium short sellers as miners surge",
    date: "2026-02-01",
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
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
