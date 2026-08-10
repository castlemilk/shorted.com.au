Fix defects found by a second adversarial review of your work on this branch. Three independent lenses reviewed the diff and a separate verifier tried to REFUTE each finding; only CONFIRMED ones appear below (several were reproduced against a real PostgreSQL container or by reading the rendered UI). Do not re-litigate them.

Ground rules:
- Your previous work is ALREADY COMMITTED on this branch. Add fix commits on top. Do not rewrite history, push, merge, or switch branches.
- Fix root causes. Where a TEST or a CI guard pins the buggy behaviour or is inert, fix it so it asserts real behaviour - an assertion that can never fire is worse than none.
- Re-run the scoped tests and report ACTUAL output. If the sandbox blocks something, say so plainly rather than claiming it passed.
- If you genuinely believe a finding is wrong, argue it with evidence in your summary rather than silently skipping it.
- Note: sibling branches are fixing other housing areas in parallel. Keep edits to shared files minimal and additive.

## Confirmed findings (3)

### 1. [MAJOR] "Cash and mortgage rates" comparison chart is unreadable: cash rate spans 36 years, mortgage rates only 7
**Where:** web/src/@/components/housing/affordability-panel.tsx:142-152 (with web/src/@/components/housing/housing-multi-line-chart.tsx:44-66)

**What's wrong:** RATE_SERIES pairs `cash_rate` with `mortgage_rate_oo`/`mortgage_rate_investor`, but the underlying RBA tables have wildly different coverage. Verified against prod (`POST /shorts.v1alpha1.HousingService/GetHousePriceSeries`): cash_rate = 432 monthly points 1990-08-31 → 2026-07-31, min 0.1 max 14.0; mortgage_rate_oo = 83 points 2019-07-31 → 2026-05-31 (2.6–6.2); mortgage_rate_investor = 83 points, same window (3.0–6.5). `getCombinedDomains` (housing-multi-line-chart.tsx:47-65) takes the UNION extent of every supplied series for both axes, so the shared x-domain becomes 1990-08 → 2026-07 and the shared y-domain becomes [0.1-1.39, 14+1.39] → d3 `nice()` → [-2, 16]. This is the largest card in the new section (lg:col-span-2) and its whole stated purpose is the three-way comparison.

**How it fails:** On the live /housing page the rates card renders one amber cash-rate line across the full width and two stub lines confined to the right 19.5% of the plot ((2019-07 − 1990-08)/(2026-07 − 1990-08) = 80.5% of the width elapses before they start). The 1990 14% cash rate stretches the y-domain to [-2, 16], so the band the card actually exists to compare (3.6% cash vs 6.2% OO vs 6.5% investor) occupies 2.9/18 = 16% of the plot height, with a further ~11% of the plot given to an impossible negative-interest-rate region. Hovering anywhere left of 2019 shows "Owner-occupier mortgage rate —" and "Investor mortgage rate —" for 349 of the 432 union dates. A reader sees what looks like a broken/truncated chart.

**Suggested fix:** Clamp the comparison chart's shared time domain to the latest series start (intersection) rather than the union — e.g. add an optional `since` / `align="intersection"` serializable prop on HousingComparisonChart and compute `time: [max(first dates), max(last dates)]` in getCombinedDomains when set — and pass it for the rates card. Alternatively split the cash rate into its own single-series card and compare only the two F6 mortgage-rate series.

**Verifier's confirmation:** CONFIRMED — every claim reproduced exactly; no guard exists anywhere in the diff.

