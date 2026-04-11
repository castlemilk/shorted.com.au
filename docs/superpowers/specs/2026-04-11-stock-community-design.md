# Stock Community Design

Date: 2026-04-11
Project: Shorted.com.au
Status: Approved for planning

## Summary

Shorted should add a stock-page-first community layer that helps users interpret short-interest data together, without turning the product into a generic message board.

The recommended v1 is:

- Keep the existing stock detail page structure intact.
- Add a new `Community` tab to stock pages.
- Add a compact community teaser to the `Overview` tab so discussion is visible before the user opens the tab.
- Split the community experience into two surfaces:
  - `Research Threads` for durable, evidence-first posts and comments.
  - `Live Pulse` for fast reactions and short-form updates tied to the stock.
- Allow public read access and require signed-in users to post.
- Use AI as a support layer for summaries and synthesis, not as the primary social surface.

This design is intended to improve:

- research quality through better bull/bear/catalyst discussion,
- market pulse through current stock-specific chatter,
- retention through repeat-return discussion loops on each stock page.

## Context

The current product is strong on data surfaces and individual research tools:

- stock detail pages with short-interest charts and company data,
- top-shorted and screener surfaces,
- reports and editorial content,
- a premium AI chat product.

What is currently missing is a shared interpretation layer. Users can inspect short-interest data, but the app does not yet help them understand:

- what other informed users think matters right now,
- which catalysts are being debated,
- whether sentiment has shifted around a stock,
- which arguments are strongest on the bull and bear sides.

This gap is especially visible because the product already has enough structured data to anchor high-quality stock conversations. A community surface can compound the usefulness of the existing data instead of replacing it.

## Goals

- Make stock pages feel more alive and useful by exposing active, stock-specific discussion.
- Improve research quality by encouraging durable, evidence-backed threads rather than only short-form chatter.
- Surface current pulse and changing sentiment without letting the page devolve into noise.
- Keep the primary stock data experience intact on the overview page.
- Create a repeat-return loop that increases retention for individual stock pages.
- Use AI to summarise and synthesise community activity where it adds clarity.

## Non-Goals

- Do not build a full HotCopper replacement in v1.
- Do not launch a market-wide Reddit-style home feed in v1.
- Do not add DMs, social graphs, following, or notifications beyond basic future-ready hooks.
- Do not merge public community content into the existing private AI conversation model.
- Do not redesign the stock page into a community-first destination that demotes the chart and company data.

## Product Decisions Confirmed During Brainstorming

- Community starts on stock pages, not in a global feed.
- The primary interaction model is hybrid:
  - durable Reddit-style posts and comments for high-signal research,
  - a faster live pulse stream for short-form updates.
- Read access is public.
- Posting requires a signed-in account.
- Community should be visible from the stock page overview, but the full experience lives in a dedicated `Community` tab.
- “Chat more prominent” refers to community and forum behavior, not the existing AI assistant.

## User Experience

## Stock Page Entry Points

### Overview Tab

The `Overview` tab remains the default stock destination and keeps data primary. It gains a compact community teaser placed below the main chart and key stock data, not above the stock identity block.

The teaser contains:

- a `Live on {stockCode}` or `Community` label,
- a small pulse score or activity count,
- the current most active discussion headline,
- a short line indicating freshness such as `12 new pulse notes today` or `Most discussed in the last 24h`,
- a clear `Open Community` affordance.

The teaser is intentionally compact. Its job is discovery, not full reading.

### Community Tab

The stock tab bar gains a new `Community` tab:

- `Overview`
- `News`
- `Financials`
- `Directors`
- `Dividends`
- `Peers`
- `Community`

The `Community` tab uses a two-column layout on desktop:

- left/main column: `Research Threads`
- right rail: `Live Pulse` and stock discussion signals

On mobile:

- `Research Threads` render first,
- `Live Pulse` collapses into a section beneath the threads or into a sub-tab/accordion inside the community tab.

### Thread URLs and Shareability

Research threads should be shareable public pages, not only tab-local state.

Recommended route shape:

- stock page tab entry: `/shorts/{stockCode}` with `Community` selected client-side,
- shareable thread detail route: `/shorts/{stockCode}/community/{threadId}`.

This allows:

- public linking,
- SEO indexing for high-quality public discussion,
- direct access from social shares or search,
- cleaner analytics on thread views.

The community tab list can still open threads inline or in-place, but every thread should have a canonical route.

## Community Tab Structure

### Research Threads

