# Investor profiles · design critique

19 November 2026. The primary reader wants to see what an Australian investor or a named manager reported, on what date, and open the original. The second task is to follow the correct person, reporting firm or co-hosted publication.

| Nielsen heuristic | Reading before | Reading after | Operating before | Operating after |
| --- | ---: | ---: | ---: | ---: |
| Visibility of status | 3 | 4 | 3 | 4 |
| Match with the real world | 3 | 3 | 3 | 3 |
| User control and freedom | 3 | 4 | 3 | 4 |
| Consistency and standards | 3 | 3 | 3 | 3 |
| Error prevention | 2 | 4 | 2 | 4 |
| Recognition rather than recall | 2 | 3 | 2 | 3 |
| Flexibility and efficiency | 2 | 3 | 2 | 3 |
| Aesthetic and minimalist design | 3 | 3 | 3 | 3 |
| Error recognition and recovery | 3 | 3 | 2 | 4 |
| Help and documentation | 3 | 3 | 3 | 3 |
| **Total out of 40** | **27** | **33** | **26** | **34** |

## What changed for readers

**An Australian shareholder with annual-register evidence.** An empty notice section previously appeared ahead of the annual report on ten profiles. Christopher Herbert Brown's first PDF link started 952 px down a 390 × 844 phone. It started at 650 px after that review and at 663 px after adding his board appointment and printed-rank strip. Harvey Norman's printed second rank, 205,525,565 ordinary shares, 16.495% and the direct link to page 161 appear together. The notice register's coverage date remains below. A profile with matching notices still leads with that evidence. [Harvey Norman FY26 annual report, page 161](https://cdn.shopify.com/s/files/1/0593/8003/9732/files/FY26_Annual_Report_and_Appendix_4E_to_upload.pdf?v=1787872483#page=161)

**A reader comparing two manager filings.** The former Altimeter table said 17 entries but showed 24 comparison rows. The revised table shows the 17 positions in the current filing, with six prior-only positions behind a dated disclosure. Cerebras appears once, with its negative change in quantity. Scion's largest put row labels the reported dollar amount as the value of the underlying shares. This puts the definition beside the number a reader is likely to quote. [Scion information table](https://www.sec.gov/Archives/edgar/data/1649339/000164933925000007/xslForm13F_X02/infotable.xml) · [Form 13F instructions](https://www.sec.gov/about/forms/form13f.pdf)

**A reader following a company notice.** David Dominic Pevcic's newest disclosed holding now comes first. His Reedy Lagoon notice filed on 4 November 2026 precedes AdAlta's notice from 11 December 2025. Geoff Wilson's largest disclosed interests remain ranked by voting power. A link immediately above them identifies his latest DXN notice and the filing date. On a 320 × 740 phone Gina Rinehart's WCN document control sits entirely inside the initial screen and opens the intended ASX document on a touch tap.

**A reader looking for the right account.** The profile header offers direct personal accounts. The longer list identifies the investor, reporting firm and co-hosted publication separately. So a reader on Geoff Wilson's profile can distinguish his LinkedIn and X links from Wilson Asset Management's. The grouping also works for joint filers or an individual without a confirmed account. Real headshots retain a consistent crop, rounded corners, and reachable credit.

## Visual and interaction assessment

The source and the reporting date provide a clearer starting point than the previous empty-state copy. A quiet divider separates the heading from the figures. Tabular digits line up the current holdings, options carry a plain-language unit, and social rows have space for the platform and handle. Turning on dark mode preserves the same order and hierarchy. A real annual account also looks complete when only the publisher has a portrait.

The keyboard reader can skip the global menus and reach the filings under the sticky header. The enlarged-type reader can follow long names and use the site controls without panning horizontally. A returning reader can reverse Follow, expand a prior report and open a dated source. A first-time reader still has to interpret separate dates for a reported position, its filing and the coverage of the register. Keeping each date with its source is more informative than combining these concepts into one “updated” date.

**P2 resolved in the metadata follow-up.** The September 2026 Altimeter comparison links directly to the six positions present only in June. Enter opens the disclosure and focuses it below the sticky navigation. Reloading the dated fragment opens the same six rows. The first September position value fits inside a 390 × 844 phone after shortening the comparison line. [Prior-quarter positions on a phone](../screenshots/australian-investor-tracker/previous-only-mobile.png)

**Professional context and register evidence.** Twelve of the nineteen profiles have a role or dated career event linked to an issuer, manager or filing. Brown’s board appointment and his registered stake have separate sources. For Wesley and Emma Maas, the four printed ranks remain individually visible in the profile. Each rank links to its registered name, shares, percentage and report page. [Brown’s profile](../screenshots/australian-investor-tracker/annual-investor-mobile.png) · [Maas Group annual register](../screenshots/australian-investor-tracker/joint-register-desktop.png)

## Review conditions

An independent visual reading preceded the technical findings. The walkthrough used recorded public filings and included a publisher-only portrait, joint filers, a person without social accounts, annual-only holders, US common shares and US options. The source scan, twelve rendered detector scans and real browser journeys were checked against the screenshots. Two reported uneven-column warnings reflect long filing tables alongside short account lists. No live overlay was available under the deployed CSP. Review scores describe this set of tasks and screens. The accompanying technical audit records measured results and test limits.
