Fix defects found by a second adversarial review of your work on this branch. Three independent lenses reviewed the diff and a separate verifier tried to REFUTE each finding; only CONFIRMED ones appear below (several were reproduced against a real PostgreSQL container or by reading the rendered UI). Do not re-litigate them.

Ground rules:
- Your previous work is ALREADY COMMITTED on this branch. Add fix commits on top. Do not rewrite history, push, merge, or switch branches.
- Fix root causes. Where a TEST or a CI guard pins the buggy behaviour or is inert, fix it so it asserts real behaviour - an assertion that can never fire is worse than none.
- Re-run the scoped tests and report ACTUAL output. If the sandbox blocks something, say so plainly rather than claiming it passed.
- If you genuinely believe a finding is wrong, argue it with evidence in your summary rather than silently skipping it.
- Note: sibling branches are fixing other housing areas in parallel. Keep edits to shared files minimal and additive.

## Confirmed findings (3)

### 1. [MAJOR] Purge stops at the 4 HTML fixtures — captured listing data (address, agency, agent names, listing id, price) survives in the Go test files, and the new gate is scoped so it can never see it
**Where:** services/house-price-collector/crawl_listings_extract_test.go:130-141 (and services/jobs/internal/jobs/houseprices/crawl_listings_extract_test.go:130-141)

**What's wrong:** The four testdata HTML files are genuinely synthetic (I read them byte-for-byte: no surviving street, suburb, postcode, price, listing id, agent, agency, portal host or tracking id; `exact.items`/`listingsMap` are emptied and only pagination integers remain). But the very file this commit rewrote still carries a listing record that is indistinguishable from a live REA capture: `"id": "151008144"`, `"display": "$2,310,000"`, `"fulladdress": "67 Alma Street, Paddington, Qld 4064"`, `"listingcompany": {"id": "PRDPAD", "name": "Place - Paddington"}` and `listers` naming individuals — a real agency office and named agents tied to a street address and a sale price. Its own doc comment says the fields are "pulled from the same REA search-results listing object", the id sits in the same 151xxxxxx space as the two ids just purged from rea-pagemeta.html, and it was added by #277 ("collect listing agency + agents from the search-results blob"). The sibling `crawl_listings_test.go:86-95` (untouched) holds the same class of Domain data: ids 2019015084 / 2020346264 / 2020524930, `9/285-295 Bondi Road`, `6/1-7 Andrews Avenue`, `12/18-20 Wellington Street` with prices, landSize and lat/lng -33.895/151.269. `git grep -l` for portal listing URLs over `web services` returns exactly these four .go files and nothing else. The new gate cannot reach any of them: `scripts/check-portal-content-provenance.mjs:50` requires `path.includes("/testdata/")` for anything under `services/`, and `.github/workflows/repo-hygiene.yml:6` only triggers on `services/**/testdata/**`, so a PR touching only Go sources never even starts the job.

**How it fails:** After merge, CI prints "Portal content provenance check passed (1750 scoped files scanned)" (I ran it) while `services/house-price-collector/crawl_listings_extract_test.go:134-139` still publishes a named real-estate agent + agency bound to `67 Alma Street, Paddington, Qld 4064` and a $2,310,000 price in a public repo — exactly the content class the commit exists to remove. A follow-up PR that pastes another live capture into any `services/**/*.go` fixture is also merged with a green "Reject captured portal payloads" step, because that path is outside both the workflow trigger and `isInScope`.

**Suggested fix:** Regenerate those two Go fixtures with the same synthetic vocabulary used for the HTML fixtures (Synthetic Suburb / ZZ 0000 / invented agency+agent strings — the parser is schema-agnostic so no assertion changes shape), and widen `isInScope` to all tracked files under `services/` plus the workflow `paths:` to `services/**`, with an explicit allowlist for the structural-shape fixtures that legitimately need `window.ArgonautExchange` / `__NEXT_DATA__` wrappers.

**Verifier's confirmation:** CONFIRMED — both halves of the claim reproduce exactly, and the scope gap is worse than the reviewer stated.

