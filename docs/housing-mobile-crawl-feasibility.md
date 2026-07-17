# Mobile crawl feasibility test (item 4 make-or-break)

**Question:** can a phone run the automated REA crawl — i.e. does mobile
Safari/WebKit (the same engine a React-Native `WebView` / `WKWebView` uses) clear
REA's Kasada challenge on native navigation **and** expose the
`window.ArgonautExchange` listing blob the crawler reads? If yes, the distributed
iOS/Android app is worth building (and it makes the hidden-price detail-fetch
low-risk, since the block is device/session-fingerprint-scoped — your phone
wasn't blocked while the Mac was).

## The 30-second test (on your phone)

1. **Open Safari** on the iPhone and go to a REA search page (any suburb):
   `https://www.realestate.com.au/buy/in-paddington,+qld+4064/list-1`
   Let it load fully (this native navigation is what clears Kasada).
2. **Run the probe** in that loaded page. Two ways:
   - **Easiest:** long-press the URL bar → *Paste and Go* the `javascript:` line
     below is blocked by Safari in the bar, so use the bookmarklet method:
   - **Bookmarklet:** bookmark this page (Share → Add Bookmark). Then edit that
     bookmark (Bookmarks → Edit) and replace its **URL** with the one-liner in
     `probe.js` below (starts with `javascript:`). Save. Then, back on the loaded
     REA page, tap that bookmark. An alert pops with the verdict.
3. **Read the verdict** in the alert:
   - `✅ mobile can crawl` → blob present + listing ids found → **build the app**.
   - `❌ blocked/empty` (or a tiny page / KPSDK stub) → WebView is blocked → the
     app would need a different approach (native fetch, cellular, etc.).

## probe.js (paste as the bookmarklet URL — one line)

```
javascript:(function(){var w=(typeof window.ArgonautExchange!=='undefined');var h=document.documentElement.outerHTML;var b=h.indexOf('ArgonautExchange')>-1;var ids=(h.match(/\"listingId\"|\"listing_id\"/g)||[]).length;var kp=h.indexOf('KPSDK')>-1&&h.length<20000;var ok=(b&&ids>0);alert('window.ArgonautExchange: '+w+'\nblob in page: '+b+'\nlisting ids: '+ids+'\npage bytes: '+h.length+'\nKasada stub: '+kp+'\n\nVERDICT: '+(ok?'✅ mobile CAN crawl':'❌ blocked/empty'));})();
```

## Why this is a valid proxy

A React-Native `WebView` (iOS) is `WKWebView` — the same WebKit engine as mobile
Safari. If Safari's *page context* has `ArgonautExchange` + listing ids after a
native nav, a `WKWebView` loading the same URL will too, and the RN app reads the
blob by injecting the exact JS above via `injectedJavaScript` /
`webview.evaluateJavaScript`. So a green verdict here means the whole distributed
crawl is feasible: the app native-navigates a `WebView` to each search URL, reads
the blob, and submits the same counts-only summary to the brandbrain queue that
the Mac collector does — while the crawl workload fans across every enrolled
device (Mac + phones), each with its own fingerprint, so a block on one doesn't
stop the others.
```
```