This is the durable discussion surface for posts that should still be useful later.

Thread types:

- `Bull`
- `Bear`
- `Catalyst`
- `Question`
- `News Reaction`

Each thread card should show:

- title,
- author handle and lightweight reputation badge,
- type label,
- score,
- comment count,
- source count,
- timestamp,
- optional “summarised by AI” or “high signal” marker when applicable.

Each thread detail view includes:

- thread body,
- links/sources,
- comment tree,
- vote actions,
- report action,
- AI utilities such as `Summarise thread` or `Bull vs bear recap`.

### Live Pulse

This is the fast-moving stock-specific short-form layer.

Pulse items are brief observations like:

- broker note reactions,
- catalyst chatter,
- short-interest interpretation,
- price reaction context,
- quick questions to the community.

The pulse rail supports:

- very short posts,
- fast replies,
- recency-first ordering,
- lightweight moderation,
- inline conversion into a full thread when a pulse item becomes meaningful enough.

The pulse rail should feel alive, but it must remain clearly secondary to the research thread column.

### Discussion Signals

The community rail should also show stock-specific synthesis, such as:

- most cited theme,
- sentiment tilt,
- most active contributors,
- biggest change since yesterday,
- count of new research posts in the last 24h.

These help users quickly interpret the state of discussion without reading everything.

### Empty and Low-Activity States

The design must work when a stock has no discussion yet or only light activity.

Overview teaser empty state:

- show `No community activity yet` or `Be the first to discuss {stockCode}`,
- keep the card compact,
- provide a single signed-in CTA such as `Start Discussion`.

Community tab empty state:

- explain the difference between `Research Threads` and `Live Pulse`,
- show one primary CTA to create the first thread,
- optionally seed with prompt ideas such as:
  - `What is the bull case here?`
  - `What are the next catalysts?`
  - `Is short interest likely to rise or fall?`

Low-activity state:

- still render the same layout,
- avoid oversized empty containers,
- show the most recent post and pulse item even if counts are low.

## Relationship to Existing AI Chat

The current floating AI chat sidebar remains available, but it should stop being the most visually aggressive interaction on stock pages once community launches.

Design direction:

- The stock page should feel community-first for social interpretation.
- The AI assistant should become an assistive layer for understanding community and stock data.

Recommended changes after community launch:

- Keep the standalone `/chat` product.
- Reduce the stock-page emphasis of the floating AI affordance over time.
- Add contextual AI actions inside community instead:
  - `Summarise this thread`
  - `What changed since yesterday?`
  - `Explain why sentiment shifted`
  - `Ask AI about this stock`

This keeps AI useful without making it compete with the new community surface.

## Information Architecture

## Public vs Authenticated Behavior

### Public users

- can read community teaser on the overview page,
- can browse the community tab,
- can read research threads, comments, and pulse items,
- cannot post, vote, or report until signed in.

### Signed-in users

- can create research threads,
- can create pulse items,
- can comment,
- can vote,
- can report content,
- can save or follow threads later if that is added in a future phase.

### Premium users

Premium should not gate core reading or posting for v1. Community needs enough breadth to create real value. Premium differentiation should come from AI synthesis and advanced utilities, not basic access.

Possible premium-only features later:

- advanced AI summaries,
- contributor filtering,
- “follow this stock discussion” alerts,
- deeper discussion analytics.

## Data Model

## Storage Choice

Community content should use Firestore for v1.

Reasons:

- the app already uses Firebase/Firestore for authenticated user-linked data,
- public community content is a separate domain from private AI chat conversations,
- live pulse benefits from low-friction realtime reads,
- server-side write actions can still enforce auth, moderation, and rate limits,
- this avoids forcing forum behavior into chat tables designed for one-user/one-assistant conversation history.

The existing chat Postgres store remains unchanged and private.

## Core Collections

Suggested Firestore structure:

```text
stock_communities/{stockCode}
stock_communities/{stockCode}/threads/{threadId}
stock_communities/{stockCode}/threads/{threadId}/comments/{commentId}
stock_communities/{stockCode}/pulse/{pulseId}
stock_communities/{stockCode}/pulse/{pulseId}/replies/{replyId}
community_users/{userId}
community_reports/{reportId}
```

### `stock_communities/{stockCode}`

Purpose:

- stock-level summary state and aggregate counters

Fields:

- `stockCode`
- `displayName`
- `pulseScore`
- `activeThreadId`
- `activeHeadline`
- `newPulseCount24h`
- `newThreadCount24h`
- `sentimentTilt`
- `mostCitedTheme`
- `updatedAt`