CODE (worktree /Users/benebsworth/projects/.worktrees/shorted-hw-affordability-panel):
- web/src/@/components/housing/affordability-panel.tsx:140-153 is the cited lg:col-span-2 "Cash and mortgage rates" card, passing RATE_SERIES (cash_rate, mortgage_rate_oo, mortgage_rate_investor), format="percent", default transform="level".
- web/src/@/components/housing/housing-multi-line-chart.tsx:44-66 getCombinedDomains is a pure UNION: time:[min(all),max(all)], value:[min-pad,max+pad]; yScale has nice:true (line 158). grep for `since|align|intersection|slice(-|window` across housing-multi-line-chart.tsx, housing-comparison-chart.tsx, series-data.ts returns NOTHING — no clamping/alignment guard.
- getHousePriceSeriesClient(regionCode, measure, "") — third arg is dwellingType, not a date filter (web/src/app/actions/client/getHousingClient.ts:12-16), so full history is fetched.
- HousingComparisonChart keeps every series with points.length >= 2, so all three render.
- AffordabilityPanel is mounted on /housing (web

---

### 2. [MINOR] "Affordability" measure tile claims "Monthly/quarterly" but every series in that group is quarterly
**Where:** web/src/@/components/housing/affordability-panel.tsx:48

**What's wrong:** The tile renders `detail: "Monthly/quarterly · index, YoY & share"` for the Affordability group, which contains rents_index, wage_index, price_to_income and investor_loan_share. All four are ingested with `PeriodFreq: "Q"` (services/house-price-collector/abs_affordability.go:42 and :136; abs.go:356) and confirmed quarterly on prod: rents_index 60 points 2011-09-30→2026-06-30, wage_index 59, price_to_income 59, investor_loan_share 59 — all on Mar/Jun/Sep/Dec quarter-ends. No monthly series exists in this group.

**How it fails:** A reader looking at the Affordability tile expects at least one monthly-cadence series and reads the rents/wages, price-to-income and investor-share charts as partly monthly data; every point in all four is quarterly. The `affordability-panel.test.tsx:116` assertion locks the wrong string in, so the mislabel is protected by a test.

**Suggested fix:** Change the tile detail to "Quarterly · index, YoY & share" (and update the assertion at affordability-panel.test.tsx:116).

**Verifier's confirmation:** CONFIRMED at web/src/@/components/housing/affordability-panel.tsx:48. The Affordability tile's `detail` reads "Monthly/quarterly · index, YoY & share", but every series it covers (its own description names them: rents, wages, price-to-income, investor lending share; the section at lines 181-224 renders exactly rents_index, wage_index, price_to_income, investor_loan_share) is quarterly at the only writer of `house_prices`: services/house-price-collector/abs_affordability.go:42 stamps PeriodFreq "Q" for rents_index (CPI key `1.115522.10.50.Q`) and wage_index (WPI key `...AUS.Q`), :136 for price_to_income, and abs.go:266/:356 for investor_loan_share (LEND_HOUSING key ends `.Q`) — all periods via `quarterEnd()`. `grep 'PeriodFreq: "M"'` over the collector returns nothing; the only monthly ingests are the RBA ones (`ingestRBANationalSeries(..., "M", ...)` at rba.go:119/127/135) for mortgage rates, cash rate and credit growth, none of which appear in this tile. The jobs-consolidation copy under services/jobs/internal/jobs/houseprices/ is identical, and `git log -S` shows neither the LEND k

---

### 3. [MINOR] Dataset JSON-LD temporalCoverage and LLMMeta update-frequency are stale after the RPPI swap and the monthly series
**Where:** web/src/app/housing/page.tsx:147 (and 161)

**What's wrong:** The diff removed the only 2003-starting series from the page (the frozen ABS RPPI `price_index`, whose prod series runs 2003-09-30 → 2021-12-31) and added series that start far earlier and run monthly, but the machine-readable claims were not updated. page.tsx:147 still emits `temporalCoverage: "2003/.."` in the Dataset JSON-LD, while the earliest data now rendered on the route is 1977-08-31 (housing_credit_growth, 587 monthly points) and 1988-06-30 (household_liabilities). page.tsx:161 still passes `dataFrequency="quarterly"` to LLMMeta, which emits `<meta name="ai:update-frequency" content="quarterly">` plus a schema.org `PropertyValue{name:"updateFrequency", value:"quarterly"}` (llm-meta.tsx:150-154, :212) — directly contradicting the page's own new footer copy at page.tsx:321-323 ("Monthly and quarterly series") and the 6 monthly RBA series the panel renders.

**How it fails:** A crawler / LLM ingesting /housing reads the page as a quarterly dataset covering 2003-onwards, then encounters on-page monthly cash-rate and credit-growth charts back to 1977 — the structured data misdescribes the surface it annotates, and the JSON-LD contradicts the visible source note in the same document.

**Suggested fix:** Set `temporalCoverage: "1977/.."` (or the true minimum across rendered series) and `dataFrequency="monthly and quarterly"` (or "monthly", the finest cadence on the page).

**Verifier's confirmation:** Both cited lines exist verbatim and are untouched by the branch: /Users/benebsworth/projects/.worktrees/shorted-hw-affordability-panel/web/src/app/housing/page.tsx:147 `temporalCoverage: "2003/.."` and :161 `dataFrequency="quarterly"`. llm-meta.tsx:152-153 + :212 emit them as a schema.org PropertyValue{updateFrequency} and <meta name="ai:update-frequency">, exactly as described.

FREQUENCY LIMB — CONFIRMED, and genuinely diff-introduced. Base page rendered only quarterly series (mean_price, debt_to_income, price_index) and its footer said "Quarterly". The branch adds six MONTHLY series through AffordabilityPanel (cash_rate, mortgage_rate_oo/_investor, housing_credit_growth{,_oo,_investor}) and rewrites the footer to "Monthly and quarterly series" (page.tsx:321-323) while leaving dataFrequency="quarterly" — the same document now contradicts itself. Verified monthly cadence against prod via the public HousingService/GetHousePriceSeries: housing_credit_growth 587 pts 1977-08-31→2026-06-30 (rba_d1), cash_rate 432 pts from 1990-08-31 (rba_f11), mortgage_rate_oo 83 pts (rba_f6). No windowi

---

