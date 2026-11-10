# Pilot protocol and paid validation

Run a six-week founding pilot around useful ASX research, then test paid continuation of a delivered monitoring-and-evidence workflow. Keep community participation, research usefulness and commercial demand as separate decisions.

**Protocol version: 10 November 2026.** The 24-person cohort, three circles and original participation thresholds are preserved from the community strategy. The event definitions, clock and commercial thresholds below make that experiment executable. Recruitment, usage, payments and outcomes have not yet been established by this protocol.

# Cohort and preparation

Recruit 24 consenting founders, with the earlier planning mix of approximately 16 engaged private investors, six researchers/sector specialists and two occasional journalist/educator participants. This is a recruitment hypothesis. Select roughly six companies from actual participant overlap and available, interpretable data.

Maintain a private roster with participant ID, recruitment source, consent, primary circle, additional circles, voluntary company interests, intended research task and existing tools. Each founder has one primary circle for denominator calculations; additional participation is welcome. Staff, paid/commissioned contributors and unpaid members are recorded separately at the time of each contribution.

Each circle needs a named host and backup, at least six interested people and two committed regular contributors. Prepare one source-linked briefing and real unresolved questions. Host-authored prompts remain labelled as host work and never satisfy the genuine member-question demand gate.

Before Day 0, verify:

- Public identities are safe; replies persist through reload and other-reader access.
- Hidden/review-held content stays out of public/detail/cache paths.
- Disclosures, report/correction workflow, mute/block rules and hosts are ready.
- The actual storage adapter, source coverage and cohort event queries have been tested.
- The minimum useful-response acknowledgement in #963 works.
- The launch model and source uses have been reviewed for the actual features offered.
- Each founder knows the optional nature of participation and notifications.

Day 0 is the recorded start after these conditions pass. It is not the first engineering day or an invitation date.

# Pilot clock

| Period | Work |
| --- | --- |
| Before Day 0 | Interviews, interest overlap, source checks, hosts, roster, controls and instrumentation rehearsal |
| Weeks 1–2, Days 0–13 | Onboarding and first real tasks; activation gate at the end of Day 13 |
| Weeks 3–4, Days 14–27 | Improve the same workflow; investigate missing replies and confusing evidence; retain the same circles |
| Weeks 5–6, Days 28–41 | Measure repeated meaningful use, non-staff contribution and operational effort |
| After Week 6 | Allow every eligible final question its full 48-hour response window, then freeze the social-pilot dataset |
| Continuation month 1 | Show the defined paid offer to eligible users; record payments, output use, support and cancellation |
| Second paid period | Record renewal and continued workflow use before declaring the commercial gate passed |

Store event times in UTC; define weekly reporting boundaries in Australia/Melbourne and record the exact UTC boundaries for the run. This prevents ambiguous weeks and daylight-saving errors.

# Task interviews

Use the participant's last completed research task, then a comparable task using Shorted.

1. Which ASX companies did you actively research in the last month?
2. Show the most recent question you tried to answer and what prompted it.
3. Walk through the sources, tools and files you used.
4. Which step took effort or left uncertainty?
5. What did you save, send or change afterwards?
6. Which tools do you pay for, and what job does each earn its place doing?
7. When did another person's explanation last change your understanding?
8. Which proposed circle matches your interests, and can you contribute to a real question regularly?
9. Complete a comparable task with Shorted; point out evidence that is missing, ambiguous or difficult to verify.
10. At continuation, make a purchase decision on the actual scope and price, then record the reason.

For a journalist, use a recent article/chart verification task. For an analyst, use a coverage update. Record tool substitution and retained tools; interest in Shorted does not imply replacing an existing subscription.

Measure observed elapsed work, verification errors, sources checked and final output. Keep historical self-reported time distinct from timed observation. Improve comparability through matched task complexity; describe practice/order effects rather than presenting a tiny before/after sample as causal proof.

# Meaningful actions and useful replies

A meaningful research action is a persisted question, substantive reply, source-backed note/revision, or a saved research item tied to a task. A reading-only journey can qualify when the participant inspects the source and records a task-linked save or takeaway. A sign-in, notification open, scroll or isolated link click does not establish meaningful use.

A useful reply addresses the question, supplies an explanation or usable source, gets material dates/units right, distinguishes evidence from interpretation and makes remaining uncertainty clear. A source URL or a favourable trading opinion does not itself satisfy the rubric.