### `threads/{threadId}`

Purpose:

- durable research posts

Fields:

- `threadId`
- `stockCode`
- `type`
- `title`
- `body`
- `authorId`
- `authorHandle`
- `authorReputationSnapshot`
- `sourceLinks`
- `sourceCount`
- `score`
- `commentCount`
- `viewCount`
- `status`
- `aiSummary`
- `highSignal`
- `createdAt`
- `updatedAt`
- `lastActivityAt`

Allowed `status` values:

- `active`
- `hidden`
- `deleted`
- `needs_review`

### `comments/{commentId}`

Purpose:

- replies on research threads

Fields:

- `commentId`
- `threadId`
- `parentCommentId` nullable for nested replies
- `body`
- `authorId`
- `authorHandle`
- `score`
- `status`
- `createdAt`
- `updatedAt`

### `pulse/{pulseId}`

Purpose:

- short-form updates for fast stock discussion

Fields:

- `pulseId`
- `stockCode`
- `body`
- `authorId`
- `authorHandle`
- `score`
- `replyCount`
- `status`
- `createdAt`
- `updatedAt`

### `pulse/{pulseId}/replies/{replyId}`

Purpose:

- flat replies on pulse items

Fields:

- `replyId`
- `pulseId`
- `body`
- `authorId`
- `authorHandle`
- `score`
- `status`
- `createdAt`
- `updatedAt`

### `community_users/{userId}`

Purpose:

- lightweight public contributor state

Fields:

- `userId`
- `handle`
- `reputation`
- `trustedContributor`
- `threadCount`
- `commentCount`
- `pulseCount`
- `reportCount`
- `joinedAt`

### `community_reports/{reportId}`

Purpose:

- moderation workflow input

Fields:

- `targetType`
- `targetId`
- `stockCode`
- `reportedBy`
- `reason`
- `status`
- `createdAt`

## Ranking

## Research Threads Ranking

Research threads should rank on a score that combines quality and freshness.

Inputs:

- vote score,
- comment depth,
- source count,
- contributor reputation,
- freshness with time decay,
- moderation state,
- stock-specific recency spikes.

Recommended ranking intent:

- good research stays visible longer,
- new high-quality threads can still break through,
- low-effort, unsupported posts decay quickly,
- recently active threads can re-surface without overriding clearly better long-term posts.

Views:

- `Top`
- `New`
- `Bull`
- `Bear`
- `Catalyst`
- `Question`
- `News Reaction`

## Live Pulse Ranking

Live pulse is primarily recency-ordered.

Inputs:

- created time,
- reply activity,
- light score weighting,
- spam and rate-limit suppression,
- moderation state.

Ranking intent:

- users can quickly see what is being discussed now,
- pulse remains current,
- spam and repeated low-value updates get damped.

## Moderation

Community quality is the make-or-break risk for this feature. Moderation must exist from day one even if it is simple.

## Required v1 Controls

- signed-in posting only,
- per-user rate limits for threads, comments, and pulse items,
- server-side validation and sanitisation,
- report action on threads, comments, and pulse items,
- soft delete and hide states,
- banned-word / suspicious-link heuristics,
- ability to mark content `needs_review`,
- basic contributor trust score,
- admin moderation surface or admin-only query path for flagged items.

## Trust Model

Users gain trust through:

- posting content that gets votes and replies,
- posting source-backed threads,
- staying below report thresholds,
- sustained good behavior over time.

Users lose trust through:

- repeated reports,
- repeated low-value content,
- spam patterns,
- moderation actions.

Trust should influence:

- slight ranking boosts,
- allowed posting velocity,
- whether content is auto-published or more aggressively checked.

## AI Integration

AI should support human discussion, not replace it.

## AI Features in Scope for v1

- generate one short stock-level community recap for the overview teaser,
- summarise a research thread,
- summarise pulse activity over the last 24 hours,
- extract key bull vs bear themes from current discussion.

## AI Features Out of Scope for v1

- auto-generated AI posts into the community feed,
- AI agents debating each other,
- fully autonomous moderation decisions,
- AI-generated contributor profiles,
- replacing discussion with a chat-first interface.

## Suggested AI Placement

- overview teaser summary line,
- thread detail utility actions,
- optional “community recap” module in the right rail.

AI outputs must be clearly labeled as summaries and should cite underlying posts or linked evidence when possible.

