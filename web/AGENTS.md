# Reviewing Shorted UI changes

Every UI change ships with final screenshots of the running interface using real, dated data. Read the project design system in [DESIGN.md](../DESIGN.md). Review the original desktop and phone screens, use the affected workflow, and identify the concrete visual issues. After editing, render and inspect both sizes again. Fix any issues visible in those captures. Include the final images in the review, the source date where relevant, and a short account of what the screenshots changed. Use a clean browser with public market data or approved review data. If real records are unavailable, capture the actual empty or error state and identify the missing source in the handoff.

Use Ben’s `design-taste-frontend` when available, with Unslop and Hallmark’s guidance for existing product screens. Preserve Shorted’s typography, colour tokens, financial units, source links and data coverage. Keep controls reachable and tables legible on a phone. The pinned design references are [Design Taste](https://github.com/Leonxlnx/taste-skill/tree/f6b76575f949707b4e3c37cd86cb44b0b98643e8/skills/taste-skill), [Unslop](https://github.com/heydamir/unslop/tree/620163eedb3529d9cd23a3994ed8d287d06f760d/skills/unslop) and [Hallmark’s redesign guide](https://github.com/Nutlope/hallmark/blob/04977e15f3dfd6ee4b74c887dac3eb52665d6c92/skills/hallmark/references/redesign.md).

For profile reviews, also use [Impeccable](https://github.com/pbakaus/impeccable/tree/b49177d32788f2dc585c42831d845dacf1ebed2c/plugin/skills/impeccable). Check that a reader can identify the person, the reporting entity and the first filing on a phone.

For the Australian investor tracker, run the following from `web/` against an up-to-date review build connected to the market service. The capture opens the public directory, follows filers through the UI, and checks source links before saving the images.

```sh
node scripts/capture-investor-tracker.mjs http://localhost:3000 /path/to/review-screenshots
```

Run `npm run traders:crawl -- --discover` from `web/` to review public account and portrait candidates. After checking which person, firm or show owns a link, update its editorial source and run `npm run traders:crawl -- --write` to refresh the dated access results. Only publish a local photograph when the subject, credit and reuse terms are documented. A named portrait can also link to its publisher.