Record whether usefulness was acknowledged by the asker, another reader or a reviewer. For the 48-hour metric, the reply's publication time is the response deadline; later acknowledgement/audit may classify it as useful. Keep the acknowledgement time separately. Review all eligible questions at this small scale and record disagreements rather than allowing a reaction count to decide quality.

# Preserved community gates

| Gate | Exact calculation |
| --- | --- |
| At least 18/24 activate in weeks 1–2 | Follow a relevant company/circle and perform one meaningful research action by Day 13 |
| At least 70% of at least 20 genuine member questions receive useful answers within 48 hours | Question is from a non-staff member, within scope and has a full observation window; useful response is published within 48 hours. Show staff, paid contributor and unpaid-peer results separately |
| At least two regular non-staff contributors per circle | Primary-circle member contributes substantively in both weeks 5 and 6; cross-circle help is reported separately |
| At least six distinct non-staff contributors in each of the final two weeks | Deduplicated across the cohort in each week; disclose paid vs unpaid composition |
| At least 12/24 return meaningfully in both weeks 5 and 6 | Intersection of the weekly participant sets; two different groups of 12 do not pass |
| At least half of substantive final-two-week contributions come from unpaid non-staff participants | Distinct quality-reviewed contributions, with actor role captured at the time; also show distinct authors |
| At least eight participants identify a specific benefit | Resolved question, corrected mistake or research task made easier, linked to the relevant work |
| Human operation stays within the agreed 8–12 hours/week | Log hosting, brief preparation, facilitation, moderation and measurement; engineering/legal work is separately visible |
| Paid workflow demand | Apply the separate continuation protocol; a social pass does not imply a payment pass |

Keep the original 24 in the primary activation/retention denominator. Withdrawals, late arrivals and incomplete onboarding remain visible. If a deletion requirement prevents complete measurement, report the affected count and status without retaining prohibited identity data; do not silently improve the denominator.

Exclude questions only for predeclared reasons such as spam, exact duplicates or moderator removal, retaining an exclusion reason. Difficult unanswered questions stay in the denominator. If fewer than 20 genuine questions qualify, the response gate is insufficient evidence.

Use four result states: pass, fail, insufficient evidence and invalid measurement. Invalid instrumentation is repaired before a result is interpreted. For insufficient evidence, extend the same bounded experiment or narrow it; do not announce an expansion success.

If fewer than eight original founders perform a meaningful action in the final week, or staff still supply most useful work, pause additional-circle expansion and test a smaller research club or watchlist digest. If participation is between that stop signal and the 12/24 retention gate, revise the current pilot before expanding.

# Analytics contract

Maintain a permissioned durable ledger for pilot analysis. The existing product-event helper is an operational counter/logger with a limited property allowlist; it cannot be assumed to retain arbitrary actor/question IDs. Keep user/object IDs out of metric label dimensions.

The proposed event envelope contains event_id, schema_version, occurred_at_utc, recorded_at_utc, cohort_id, actor_id, actor_role_at_event, primary_circle_id, company_id, object_id, action_kind, source_id and bounded properties. Public reports contain aggregates, not roster identities or investment disclosures.

| Event group | Minimum actions |
| --- | --- |
| Joining and intent | cohort_joined, company_followed, question_followed |
| Research | question_published, reply_published, source_opened, research_saved, research_revised |
| Usefulness | response_acknowledged, acknowledgement_revoked, response_reviewed |
| Operations | report_submitted, moderation_action_recorded, host_time_logged |
| Delivery and value | brief_reviewed, packet_created, packet_reused_for_task |
| Commercial | continuation_offer_shown, continuation_payment_succeeded, continuation_cancelled, continuation_refunded, continuation_renewed |

Persist successful mutation events transactionally or through an idempotent outbox, not from an optimistic button click. Separate attempted actions from completed actions. Use an immutable event ID and maintain historical role/compensation classification.

Required query fixtures cover duplicate events, staff-seeded questions, self-awards, a reply at 47:59 versus 48:01, late joins, withdrawals, overlapping circles, two different weekly user sets, revoked acknowledgement and missing instrumentation. Exports must state their cohort version, clock boundaries and query version.

# Operating budget

| Work | Proposed hours per week |
| --- | ---: |
| Three source-linked circle briefings and preparation | 3 |
| Three bounded discussions including preparation | 2.25 |
| Weekday moderation triage | 1.25 |
| Introductions and unanswered-question facilitation | 1 |
| Measurement review and short task interviews | 1.5 |
| Incident or absence reserve | 1–3 |
| Total | 10–12 |