## Server and Application Architecture

## Write Path

Writes should go through authenticated server actions or API handlers rather than direct client writes.

Reasons:

- consistent auth enforcement,
- rate limiting,
- content normalization,
- link validation,
- moderation hooks,
- easier future portability if storage changes later.

Examples:

- `createThread(stockCode, input)`
- `createComment(threadId, input)`
- `createPulse(stockCode, input)`
- `voteOnCommunityItem(targetType, targetId, direction)`
- `reportCommunityItem(targetType, targetId, reason)`

## Read Path

Read strategy:

- overview teaser should use a stock-community summary fetch optimized for SSR,
- thread lists can hydrate client-side after an initial server-rendered shell,
- pulse can use client fetch or realtime Firestore listeners where appropriate,
- public reads should be cache-aware but freshness-sensitive,
- thread detail routes should support direct public loads without requiring prior navigation through the stock tab UI.

## Interfaces and Boundaries

To keep the implementation understandable and testable, use clear units:

- `community data access` for Firestore reads and writes,
- `community ranking service` for thread and pulse ordering,
- `community moderation service` for heuristics and report flow,
- `community UI` for teaser, tab, thread list, thread detail, and pulse rail,
- `community AI summary service` for recap generation.

Each unit should be independently understandable and testable.

## Rollout Plan

## Phase 1: Foundation

- add Firestore collections and server-side write/read layer,
- add community teaser data shape,
- build the `Community` tab skeleton,
- implement thread creation, listing, and viewing,
- implement comments,
- implement pulse creation and listing,
- implement public read and signed-in post gating.

## Phase 2: Quality Controls

- add votes,
- add reports,
- add rate limits,
- add trust and moderation state,
- add basic admin moderation visibility.

## Phase 3: AI Support

- add overview teaser recap,
- add thread summary action,
- add pulse recap.

## Deferred Phases

- market-wide community feed,
- contributor profiles and following,
- community notifications and alerts,
- advanced AI insight products,
- richer media support.

## Testing Strategy

This feature must be validated end to end, not only at the component level.

## Unit Tests

- ranking calculations for research threads,
- ranking and recency behavior for pulse,
- moderation heuristic functions,
- teaser summary mapping,
- permission checks for public vs signed-in users.

## Integration Tests

- server action write flows to Firestore,
- stock-community summary reads,
- thread/comment creation and retrieval,
- report flow,
- vote updates,
- trust score update paths.

## End-to-End Tests

Required e2e scenarios:

- public user can read stock community teaser and thread list,
- unauthenticated user is prompted to sign in when attempting to post,
- signed-in user can create a research thread,
- signed-in user can comment on a thread,
- signed-in user can create a pulse item,
- overview teaser updates when community activity exists,
- community tab is reachable from the stock page and works on desktop and mobile,
- reported content changes moderation state as expected in the admin flow or test harness,
- AI recap surfaces only when underlying content exists and does not block page use if unavailable.

## Design Principles for Implementation

- The stock chart and company data remain primary on `Overview`.
- The overview teaser must stay compact and information-dense.
- The community tab should feel modern and premium, not generic or cluttered.
- Research threads should be clearly more important than pulse.
- Pulse should add immediacy without dominating the page.
- AI should clarify discussion, not become the discussion.

## Risks

## Low-Signal Community Risk

If thread ranking and moderation are weak, the feature will quickly feel noisy and reduce trust in the product.

Mitigation:

- signed-in posting,
- source-aware ranking,
- report tools,
- trust scoring,
- strong thread-type structure.

## Surface Competition Risk

If the overview teaser is too large, it will compete with the stock chart and degrade the existing page.

Mitigation:

- keep teaser compact,
- place it below primary stock analysis modules,
- validate with responsive UI review.

## AI Overreach Risk

If AI becomes the main community experience, the feature will feel synthetic and may undermine contributor trust.

Mitigation:

- use AI only for recap and summary,
- keep human posts primary,
- label AI outputs clearly.

## Why This Is the Recommended Direction

This design gives Shorted a meaningful new layer of usefulness without breaking the current product.

It works because it:

- attaches discussion to the strongest existing object in the product: the stock page,
- preserves data-first behavior on the overview page,
- separates durable analysis from fast pulse,
- creates room for AI to add value as synthesis,
- lays a clean foundation for a future market-wide feed if the stock-specific experience proves valuable.

This is a focused v1 that improves research quality, pulse, and retention without trying to build an entire social platform at once.
