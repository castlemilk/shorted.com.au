# Signup measurement — prepared 3 October 2026

GA collection is limited to the exact browser hostnames `shorted.com.au` and
`www.shorted.com.au`. Localhost, arbitrary subdomains and Vercel previews neither
initialise the app's GA loader nor send custom events through `sendGaEvent`.
Existing traffic in the property is not retrospectively removed.

The `/signup` form emits Google's recommended `sign_up` event when a newly
created account has completed Shorted sign-in and `getSession()` returns a
session. `method` is either `email` or `google`; `surface` is `/signup`.
Google users must have Firebase `isNewUser === true`, so signing into an
existing account from that form is not counted as acquisition. Unknown new-user
status fails closed. Failed authentication or a missing session produces no
signup event. This measures completed onboarding through this form, not all
account creation paths, payment, watchlist creation or ongoing activation.

The new event overrides `page_location` with the fixed signup URL and
`page_referrer` with the referring origin only. No user IDs, email addresses,
names, tokens, credentials, callback URLs or error messages are passed.
SPA page views also omit query strings from their explicit path/location
parameters. Initial GA configuration keeps its existing defaults; this is not
a full privacy audit of GA automatic URL/referrer collection. Query-based SPA
page breakdowns will no longer be available from these explicit parameters.

The hostname restriction is in code. No GA property filters, consent settings,
Enhanced Measurement settings or key-event definitions were changed. A later
approved release should verify actual collection and potential duplicate
history tracking before any GA settings change. The authenticated report found
Enhanced Measurement disabled on 3 October; that is not historical evidence.

After release, an owner can review collected `sign_up` events and separately
decide whether to mark them as a key event. Do not infer zero completed signups
from today's empty purchase-only key-event report. Observe ordinary production
usage; do not send synthetic signups or tests to production analytics.

Local Jest tests stub GA/Firebase/session calls; the production-looking jsdom
URLs exercise hostname checks without making network requests.

References: [Google recommended sign_up event](https://developers.google.com/analytics/devguides/collection/ga4/reference/events#sign_up),
[page-view measurement and duplicate history caveat](https://developers.google.com/analytics/devguides/collection/ga4/views),
[GA configuration reference](https://developers.google.com/analytics/devguides/collection/ga4/reference/config).