Use asynchronous discussions where that better fits members' schedules. Record actual minutes and contributor compensation. A host answering every question is visible operating work, not peer adoption.

Exceeding 12 hours in two consecutive weeks triggers scope/cost review before expansion. Record time per useful answer and per retained researcher; do not assume unpaid founder labour is free.

For scale only, an assumed A$50/hour makes 8–12 hours/week approximately A$1,733–2,600/month using 52/12 weeks per month. All 24 founders paying A$19 would produce A$456/month before taxes, fees and other costs. These are arithmetic scenarios, not wage estimates or forecasts. The pilot tests value; its staffing model is not a demonstrated subscription business.

# Paid continuation

## Eligibility and offer

Before examining conversion outcomes, define an eligible investor as a consenting founder in the target segment who used the workflow in at least two separate pilot weeks, inspected an original source and saved a question, note or packet for a real task.

Offer the same initial scope at **A$19 per month, monthly billing**, to eligible participants. Set and disclose practical usage limits before the offer. State total payable amount, applicable tax treatment, renewal/cancellation behaviour and support scope. Show the treatment of any existing subscription and prevent double charging. Current subscribers are not automatically moved.

The bounded offer is a saved coverage list, controllable recurring change brief, persistent review/saved-question state and dated packets in the supported export format. The paid test begins only after those promises work. A manually curated early version must say what is manual and what support is included.

Do not split 24 founders into a price A/B test. Keep the earlier A$19–29 investor range and professional/team price ranges as hypotheses for later work.

## Commercial gate

The proposed first gate is at least four paid continuations from ten or more eligible people actually offered the product, followed by at least three still using it and paying into the second period. Count actual successful payment, not a checkout visit or stated intent. Fewer than ten offers is insufficient evidence; refunds and cancellations remain in the record.

Report original cohort, eligible, offered, paid, refunded/cancelled and renewed counts. Also report how many offers were not made and why. Record payment provider errors separately from product rejection.

| Community result | Paid result | Next decision |
| --- | --- | --- |
| Pass | Pass | Consider one additional circle and improve the paid workflow; keep cost controls |
| Pass | Fail/insufficient | Keep a bounded useful community and revise the paid job/offer |
| Fail/insufficient | Pass | Prioritise the paid monitoring workflow with a smaller hosted research group |
| Fail | Fail | Narrow the task or stop this expansion path; preserve the evidence |

## Economics

Monthly contribution per payer is net receipts after applicable tax/refunds, minus payment fees, variable data/delivery/model costs and attributable support/checking time at an explicit hourly cost. Report shared hosting/research separately and show the result under different allocation assumptions.

A professional/team build needs an observed recurring work product, a budget holder and acceptable source-rights/support economics. Preserve discovery for those segments without treating titles or expressions of interest as purchases.

# Work ownership and evidence

[#956](https://github.com/castlemilk/shorted.com.au/issues/956) owns the cohort, clock, ledger and social gate report. [#963](https://github.com/castlemilk/shorted.com.au/issues/963) supplies the minimum acknowledgement. [#954](https://github.com/castlemilk/shorted.com.au/issues/954) and [#955](https://github.com/castlemilk/shorted.com.au/issues/955) own disclosures and moderation. [#972](https://github.com/castlemilk/shorted.com.au/issues/972) owns the offer, entitlement matrix and commercial record. Hosts and engineering owners are roles to assign; the inspected issues were unassigned.

Each weekly record should contain exact counts, denominator/exclusion notes, three concrete task examples, unresolved data or moderation problems, actual hours and the decision for the next week. Keep participant-level notes private.

Use [the implementation plan](https://github.com/castlemilk/shorted.com.au/blob/research/asx-community-market-positioning-20261110/docs/research/2026-11/Shorted_Implementation_Plan_2026-11-10.md) for dependencies and [the research update](https://github.com/castlemilk/shorted.com.au/blob/research/asx-community-market-positioning-20261110/docs/research/2026-11/Shorted_Strategy_Research_Update_2026-11-10.md) for the evidence behind the workflow and source-rights choices. The original [community launch plan](https://github.com/castlemilk/shorted.com.au/blob/research/asx-community-market-positioning-20261110/docs/research/2026-11/Shorted_Community_Strategy_and_Launch_Plan_2026-11-10.md) remains the strategic baseline.

