# Investor profiles · technical audit

19 November 2026. The starting point was draft PR #1008 at `89da86c6`. Both scoring passes used the production build and the same source-backed profiles.

| Dimension | Before | After | Evidence |
| --- | ---: | ---: | --- |
| Accessibility | 2/4 | 3/4 | Voting percentages have an announced label. Filing links visibly identify the document and date. The Follow button announces its pressed state. Social links preserve the visible platform and handle in order, followed by the account owner. Keyboard, touch and accessibility-tree inspection were covered. Physical-device assistive technology remains unmeasured. |
| Performance | 3/4 | 3/4 | The build reports 141 kB first-load JavaScript for manager profiles and 133 kB for Australian individual profiles. Both local portraits reserve their dimensions. The shared dashboard still requests sidebar code on anonymous visits. |
| Theming | 3/4 | 4/4 | Inline source underlines inherit the link ink. The measured light and dark underline-to-background contrast is 5.39:1 and 10.42:1 respectively. |
| Responsive design | 2/4 | 4/4 | At a 390 px viewport and 32 px browser default text, the document formerly reached 575 px. The name, portrait, header controls and footer now reflow. Geoff Wilson's notice links fit their table at the intermediate widths that previously clipped them. |
| Implementation integrity | 3/4 | 4/4 | Quarter-end holdings, positions found only in the preceding report, annual registered accounts and ASX notice evidence each identify their source and date. The monetary value on an option row identifies what the filing valued. |
| **Total** | **13/20** | **18/20** | **Excellent on the sampled routes.** |

## Findings and disposition

The baseline technical audit recorded three P1 findings and three P2 findings. The filing reconciliation also uncovered a data defect. No P0 or P1 remains in the inspected flows.

| Priority at discovery | Finding | Result |
| --- | --- | --- |
| P1 | AU inline source links depended on colour. The first audit counted 18 instances across Gina Rinehart, Wesley and Emma Maas, and David Dominic Pevcic. | Source links retain a visible underline in both themes. Primary notice targets are 40 px high and name the form, issuer and date. |
| P1 | Visible and accessible names differed for accounts, portrait links and pressed Follow controls. | “Following” is announced after activation. Portrait credits retain their visible wording. The platform and handle are separated by a real text space so voice commands and visible labels match. |
| P1 | Desktop assistive technology encountered 13.04% on Gina's WCN row without its metric label. | The accessibility tree exposes “Reported voting power” with the percentage at both viewports. |
| P2 | Enlarged type pushed titles and site controls outside the viewport. | The name can flow below the portrait. Header controls, footer columns and utility links reflow with enlarged type. |
| P2 | The current-quarter table included lines reported only in the previous quarter. | The table contains 17 current Altimeter securities. Its separate prior-only disclosure has six. Scion has eight and fourteen respectively. Each table identifies its period. |
| P2 | The main AU Follow target measured 36 px against the project's 40 px convention. | Follow measures 40 px. Tests covered toggling, reload persistence and reversal. The inbox link revealed by Following also has a 40 px target and a persistent underline. |

The financial check matched the Cerebras Class A security across the two Altimeter originals. Only the letter case in the CUSIP changed. The comparison now retains one row with 5,953,504 shares and a decrease of 1,271,533. Instrument type and reporting unit remain part of the matching key. A regression test uses both filed spellings. [June information table](https://www.sec.gov/Archives/edgar/data/1541617/000154161726000008/xslForm13F_X02/2026altimeterq2.xml) · [September information table](https://www.sec.gov/Archives/edgar/data/1541617/000154161726000010/xslForm13F_X02/q3202613f.xml)

## Verification

- The final build was exercised with keyboard and emulated touch, normal and enlarged type, light and dark themes. The seven interaction-test profiles were Brad Gerstner, Michael Burry, Geoff Wilson, Gina Rinehart, David Dominic Pevcic, Richard White, and Wesley and Emma Maas. Christopher Herbert Brown supplied the separate annual-register case.
- The existing evidence sections accept focus below the sticky header. Brad’s first filing is two Tabs and one Enter from a fresh desktop visit, down from 27 Tabs. Primary external filing controls measure at least 40 px. Geoff’s notice list expands from five records to 100 and returns to five. At 640 and 1024 px all 20 holdings-document links and five visible notices fit their table bounds.
- The source detector returned zero findings on the profile components, routes and adjacent stylesheet. Across twelve rendered desktop/phone scans, the detector reported 16 single-word last lines and two unequal-column warnings. Inspection showed a longer document table beside a shorter account sidebar. Direct bounds checks measured the actual narrow-width overflow separately. Production CSP blocked the optional live overlay. The command-line detector, normal browser and accessibility tree supplied the evidence.
- The data capture used 445 of 445 ASX notices through 6 November 2026. The US snapshots retain the reporting and filing dates of the SEC originals. A browser request verified the external link targets. PDF hosting and publisher access vary by source.
- The final 28 interaction journeys passed. Axe 4.11.1 reported zero violations in 24 full-page scans and 14 expanded-state scans. Axe left two rule families for human inspection on the full page, including inline links. Source link ink and names were checked separately. The production build, TypeScript, route contracts, 680 targeted Jest tests and five public-account crawler tests passed. ESLint reported zero errors. The bundle comparison reports no regressions. The existing strategy signals route is 151 kB against its 150 kB budget.

## Remaining work

**P2 · Anonymous page weight.** The shared dashboard starts downloading its sidebar even when the visitor is signed out. Measure an anonymous versus signed-in trace before changing the shared loader. This review measured local bundles and browser behavior. Field INP and LCP require traffic measurements.

**P3 · Footer typography.** The shared disclosure ends with a single word on some phone widths. It remains readable and no longer widens the document at 200% text.

The test environment was desktop Chromium with emulated mobile touch. Physical iOS/Safari and VoiceOver/NVDA are outstanding validation environments.