**1. Residual content is real and untouched.** `git diff 8c120a352 -- services/house-price-collector/crawl_listings_extract_test.go` rewrites only the header comment and the two `TestExtractPageMeta_*` bodies. `TestHarvestListing_AgencyAndAgents` is not in the diff, and lines 130-141 still read verbatim:
```go
"id":             "151008144",
"price":          map[string]any{"display": "$2,310,000"},
"address":        map[string]any{"display": map[string]any{"fulladdress": "67 Alma Street, Paddington, Qld 4064"}},
"listingcompany": map[string]any{"id": "PRDPAD", "name": "Place - Paddington"},
"listers": []any{ {"name": "Tim Douglas"}, {"name": "Jane Smith"}, ... }
```
Identical at the same lines in `/Users/benebsworth/projects/.worktrees/shorted-hw-repo-hygiene/services/jobs/internal/jobs/houseprices/crawl_listings_extract_test.go`. Provenance corroborated: `git log -S'151008144'` points to 2f4a34f91 (#277, 2026-07-16), whose body says "Verified on a **REAL captured REA search 

---

### 2. [MINOR] The gate matches only three wrapper tokens, never the leaked content — renaming two identifiers re-lands the entire original capture with a green check
**Where:** scripts/check-portal-content-provenance.mjs:93-105

**What's wrong:** `signatures()` tests for `window.ArgonautExchange =`, `canonicalSearchId`, and (`__NEXT_DATA__` AND `totalListings:` AND `searchRequest:`). Every one of those is a cosmetic wrapper token, and none of the actually sensitive material — street addresses, suburb+postcode pairs, prices, listing ids, agent/agency names, `realestate.com.au/property-*` or `domain.com.au/...-<9-digit-id>` canonical URLs — is examined. Worse, this branch itself establishes the exact rename pattern that defeats the gate (`__NEXT_DATA__` → `__SYNTHETIC_DOMAIN_PAGE_META__`, `window.ArgonautExchange` → `window.SyntheticHousingPageMeta`), so the natural next move for someone hand-building a fixture from a live capture is to keep the real values and rename the wrapper. The Domain signature is also fragile in the other direction: it AND-requires `__NEXT_DATA__`, so a capture from any Domain page that moves off the Pages-Router bootstrap slips through even unmodified.

**How it fails:** I reproduced it: `git show 8c120a352:services/house-price-collector/testdata/rea-pagemeta.html | sed -e 's/window.ArgonautExchange/window.SyntheticHousingPageMeta/' -e 's/canonicalSearchId/syntheticSearchId/' > $T/services/house-price-collector/testdata/rea-pagemeta.html; node scripts/check-portal-content-provenance.mjs --root $T` → "Portal content provenance check passed (1 scoped files scanned)", exit 0 — while that file still contains `33/75 Welsby Street, New Farm, Qld 4005`, `12 Moray Street, New Farm, Qld 4005`, listing ids 151775764/151774984 and the canonical URLs `https://www.realestate.com.au/property-apartment-qld-new+farm-151775764`. Two substitutions restore 100% of the leak past a green required check.

**Suggested fix:** Add content signatures alongside the wrapper ones — e.g. `realestate\.com\.au/property-[a-z]`/`domain\.com\.au/[a-z0-9-]+-\d{9,}` canonical listing URLs, `"(fullAddress|shortAddress|streetAddress)"\s*:\s*"\d+[/\- ]` (a numbered street address), and a real-postcode+state pair — since those are the fields that constitute the leak and survive any wrapper rename. Keep the wrapper checks as an additional layer.

**Verifier's confirmation:** CONFIRMED with one correction to the repro. The core claim is true: scripts/check-portal-content-provenance.mjs:93-105 `signatures()` tests only three wrapper tokens (`window.ArgonautExchange =`, `canonicalSearchId`, and `__NEXT_DATA__` AND `totalListings:` AND `searchRequest:`); no address / postcode / price / listing-id / canonical-URL signature exists anywhere in the branch (grepped the full diff for `address|postcode|street|price|realestate\.com|domain\.com` — only the generator's synthetic `postCode: "0000"` and two allow-case attribution hyperlinks in the tests). I reproduced the reviewer's command verbatim: the renamed 8c120a352 REA capture in a temp root yields "Portal content provenance check passed (1 scoped files scanned)", exit 0, while still containing `33/75 Welsby Street, New Farm, Qld 4005`, `12 Moray Street, ...`, ids 151775764/151774984 and `https://www.realestate.com.au/property-apartment-qld-new+farm-151775764`. The Domain AND-coupling is also literally as described.

