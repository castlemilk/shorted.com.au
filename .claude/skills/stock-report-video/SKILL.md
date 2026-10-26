---
name: stock-report-video
description: Plan, research, art-direct, narrate and validate Shorted stock videos, results walkthroughs, market explainers and short-interest clips. Use for stock-report-video requests, Kinetograph productions and revisions to video quality or audio. For written reports use financial-report-analysis; creating a video does not publish it.
---

# Shorted stock video production

Make an evidence-led film, not a narrated slide deck. Use Shorted data for positioning and primary issuer/exchange documents for company disclosures. Exact figures belong in deterministic graphics and a cited claim ledger, not image-generated charts. Each production has a reproducible plan, asset provenance, timed narration, render and delivery checks.

## Start with the requested outcome

Inspect the existing project, repository guidance and relevant skills before changing a pipeline. Preserve the requested renderer and cut. Do not force every brief into two videos, a fixed duration, a particular computer, paid TTS or one visual treatment. If unspecified, propose a format appropriate to the story, then document it. Honour instructions not to spawn tasks or jobs.

For this workflow read:
- [Planning and evidence](references/planning-evidence.md) before scripting.
- [Art and motion direction](references/art-motion.md) before storyboarding and asset generation. Use the repository's `shorted-editorial-art` skill for the established brand language; inspect current assets rather than inventing a new logo.
- [Voice and delivery](references/voice-delivery.md) before narration, exports or diagnosing silent playback. Includes the optional owner-authorized voice-clone workflow.
- [Renderer adapters](references/renderers.md) for Kinetograph or the existing studio. Load only the selected adapter's details.
- [Production template](references/production-template.json) as a starting artifact, not as a mandate to fill unknown facts.

## Production gates

1. **Brief and research.** Define audience, one central question, target cut(s), research cutoff with timezone and desired takeaway. Collect a claim ledger and note gaps. Distinguish fact, forecast, interpretation and illustration. Reconcile materially inconsistent sources before using a claim.
2. **Plan before expensive production.** Write the complete narration and a scene-by-scene storyboard: claim IDs, purpose, spoken words, visual evidence, asset brief, animation, transition, source/date treatment and estimated duration. Show the plan before the final render. Obtain approval if requested or required by the selected studio; existing approval can cover implementation without repeatedly asking. Changed thesis or new consequential claims need renewed review.
3. **Art-direct and proof.** Select a coherent treatment and create a contact sheet. Use imagegen for scene artwork and meaningful variants at each major story stage, not a compulsory new image for every sentence. Inspect actual pixels and crops before integration. Keep figures, logos, captions and source text native to the renderer.
4. **Voice-led timing.** Produce a short voice proof containing ticker, names, percentages and currency before full narration. Measure actual takes, then build the timeline and captions around speech. A script alone is not audio. Use stable audio identities and explicit track mapping.
5. **Motion proof.** Render a representative opening, a data-heavy scene and a transition with sound before the full film. Judge hierarchy, pacing, legibility, numerical accuracy and whether motion explains the story. Fix these before scaling up.
6. **Render and inspect.** Run renderer checks and inspect key frames, transition boundaries and the encoded video. Listen where audio playback is available. Run `python3 scripts/validate_video.py <export.mp4>` from this skill folder for a narrated H.264/AAC delivery. See its `--help` for agreed format overrides. Passing technical checks does not establish editorial quality, speech correctness or successful device playback.
7. **Deliver the exact checked artifact.** Save the script, claim ledger, source snapshots, prompts, asset manifest, timeline, captions, renderer version and QA report. Hash the final file. Deliver one video with embedded narration by default; a separate MP3 is optional, not a replacement. Verify uploaded bytes through supported download/materialization when possible. Do not publish to social platforms, production news or advertising channels without authorization.

## Non-negotiable distinctions

- ASIC position date, publication date, retrieved-at time and the film's editorial cutoff are different. Show the position date whenever short data is material. Positions do not reveal holders, motives or whether a particular short is still open.
- A price decline following news is not evidence of motive or causation. Attribute documented explanations and keep analysis explicitly conditional. Do not invent quotes, market reactions or wrongdoing to create drama.
- Separate total/net revenue, statutory/underlying profit, EBITDA/operating cash flow, cash/undrawn facilities and actuals/guidance. Explain changed measurement bases before comparing.
- Do not hard-code current subscription pricing, stock prices or historical NEXTDC figures into future productions. Refresh evidence and recompute derived values.
- Generated imagery is illustrative, not a photograph of a real event or evidence of a specific facility. Record that status and preserve the claim's uncertainty.
- Use existing authorized voices or an explicitly authorized clone of the owner. Never treat an attached voice sample as permission to impersonate someone else or upload it to an arbitrary service.
- Report checks as passed, failed or not performed. A successful render, audio stream or ASR transcript does not prove the user heard the audio.

## Invocation

“Use $stock-report-video to produce a Shorted deep dive on <ticker/topic> using <renderer>. First prepare the research ledger, full narration and scene plan. Develop coherent imagegen artwork and explanatory motion, then validate the encoded video and embedded audio. Use <approved voice or stock voice>. Keep it private until I approve publishing.”
