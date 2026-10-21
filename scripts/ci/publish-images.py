#!/usr/bin/env python3
"""Publish the existing bake graph with bounded, evidence-gated recovery.

No credential changes, cache pruning, image deletion or Terraform execution.
A failed push can leave valid remote manifests. Inspect every immutable tag
before a single retry; unknown registry state must remain a failure.
"""
from __future__ import annotations
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BUILDER = 'shorted-builder'
BAKE_FILE = 'docker-bake.hcl'
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')
# Only the observed registry transport class, never arbitrary build failures.
PUSH_TRANSIENT = re.compile(r'^#\d+ ERROR: failed to push .+: .*?(?:DeadlineExceeded|context deadline exceeded|TLS handshake timeout|i/o timeout|connection reset by peer)', re.M)
PERMANENT = re.compile(r'(?i)permission.?denied|access.?denied|\bdenied\b|unauthorized|unauthenticated|invalid_grant|invalid credential|\bforbidden\b|no space left on device')
MISSING = re.compile(r'(?i)manifest unknown|manifest_unknown|no such manifest|name unknown')
TRANSPORT = re.compile(r'(?i)DeadlineExceeded|context deadline exceeded|TLS handshake timeout|i/o timeout|connection reset by peer|no route to host|connection refused')
TRUNCATED = '[publication output truncated; retry classification unavailable]'

class PublishError(RuntimeError):
    pass

def retryable(log: str) -> bool:
    if TRUNCATED in log or PERMANENT.search(log) or not PUSH_TRANSIENT.search(log):
        return False
    errors = [line for line in log.splitlines() if re.match(r'^#\d+ ERROR:|^ERROR:', line)]
    # One known transient push must not conceal another target's unknown error.
    def known_error(line: str) -> bool:
        if PUSH_TRANSIENT.match(line):
            return True
        if re.fullmatch(r'#\d+ ERROR: context cancel(?:ed|led)', line):
            return True
        return bool(re.match(r'^ERROR: (?:target [^:]+: )?failed to solve:', line)
                    and TRANSPORT.search(line))
    return bool(errors) and all(known_error(line) for line in errors)

def command(args: list[str], timeout: int, stream: bool = False) -> tuple[int, str]:
    # File-backed output bounds memory even for a very verbose build. The
    # diagnostic tail is deliberately bounded; CI no longer dumps whole builds.
    with tempfile.TemporaryFile(mode='w+b') as output:
        started = time.monotonic()
        process = subprocess.Popen(args, stdout=output, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            while True:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(args, timeout)
                try:
                    code = process.wait(timeout=min(30, remaining))
                    break
                except subprocess.TimeoutExpired:
                    if stream:
                        print(f'publication command still running elapsed={int(time.monotonic()-started)}s', flush=True)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
            # Terminate only this command's process group, including the
            # Buildx CLI child. Never leave a retry racing an orphaned client.
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise PublishError('Command interrupted or timed out; outcome is unknown. Reconcile before retrying.') from exc
        size = output.tell()
        output.seek(max(0, size - 65536))
        tail = output.read().decode('utf-8', errors='replace')
        if size > 65536:
            # Missing earlier output is unknown evidence, not permission to
            # retry. Successful builds still verify their output metadata.
            tail = TRUNCATED + '\n' + tail
    if stream:
        print('\n'.join(tail.splitlines()[-100:]), flush=True)
    return code, tail

def targets_from_plan(plan: dict, registry: str, image_tag: str) -> dict[str, str]:
    targets = plan.get('target')
    if not isinstance(targets, dict) or not targets:
        raise PublishError('Bake did not return a nonempty target map.')
    result = {}
    for name, target in targets.items():
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name):
            raise PublishError('Unexpected bake target name.')
        expected = f'{registry}/{name}:{image_tag}'
        if expected not in target.get('tags', []):
            raise PublishError(f'{name}: exact release tag is absent from bake configuration.')
        result[name] = expected
    return result

def inspect_tag(ref: str, run=command) -> str | None:
    code, output = run(['docker', 'buildx', 'imagetools', 'inspect', ref,
                        '--format', '{{json .Manifest}}'], timeout=45)
    if code:
        if MISSING.search(output) and not PERMANENT.search(output) and not TRANSPORT.search(output) and TRUNCATED not in output:
            return None
        # Do not turn an auth failure/network timeout into a missing image.
        raise PublishError('Registry inspection is inconclusive; automatic retry is stopped.')
    try:
        digest = json.loads(output)['digest']
    except (ValueError, KeyError, TypeError) as exc:
        raise PublishError('Registry returned no verifiable manifest digest.') from exc
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise PublishError('Registry returned an invalid manifest digest.')
    return digest

def reconcile(targets: dict[str, str], run=command) -> dict[str, str | None]:
    found = {}
    for name, ref in targets.items():
        found[name] = inspect_tag(ref, run)
        # No hostname, account identifiers, tokens or runtime inventory printed.
        print(f'publication target={name} state={"present" if found[name] else "missing"}', flush=True)
    return found

def verify(targets: dict[str, str], metadata: dict, run=command) -> None:
    for name, ref in targets.items():
        expected = metadata.get(name, {}).get('containerimage.digest')
        if not isinstance(expected, str) or not DIGEST.fullmatch(expected):
            raise PublishError(f'{name}: successful bake lacks a verified output digest.')
        actual = inspect_tag(ref, run)
        if actual != expected:
            raise PublishError(f'{name}: remote tag does not match this bake output.')
        print(f'publication target={name} verified=true', flush=True)

def publish(registry: str, image_tag: str, run=command, sleep=time.sleep) -> None:
    if not registry or not image_tag or image_tag == 'latest' or any(c.isspace() for c in registry + image_tag):
        raise PublishError('REGISTRY and an exact non-latest IMAGE_TAG are required.')
    code, raw = run(['docker', 'buildx', 'bake', '--file', BAKE_FILE, '--print'], timeout=60)
    if code:
        raise PublishError('Unable to inspect the bake graph.')
    try:
        targets = targets_from_plan(json.loads(raw), registry, image_tag)
    except ValueError as exc:
        raise PublishError('Bake configuration was not valid JSON.') from exc
    with tempfile.TemporaryDirectory(prefix='shorted-publish-') as directory:
        for attempt in (1, 2):
            metadata_path = Path(directory) / f'metadata-{attempt}.json'
            print(f'publication attempt={attempt}/2 targets={len(targets)} builder={BUILDER}', flush=True)
            code, log = run(['docker', 'buildx', 'bake', '--file', BAKE_FILE,
                             '--builder', BUILDER, '--push', '--progress', 'plain',
                             '--metadata-file', str(metadata_path)], timeout=3600, stream=True)
            if code == 0:
                try:
                    metadata = json.loads(metadata_path.read_text())
                except (OSError, ValueError) as exc:
                    raise PublishError('Bake succeeded without readable publication metadata.') from exc
                verify(targets, metadata, run)
                return
            if attempt == 2 or not retryable(log):
                raise PublishError('Image publication failed; no further automatic attempt is allowed.')
            reconcile(targets, run)
            print('Transient registry push failure; one retry with the same builder/cache and inputs in 10s.', flush=True)
            sleep(10)
    raise PublishError('Image publication did not complete.')

if __name__ == '__main__':
    try:
        publish(os.environ.get('REGISTRY', ''), os.environ.get('IMAGE_TAG', ''))
    except PublishError as exc:
        print(f'::error::{exc}', file=sys.stderr)
        sys.exit(1)
