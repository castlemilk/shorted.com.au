# Voice, sound and delivery

## Voice proof before full synthesis

Use an already-authorized voice provider or permitted local stock voice. Verify current provider setup, costs and terms instead of assuming a key or account exists. Never print credentials. Read acronyms, tickers, dates, currencies and percentages in a short proof; inspect and listen before generating all takes. Maintain pronunciation notes separately from displayed text. Rephrase difficult numbers without changing meaning. Do not infer correct speech from text alone.

Measure take durations. Build a scene timeline and captions from actual takes, with breathing room and readable chart holds. Forced alignment is preferred when available; sentence timing or word-count interpolation must be labelled approximate. ASR helps detect missing phrases and numerical errors but is not a substitute for listening; manually reconcile proper nouns and critical figures. Do not force a slow voice to fit by excessive speed-up.

## Optional: the owner's own voice

When the owner explicitly asks for their own voice, offer a clone workflow, not a claim that it already exists. Ask for a clean sample recorded in a quiet room with no music or other speakers; 2–5 minutes of varied natural narration is a useful initial sample, but check the chosen provider's current requirements. Include names, numbers and sentences similar to the intended programme. Recording/uploading a sample is separate from authorization to enrol it with a provider or use it in public releases.

Before transmitting a recording, explain the exact provider, purpose, storage/retention and deletion controls, any training use, price and permissions. Obtain required consent and provider verification; never evade voice-ownership verification. Prefer a local option when it meets quality needs and the owner prefers privacy. Do not promise that a cloud tool can record the microphone. Use supported upload/recording flows. Never ask for API keys in chat.

Make a brief audition first and ask the owner whether it sounds like them and has the intended delivery. Label synthetic narration appropriately for the destination; do not portray generated words as an authentic live recording. Keep the voice ID/private samples out of public repositories. Store only non-secret provenance and the approved scope. A request for one Shorted video does not authorize other identities, advertising or unrelated uses. Do not run this flow for another person's voice without appropriate authorization.

## Mix and export

Keep narration intelligible; music is optional and should duck below speech. Use licensed/owned audio and record its provenance. A practical narration-first web mix target is around -16 LUFS integrated (acceptance range -18 to -12 by default) with final true peak at or below -1 dBTP. These are configurable production targets, not universal platform requirements. Measure the final encode, not only the source WAV.

Default compatibility export: MP4 with H.264, yuv420p, AAC-LC stereo at 44.1 or 48 kHz, faststart, and the intended narration track marked default. Explicitly map video and the final mix; avoid accidental duplicate audio tracks. Preserve a high-quality master separately. For a mono voice, duplicate it to L/R explicitly rather than relying on ambiguous channel remapping. Avoid downmix gain surprises and remeasure after mux/transcode.

Use `scripts/validate_video.py` on the final delivery file. It checks codec/pixel format/default stereo audio, duration alignment, full decode and measured loudness/peak. It fails closed on unavailable evidence. It cannot establish pronunciation, acceptable artwork, correct claims or audible playback in a user's app.

## Silent-playback troubleshooting

1. Inspect the exact delivered/downloaded bytes through a supported file route. Compare hashes with the validated local file.
2. Inspect audio codec, channels, default disposition, actual duration and measured signal. An audio stream alone can be silent.
3. Full-decode the delivered file and extract a short diagnostic audio sample if useful. Ask whether that sample is audible; do not assert a device/app bug just because FFmpeg succeeds.
4. If requested, explicitly remux/re-encode one supported default stereo track, recheck loudness and duration, and replace the existing deliverable version. Deliver the combined MP4, not two files that require manual syncing.
5. Distinguish “technical checks passed” from “playback confirmed by user.” Repeatedly generating files is not evidence of a fix.

## Delivery receipt

Record the exact filename, SHA-256, dimensions, frame rate, video/audio durations, codec/channel data, LUFS/true peak, renderer version and check outcomes. Retain captions, sources and prompt provenance. Upload through the destination's supported path; keep file identity/version when revising. Attach the checked final file natively where supported. Do not claim an upload or a successful send proves playback. Do not publish externally without the user's authorization.

## Test the gate

Requires Python 3 and installed FFmpeg/ffprobe. Run `python3 -m unittest discover -s scripts -p 'test_*.py' -v` from the skill folder. The tests include generated local media; missing FFmpeg skips integration tests explicitly rather than claiming media validation. Threshold overrides should reflect the agreed destination, not be loosened to conceal a bad mix.
