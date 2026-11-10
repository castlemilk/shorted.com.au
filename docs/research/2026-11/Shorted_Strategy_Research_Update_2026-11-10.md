# Research update on monitoring and ownership

Shorted should prove one repeatable task: help an ASX researcher notice a relevant change, inspect the evidence, discuss the question it raises and keep a dated output for later use. This extends the existing ASX research network strategy and its 24-person pilot.

**Research date: 10 November 2026, Australia/Melbourne.** The evidence below supports product decisions and experiments. Vendor descriptions establish advertised capability; they do not establish delivery quality or customer willingness to switch.

# Decisions for the next implementation phase

| Decision | Reason | Implementation |
| --- | --- | --- |
| Make the complete research task the unit of delivery | Personalised updates, alerts and discussion already coexist in competing products | Link follows, dated events, questions, review state and a reusable packet across #952, #953, #957, #958 and #961 |
| Prioritise ownership-source compatibility | New Australian disclosure formats are approaching and the current code contains legacy assumptions | Deliver the bounded readiness task [#971](https://github.com/castlemilk/shorted.com.au/issues/971) before optional expansion of #962 |
| Run one investor continuation offer | The small cohort can test a specific value proposition; splitting it into price cells would be hard to interpret | Test A$19/month under [#972](https://github.com/castlemilk/shorted.com.au/issues/972), with explicit eligibility and paid-use/renewal observations |
| Keep growth conditional on peer usefulness | A network needs reliable responses and repeated contribution within shared interests | Preserve three circles and six-week gates in [the pilot protocol](https://github.com/castlemilk/shorted.com.au/blob/research/asx-community-market-positioning-20261110/docs/research/2026-11/Shorted_Pilot_Protocol_2026-11-10.md) |

The proposed defensible advantage is the accumulated relationship between a company, its changing evidence, a research question, the people who resolved it and the next review. This is a hypothesis about workflow and trust. Basic follows, charts or an AI summary alone do not establish a durable advantage.

# What the competitor evidence changes

| Source | Verified observation | Consequence for Shorted |
| --- | --- | --- |
| [Simply Wall St portfolio updates](https://support.simplywall.st/hc/en-us/articles/18052440570511-What-Happens-After-You-Create-a-Portfolio), updated 22 October 2026 | Personalised company updates cover holdings and watchlists; community updates are separately described. Daily batching and several delivery channels are supported | Separate reported company changes from member interpretation. Explain relevance and deduplicate delivery |
| [Koyfin alerts](https://www.koyfin.com/features/alerts/) | Alerts can cover a watchlist/portfolio and be created from the research context, including charts and tables | Reuse a saved coverage list and create a rule in context. This is a useful competitive standard |
| [Sharesight Australian pricing](https://www.sharesight.com/au/pricing/) | A$59/year Tax Pack provides a narrowly scoped reporting product alongside broader subscriptions | Test a clearly defined work product instead of relying on a large feature bundle |
| [Strawman Premium](https://www.strawman.com/blog/introducing-strawman-premium/) | The programme combines member research/portfolios, meetings, emails and contribution credits; the page says new membership is closed | A curated ASX community already has competition. Demonstrate usefulness around evidence, questions and follow-through |
| [HotCopper watchlists](https://support.hotcopper.com.au/hc/en-us/articles/17129665685517-How-do-I-Add-a-Watch-List) | Users can choose all, price-sensitive or no announcement information for a followed company | Basic company following and announcement filtering should be easy to use |
| [Quarterback](https://qback.au/) | The site markets forum/social/media and trading-activity monitoring to ASX companies and IR teams | Keep broad IR listening as a distinct discovery and rights/cost problem |

These findings do not overturn the earlier community direction. They narrow what the pilot must demonstrate: the same person can return to a question, understand the relevant new evidence and reuse the resulting work with less reconstruction.

## Pricing evidence

Sharesight's current Australian page confirms Basic A$12/month or A$108/year, Standard A$38.67/month or A$348/year, and Premium A$65.33/month or A$588/year, including GST. The A$59 annual Tax Pack is a packaging comparison, not an estimate of Shorted demand. [Pricing source](https://www.sharesight.com/au/pricing/)

Keep the earlier research's uncertainty for other products: Koyfin's displayed annual equivalents were not established as AUD or true monthly checkout tariffs; no clean canonical paid price was verified for Simply Wall St; no current numeric Strawman price was established. Quarterback offers a demo without a numeric tariff on the inspected page. Do not substitute affiliate offers or forum anecdotes for standard list prices.

Shorted's earlier proposed ranges remain hypotheses: investor A$19–29/month, professional A$79–149 per user/month, and a defined 3–5-seat team package at A$249–499/month. The first continuation offer selects A$19/month for an investor research workflow. It does not change current Premium/API pricing or establish a professional market price.

# Demand evidence and its limits

The existing research contains 49 selected forum discussions. That count remains unchanged. Rechecking an existing thread does not add an independent observation.

One supplemental qualitative source is [an OzBargain discussion dated 16 April 2026](https://www.ozbargain.com.au/node/955806). Its author describes an inactive friends' trading chat and asks for active informed peers. This supports testing dependable participation around shared interests. The author's criticisms of other communities and account of trading success are unverified opinions. The thread supplies no Shorted purchase commitment or population-level estimate.

The useful next research is observed work with participants: the most recent company question they investigated, the sources and files used, the uncertainty left unresolved, and the output they actually reused. Follow a comparable task through Shorted and measure effort, verification mistakes and repeat use. A favourable reaction to a concept is separate from use and payment.

For analysts, start with a weekly coverage update. For journalists, start with one chart or factual claim in a real reporting task. For IR, start with a company-plus-peers public-disclosure brief; do not assume demand for a full beneficial-owner register or sentiment-surveillance service.

# Ownership transition as a near-term product priority

ASIC's [official form page](https://www.asic.gov.au/regulatory-resources/forms/forms-folder/substantial-holding-notice) gives the transition: legacy forms remain current through 3 December 2026; SHN and transitional replacement forms apply from 4 December 2026 through 3 June 2027; SHN is required thereafter. Its [reform announcement](https://www.asic.gov.au/about-asic/news-centre/news-items/asic-paves-the-way-for-greater-transparency-of-listed-entity-ownership-and-control) describes enhanced economic-interest and offsetting-short information.

The implementation review found an immediate compatibility problem at main commit 5ce3eead7f696bacacd6a113eeee144c9cdd8a09: both readers and the storage form constraint use legacy form sets; fields and plausibility checks focus on voting percentages; the event classifier sends unrecognised forms to NZ. [Go reader](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/jobs/internal/jobs/ownership/notice.go), [reader validation](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/report-extractor/notice_direct.py), [schema](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/migrations/000137_add_ownership.up.sql), [classification](https://github.com/castlemilk/shorted.com.au/blob/5ce3eead7f696bacacd6a113eeee144c9cdd8a09/services/shorts/internal/store/shorts/postgres_ownership.go)

This is a source-compatibility deadline for Shorted. Treat format, legal regime and notice event as separate concepts. Keep voting/relevant interests, deemed economic interests and disclosed offsetting positions distinct. Preserve historical field meanings; document overlap before calculating a combined or net measure.

ASIC's aggregate short-position series is published T+4 without short-seller details. A separately sourced SHN disclosure can describe its filer's specified interests; it must not be used to identify who accounts for the aggregate ASIC series. [ASIC INFO 98](https://www.asic.gov.au/regulatory-resources/markets/short-selling/short-selling-reporting-short-position-reporting)

The commercial opportunity is to make these distinctions understandable and traceable. The first deliverable is correct ingestion, coverage reporting and source interpretation. A marketing claim of complete new-regime coverage requires end-to-end evidence.

# Source permissions are part of the product contract

[ASX's company-news offering](https://www.asx.com.au/connectivity-and-data/information-services/company-news) describes ComNews and a delayed redistribution feed. Source accessibility alone therefore cannot settle what Shorted may reproduce in a timeline, email or exported packet. Record the permission for the actual acquisition route and output. Existing contracts were not inspected in this planning pass.

Create a source-use record with provider, source/agreement version, permitted display, derived summaries, export, redistribution, attribution, retention/deletion, territory and cost. If a required permission is unknown, use an eligible alternative or a source-link-only output that the reviewed policy permits. Avoid copying full documents by default.

[Reddit's Data API Terms](https://redditinc.com/policies/data-api-terms) require separate arrangements for commercial use and include termination/deletion conditions covering derived material. A future imported forum feature needs both commercial rights and deletion lineage. Keep that work in #968 outside the founding-pilot dependency chain.

The contributor model also needs review of its actual presentation, incentives and referral behaviour. [ASIC INFO 269](https://www.asic.gov.au/regulatory-resources/financial-services/giving-financial-product-advice/discussing-financial-products-and-services-online) makes clear that context and presentation matter when classifying online financial content. Keep that review scoped to the launch flows and later compensated programmes in #966.

# Commercial experiment

Test a bounded saved-list monitoring and evidence-output workflow at A$19/month after users have used it on at least two separate pilot weeks. Record original founders, eligible people, people shown the offer, payments, refunds/cancellations and second-period continuation separately.

The proposed management gate is four first-period payments, not refunded or charged back at the review cutoff, from at least ten eligible offers. At least three of those people must pay for a second period and perform a meaningful research action in its first 14 days. It is a decision aid for this pilot, not a statistically validated conversion target. Fewer than ten eligible offers is insufficient evidence.

Use a contribution model that accounts for payment fees, variable data/model/delivery costs and support/checking time. Track shared hosting and research separately. The pilot's 8–12 human hours each week is an explicit learning investment; a few subscriptions cannot demonstrate sustainable economics.

Professional/team pricing remains discovery work until a buyer shows a recurring output, a budget holder and a credible rights/support cost case. Community participation and paid continuation are separate decisions: either can succeed without the other.

# Implementation handoff

Use [the implementation plan](https://github.com/castlemilk/shorted.com.au/blob/research/asx-community-market-positioning-20261110/docs/research/2026-11/Shorted_Implementation_Plan_2026-11-10.md) for reusable code, contracts, dependencies, estimates and readiness tests. Use [the pilot protocol](https://github.com/castlemilk/shorted.com.au/blob/research/asx-community-market-positioning-20261110/docs/research/2026-11/Shorted_Pilot_Protocol_2026-11-10.md) for the cohort clock, event definitions, exact denominators and operating budget.

The existing [epic #951](https://github.com/castlemilk/shorted.com.au/issues/951) remains the roadmap. The two new bounded gaps are [ownership transition #971](https://github.com/castlemilk/shorted.com.au/issues/971) and [product contract and paid validation #972](https://github.com/castlemilk/shorted.com.au/issues/972). The earlier market report, community plan and forum dataset remain historical evidence in [PR #950](https://github.com/castlemilk/shorted.com.au/pull/950).
