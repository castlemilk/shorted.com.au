# Data sources

Every field, where it comes from, and what licence it carries. Audited
2026-07-31 with an adversarial verification pass; each licence position below was
fetched and quoted, not recalled.

The governing rule is [`influence-editorial-standards.md`](../../influence-editorial-standards.md)
§4:

> Public figures acting in public capacity (donations, declared interests,
> awarded contracts) are in scope. Private individuals, family members not on a
> register, home addresses, and **any data obtained other than from official
> publications are out of scope, full stop.**

Confirmed by the owner 2026-07-31: **§4 stands. Structured facts only, no
free-text biography.**

## IN

| Source | Licence | Gives us | Coverage |
|---|---|---|---|
| **APH Register PDFs** (`aph.gov.au`) | CC BY-NC-ND 4.0 | The declarations themselves | 769 House docs, parliaments 44–48 |
| **APH Parliamentary Handbook OData** (`handbookapi.aph.gov.au/api/individuals`) | CC BY-NC-ND 4.0 | `aph_phid` identity key, occupations, qualifications, preferred name | **309/324** matched |
| **Wikidata / Wikimedia Commons** | CC0 (data), per-file free licences (images) | Portraits, QIDs, position-held | **241/324** portraits |
| **AEC tally room** (`results.aec.gov.au`) | CC BY 4.0 | Division/party vintage | federal 2025 |
| **ABS** (ASGS boundaries, Census) | CC BY 4.0 | Suburb resolution for item 3 | ~15,000 SALs |

### APH is NC-ND, and that matters

`aph.gov.au/Help/Disclaimer_Privacy_Copyright`, verbatim: material is provided
under **CC BY-NC-ND 4.0**. Two consequences the subsystem is built around:

- **NC** — this is a paid product. We publish extracted *facts*, and facts carry
  no copyright to licence. That posture is what makes the use defensible; it is
  not a licence grant we rely on.
- **ND** — no adaptation. So a Handbook occupation string is stored **verbatim as
  the atom it is** and never rewritten, re-worded or assembled into prose. There
  is no biography field and there is not meant to be.

A corollary that bit once: `/politicians` JSON-LD declared `creator: Shorted` and
`license: <the APH copyright page>` on one `schema.org/Dataset`, machine-asserting
an NC-ND grant that is not ours to make. Fixed — the source relationship belongs
in `sourceOrganization`, never `license`.

### handbookapi is not WAF-walled

`www.aph.gov.au` blocks a normal request and needs the nil-UA technique
(architecture.md §1.1, "the WAF is inverted"). **`handbookapi.aph.gov.au` does
not** — a plain request with an honest User-Agent returns 200. Do not reach for
the nil-UA trick there.

## OUT — and these are settled, not deferred

### LinkedIn

**Do not revisit.** Three independent reasons, any one sufficient:

1. `robots.txt` is `User-agent: * / Disallow: /`.
2. The User Agreement prohibits scraping, *and separately* prohibits: "Copy, use,
   display or distribute any information (including content) obtained from the
   Services, whether directly or through third parties (such as search tools or
   data aggregators or brokers), without the consent of the content owner." That
   second clause kills the **display** case even via a broker — and a CRM's whole
   purpose is to display.
3. **There is nothing to gain.** The clean-licence proxy — Wikidata P6634 — is
   populated for **9 of 324 = 2.8%** of the corpus, and APH member pages carry
   *zero* linkedin.com links. The pre-politics career content people want from it
   is already available from the Handbook API (occupations 92%).

The REA/Domain precedent does **not** license it: those rows are marked
`source_licence='proprietary-tos-restricted'` and *never republished*. That gate
is the entire justification, and a CRM cannot satisfy it. These are also named
natural persons, not companies, which engages the Privacy Act. (hiQ v LinkedIn is
not a defence — it held only that the CFAA did not bar scraping public profiles,
and hiQ was subsequently found to have breached the User Agreement. It is a US
case with no Australian analogue.)

### X / Twitter

Scraping is prohibited (`Disallow: /`, and the ToS says so expressly). The API is
separately blocked for this use by the Developer Policy's **off-X matching** rule:
associating a handle with a person requires "express opt-in consent from the
person before making the association". We will not have that from 226 MPs.

**The safe carve-out, which is what we use:** the handle read from the member's
own `aph.gov.au` page or from Wikidata P2002 is an APH/CC0-published *fact about
the member*, not X Content obtained from X. Store the URL, render an outbound
link with an as-at date, **fetch nothing from x.com**, and never render a
follower count or verification claim.

### Personal / campaign websites

No licence at all — all-rights-reserved by default under the Copyright Act 1968,
and none of the sampled sites publishes reuse terms. It is also campaign
material: reproducing a member's self-description as a register fact breaches
rule 1. These sites routinely carry family photographs and names — precisely what
§4 excludes. **Store the URL only** (from the APH "Connect" block or Wikidata
P856); never fetch, parse, cache or display the content.

### Hansard / ParlInfo, PM&C ministry list

403 and Incapsula respectively. Getting in means evasion, which the collector's
own `errSourceUnavailable` rule forbids — **a block is a signal, never route
around it**. Redundant anyway: `/api/ministryrecords` serves the same data,
structured and PHID-keyed. Deep-link to ParlInfo instead.

### English Wikipedia prose and page images

CC BY-SA is viral onto a proprietary surface. And enwiki **page images can be
local fair-use uploads** — measured, 3 of a 20-person sample returned an unknown
licence. Take the sitelink as a link; take every fact from Wikidata (CC0); take
portraits from P18, which always resolves to Commons, where a free licence is
policy.

## Portraits: why not the obvious source

Every sitting member has a portrait on aph.gov.au. We do not use it.

A portrait is an **artefact**, not an extracted fact, and §3.1's posture is that
artefacts are not mirrored. Photographs are also the likeliest part of that corpus
to carry a separate photographer/AUSPIC copyright on top of the Commonwealth's.
(It was moot anyway: `aph_mpid`, the natural key to those images, is **0 of 324**
populated — the load never writes it.)

So: **Wikidata P18 → Wikimedia Commons**, matched on **surname + electoral
division** (member) or **surname + state** (senator — Wikidata puts the state in
P768 for them, measured 400/400).

**Never a name search.** A Wikipedia name search matched "Anthony Smith" to
**Dean Smith** — a different sitting member. Any ambiguity withholds.

**Attribution is a licence obligation, enforced in four places** — CC BY and CC
BY-SA permit publication only *with* the credit and a link to the terms:

1. a database CHECK (`politicians_photo_needs_attribution`)
2. `scanPolitician` blanks the URL if licence or source is missing
3. the proto and the Algolia record carry the four fields together
4. `PoliticianAvatar` refuses to render an image it cannot attribute

Licence spread of the 241: CC BY 4.0 ×69, CC BY-SA 4.0 ×45, CC BY 2.0 ×30,
CC BY 3.0 ×19, public domain ×18, CC0 ×12, and 7 more.

## Open owner decision

**TheyVoteForYou / OpenAustralia** — per-MP division votes exist nowhere else.
Their terms say "contact us for commercial use" and licence member data CC BY-SA
2.5. **Decision needed: email the OpenAustralia Foundation to negotiate, yes/no?**
Do not use it for identity, bio or roles under any circumstances — the Handbook
API dominates it there. If adopted, honour `ai-train=no`: never feed it to the
Gemini extraction tier.
