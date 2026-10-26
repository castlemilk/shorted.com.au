#!/usr/bin/env python3
"""Read-only technical gate for a narrated web MP4. Not editorial or listening QA."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys


def number(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None


def assess(probe, levels, tolerance=0.25, min_lufs=-18, max_lufs=-12, max_peak=-1):
    errors = []
    streams = probe.get('streams', [])
    videos = [s for s in streams if s.get('codec_type') == 'video' and not s.get('disposition', {}).get('attached_pic')]
    audios = [s for s in streams if s.get('codec_type') == 'audio']
    if len(videos) != 1:
        errors.append('Expected exactly one video stream')
    if len(audios) != 1:
        errors.append('Expected exactly one final mixed audio stream')
    if videos:
        if videos[0].get('codec_name') != 'h264' or videos[0].get('pix_fmt') != 'yuv420p':
            errors.append('Expected H.264/yuv420p delivery video')
    if audios:
        a = audios[0]
        if a.get('codec_name') != 'aac' or a.get('profile') != 'LC':
            errors.append('Expected AAC-LC audio')
        if a.get('channels') != 2 or str(a.get('sample_rate')) not in ('44100', '48000'):
            errors.append('Expected stereo audio at 44.1 or 48 kHz')
        if a.get('disposition', {}).get('default') != 1:
            errors.append('Narration track is not marked default')
    if videos and audios:
        vd, ad = number(videos[0].get('duration')), number(audios[0].get('duration'))
        if vd is None or ad is None or min(vd, ad) <= 0:
            errors.append('Positive per-stream durations unavailable')
        elif abs(vd - ad) > tolerance:
            errors.append('Audio/video duration mismatch')
    loudness, peak = number(levels.get('input_i')), number(levels.get('input_tp'))
    if loudness is None or not min_lufs <= loudness <= max_lufs:
        errors.append('Integrated loudness unavailable, silent, or outside agreed range')
    if peak is None or peak > max_peak:
        errors.append('True peak unavailable or exceeds ceiling')
    return errors


def run(args, timeout):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr[-2000:]}')
    return result


def inspect(path, timeout):
    probe = json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)], timeout).stdout)
    # Decode both intended streams completely. Missing audio is reported by assess.
    run(['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-i', str(path), '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'], timeout)
    levels = {}
    if any(s.get('codec_type') == 'audio' for s in probe.get('streams', [])):
        result = run(['ffmpeg', '-nostdin', '-hide_banner', '-i', str(path), '-map', '0:a:0', '-vn', '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], timeout)
        matches = re.findall(r'\{[^{}]*"input_i"[^{}]*\}', result.stderr, re.S)
        if not matches:
            raise RuntimeError('FFmpeg did not return loudness measurement')
        levels = json.loads(matches[-1])
    return probe, levels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('--output', type=Path, help='Optional JSON report file')
    parser.add_argument('--timeout', type=float, default=900, help='Seconds per inspection command')
    parser.add_argument('--duration-tolerance', type=float, default=0.25)
    parser.add_argument('--min-lufs', type=float, default=-18)
    parser.add_argument('--max-lufs', type=float, default=-12)
    parser.add_argument('--max-true-peak', type=float, default=-1)
    args = parser.parse_args()
    values = [args.timeout, args.duration_tolerance, args.min_lufs, args.max_lufs, args.max_true_peak]
    if not all(math.isfinite(v) for v in values) or args.timeout <= 0 or args.duration_tolerance < 0 or args.min_lufs > args.max_lufs:
        parser.error('Invalid threshold or timeout')
    if args.output and args.output.resolve() == args.video.resolve():
        parser.error('Report must not overwrite input video')
    report = {'file': str(args.video), 'status': 'error', 'userPlayback': 'unconfirmed', 'editorialReview': 'not_performed', 'listeningReview': 'not_performed'}
    try:
        probe, levels = inspect(args.video, args.timeout)
        errors = assess(probe, levels, args.duration_tolerance, args.min_lufs, args.max_lufs, args.max_true_peak)
        with args.video.open('rb') as f:
            hasher = hashlib.sha256()
            for block in iter(lambda: f.read(1024 * 1024), b''):
                hasher.update(block)
            digest = hasher.hexdigest()
        report.update(status='failed' if errors else 'passed', sha256=digest, streams=probe.get('streams', []), measuredLevels=levels, fullDecode='passed', failures=errors)
        code = 1 if errors else 0
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        report['error'] = str(error)
        code = 2
    encoded = json.dumps(report, indent=2, allow_nan=False)
    if args.output:
        args.output.write_text(encoded + '\n')
    print(encoded)
    return code


if __name__ == '__main__':
    sys.exit(main())