MISSED GUARD (invalidates the reviewer's specific path): the same workflow step runs scripts/test

---

### 3. [MINOR] REA synthetic numbers make the "TotalPages from maxPageNumberAvailable, not ceil()" assertion vacuous (the Domain fixture deliberately avoids this)
**Where:** services/house-price-collector/crawl_listings_extract_test.go:37

**What's wrong:** The regenerated REA fixture uses totalResultsCount=47, pageSize=20, maxPageNumberAvailable=3 — but `ceil(47/20)` is also 3, so the assertion at line 37 that TotalPages comes "from maxPageNumberAvailable, not a ceil() computation" is satisfied by either code path. The Domain fixture was deliberately chosen to avoid exactly this (61/20 → ceil 4 ≠ totalPages 3), so the inconsistency is in the new synthetic data, not the parser. Verified by mutation with `go test -overlay`: replacing `pageMetaPagesKeys` with a non-matching key makes `TestExtractPageMeta_Domain` and `TestExtractPageMeta_DomainProductionAliases` fail while `TestExtractPageMeta_REA` stays green. (The pre-purge fixture had the same collision — 969/25 → ceil 39 == maxPageNumberAvailable 39 — so this is a missed fix during regeneration, not a new regression; the recursion-through-stringified-JSON coverage the REA fixture exists for is intact: neutering `walkForPageMeta`'s `case string` branch does fail `TestExtractPageMeta_REA`.)

**How it fails:** REA renames or drops `maxPageNumberAvailable` (or the alias is removed in a refactor). `extractPageMeta` silently falls back to `ceil(TotalResults/PageSize)` computed from the BROADENED result count — the exact mis-sizing PageMeta's doc comment warns about — and `TestExtractPageMeta_REA` still passes, so the sweep starts walking pages sized off broadened inventory with no test signal.

**Suggested fix:** In `scripts/generate-synthetic-housing-pagemeta-fixtures.mjs:40-42`, pick numbers where the portal field and the ceil() fallback disagree (e.g. totalResultsCount 47, pageSize 20, maxPageNumberAvailable 5) and update the expectation at crawl_listings_extract_test.go:37 in both package copies.

**Verifier's confirmation:** Verified against the worktree (branch a0fa8dab6 vs 8c120a352); nothing modified — all mutations run via `go test -overlay` with copies in /tmp (since deleted), `git status --porcelain` clean afterwards.

ARITHMETIC CONFIRMED. `scripts/generate-synthetic-housing-pagemeta-fixtures.mjs:40-42` emits totalResultsCount=47, pageSize=20, maxPageNumberAvailable=3. ceil(47/20)=2.35→3, identical to the portal field, so the assertion at `services/house-price-collector/crawl_listings_extract_test.go:37-39` ("want 3 (from maxPageNumberAvailable, not a ceil() computation)") is satisfied by both branches of `extractPageMeta` (`crawl_listings_extract.go:147-149` computes the ceil fallback whenever `TotalPages<=0`). The Domain fixture is genuinely discriminating (61/20→ceil 4 ≠ totalPages 3), and the pre-change REA fixture had the same collision (969/25→ceil 39 == maxPageNumberAvailable 39, visible in the fixture diff), so this is a carried-over weakness, exactly as the finding states.

MUTATION EVIDENCE (stronger than the reviewer's).
- Mutation A — drop only the REA-specific alias, `pageMetaPagesKey

---

