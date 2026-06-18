/**
 * One-off: hand-assembled SECTOR basket take — the rare-earth / magnet "craze"
 * and the shorts circling Lynas. Uses the generic <ShortBasket basket="rareearth" />
 * chart (PR #180). Inserted as a DRAFT for review. Grounding: Shorted's own
 * ASIC×price numbers carry no citation; news framing carries [ref-N].
 *
 * Run: cd scripts/take-writer && DATABASE_URL=... npx tsx src/insert-rareearth-basket.ts
 */
import { Pool } from "pg";

const slug = "rare-earth-shorts-circle-the-magnet-craze-lynas-is-the-target";
const headline =
  "Short sellers are circling the rare-earth magnet craze — and Lynas is the target";
const standfirst =
  "ASX rare-earth miners rerated on a China-versus-West scarcity premium. Short sellers hold nearly $2bn against the basket — almost all of it on Lynas, at 10% of its shares.";
const byline = "The Shorted Desk — Mining & Resources";
const stockCode = "LYC";
const sentiment = "negative";
const tier = "deep_dive";
const bodyFormat = "mdx";
const model = "hand-assembled";

const body = `For a decade, betting against rare earths was betting against a slogan. The miners were perennial promises — strategic, critical, the backbone of the energy transition — and perennial disappointments, long on geopolitics and short on profit. In 2025 the slogan finally paid off, and the share prices went vertical.

The catalyst was manufactured in Beijing and Washington, not at the drill bit. China, which controls roughly 90% of the world's rare-earth processing and more than 90% of magnet production, spent 2025 weaponising that grip — restricting magnet exports in April, then in October demanding Chinese sign-off on any magnet containing as little as 0.1% Chinese material. [ref-1] The West answered with cheque-book industrial policy: the Pentagon took a $400 million stake in America's MP Materials and set a ten-year floor of US$110 a kilogram for NdPr, roughly double the prevailing price. [ref-2] ASX rare-earth names tripled and doubled; Lynas climbed more than 200% on the year.

<StatGroup>
<Stat label="Rare-earth short value" value="~$2.0bn" context="ASIC positions at current prices" />
<Stat label="Lynas short position" value="~10%" context="9th most-shorted on the ASX" cite="ref-1" />
<Stat label="Lynas share of basket" value="~90%" context="~$1.8bn of the ~$2bn" />
<Stat label="Lynas realised NdPr" value="~A$85/kg" context="below the US$110/kg floor" cite="ref-2" />
</StatGroup>

## Lynas is the whole basket

Strip the sector back and one name carries it. Shorted's tally of ASIC positions puts the rare-earth short bet near $2 billion — and Lynas, at roughly 10% of its shares on issue, is close to $1.8 billion of it, the rest scattered across Iluka, Arafura and the magnet hopeful Australian Strategic Materials. Lynas short interest has crept up over the past year and now ranks among the ten most-shorted stocks on the exchange. [ref-1]

<ShortBasket basket="rareearth" window="1y" mode="dollar" />

The bears' case is the banks' case in different clothing: a stock priced for perfection. At the height of the run Lynas changed hands at well over 200 times earnings — a multiple that assumes the scarcity premium holds, the Texas and Malaysia plants ramp cleanly, and NdPr stays aloft. Yet Lynas's own realised selling price, around A$85 a kilogram, still sits below the US$110 floor that supposedly underwrites the valuation. [ref-2]

<PullQuote>You do not need rare earths to fail — you only need the premium to deflate.</PullQuote>

## The first crack

Then operational reality arrived. Lynas's March-quarter production landed almost a fifth below what analysts expected, with its flagship NdPr output light and revenue short — the first visible gap between the geopolitical story and what actually comes out of the ground. [ref-3] For a stock leaning entirely on execution to justify its multiple, a miss like that is precisely the catalyst the shorts were waiting for.

## The two ways it unwinds

A short on Lynas is really a short on a mood. The premium drains the moment China blinks — and late in 2025 Beijing began issuing streamlined "general licences" that loosen the chokehold the whole basket is priced on. [ref-1] The other path is slower: a ramp that slips, a leadership transition that wobbles, an NdPr price that drifts back toward the spot market rather than the headline floor.

Against all that, the bears carry a familiar risk. Price floors are a genuine, contracted tailwind, and short interest above 10% is its own kind of fuel — any fresh escalation out of Beijing could ignite a squeeze as violent as the rally that started it. The rare-earth trade has always moved on headlines. The shorts are betting the next one points the other way.`;

const citations = [
  {
    refId: "ref-1",
    type: "news",
    source: "fool.com.au",
    url: "https://www.fool.com.au/2026/03/23/these-are-the-10-most-shorted-asx-shares-23-march-2026/",
    headline: "These are the 10 most shorted ASX shares (23 March 2026)",
    date: "2026-03-23",
  },
  {
    refId: "ref-2",
    type: "news",
    source: "mpmaterials.com",
    url: "https://mpmaterials.com/news/mp-materials-announces-transformational-public-private-partnership-with-the-department-of-defense-to-accelerate-u-s-rare-earth-magnet-independence/",
    headline:
      "MP Materials announces public-private partnership with the Department of Defense",
    date: "2025-07-10",
  },
  {
    refId: "ref-3",
    type: "news",
    source: "marketindex.com.au",
    url: "https://www.marketindex.com.au/news/lynas-rare-earths-just-delivered-its-best-quarter-in-4-years-on-rising-ndpr-prices-why-it-fell-and-is-it-time-to-buy-the-dip",
    headline:
      "Lynas Rare Earths just delivered its best quarter in 4 years — why it fell",
    date: "2026-04-30",
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
