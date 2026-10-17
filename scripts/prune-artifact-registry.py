#!/usr/bin/env python3
"""Prune old images from an Artifact Registry Docker repository.

Multi-arch builds push an image index whose manifests (one per platform, plus
buildx attestations) are listed as separate versions. Ranking every version
by age and deleting the oldest tried to delete children of indexes that were
still kept, and the registry refused every one ("manifest is referenced by
parent manifests"): nothing was pruned for weeks.

So the images are ranked at the top level only: versions no index refers to
(an index, or a single-platform image). The newest KEEP of those stay. Each
older one goes, and then its children, which nothing else refers to by then.
An image a live Cloud Run service or job uses, by digest or by tag, is never
deleted, and neither are its children.

Usage: prune-artifact-registry.py REGISTRY IN_USE_FILE
Env: KEEP_COUNT (default 20), DRY_RUN ("true" lists without deleting),
     MAX_CONSECUTIVE_FAILURES (default 5).
"""

import concurrent.futures
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
ACCEPT = ", ".join(
    sorted(INDEX_TYPES)
    + [
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)


def gcloud(*args):
    out = subprocess.run(["gcloud", *args], check=True, capture_output=True, text=True)
    return out.stdout


def manifest(pkg, digest, token):
    """The manifest's media type and, for an index, its children's digests."""
    host, path = pkg.split("/", 1)
    req = urllib.request.Request(
        f"https://{host}/v2/{path}/manifests/{digest}",
        headers={"Authorization": f"Bearer {token}", "Accept": ACCEPT},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.load(resp)
        media = body.get("mediaType") or resp.headers.get("Content-Type", "")
    children = [m["digest"] for m in body.get("manifests", [])] if media in INDEX_TYPES else []
    return media, children


def tags_of(v):
    tags = v.get("tags") or []
    if isinstance(tags, str):
        tags = [t for t in tags.split(",") if t]
    return [t.rsplit("/", 1)[-1] for t in tags]


class Pruner:
    def __init__(self, keep, dry_run, max_failures, in_use):
        self.keep, self.dry_run, self.max_failures = keep, dry_run, max_failures
        self.in_use = in_use
        self.deleted = self.failed = self.consecutive = 0

    def protected(self, pkg, digest, tags):
        return f"{pkg}@{digest}" in self.in_use or any(f"{pkg}:{t}" in self.in_use for t in tags)

    def delete(self, pkg, digest):
        if self.dry_run:
            print(f"  would delete {digest}")
            return True
        try:
            gcloud("artifacts", "docker", "images", "delete", f"{pkg}@{digest}", "--quiet", "--delete-tags")
        except subprocess.CalledProcessError as e:
            self.failed += 1
            self.consecutive += 1
            last = (e.stderr or "").strip().splitlines()[-1:] or ["(no output)"]
            print(f"  Failed to delete {digest}: {last[0]}")
            if self.consecutive >= self.max_failures:
                print(f"::error::{self.consecutive} deletes in a row failed; stopping. Last error: {last[0]}")
                sys.exit(1)
            return False
        self.deleted += 1
        self.consecutive = 0
        return True

    def prune(self, pkg, token):
        name = pkg.rsplit("/", 1)[-1]
        print(f"\n--- {name} ---")
        versions = json.loads(gcloud("artifacts", "docker", "images", "list", pkg, "--include-tags", "--format=json"))
        by_digest = {v["version"]: v for v in versions}
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            facts = dict(zip(by_digest, pool.map(lambda d: manifest(pkg, d, token), by_digest)))
        children = {c for _, kids in facts.values() for c in kids}
        top = sorted(
            (v for d, v in by_digest.items() if d not in children),
            key=lambda v: v.get("updateTime") or v.get("createTime") or "",
            reverse=True,
        )
        old = top[self.keep :]
        print(f"  {len(by_digest)} manifests, {len(top)} images; {len(old)} older than the newest {self.keep}")
        for v in old:
            digest, tags = v["version"], tags_of(v)
            kids = facts[digest][1]
            if self.protected(pkg, digest, tags) or any(self.protected(pkg, k, []) for k in kids):
                print(f"  PROTECTED {digest} — referenced by a live Cloud Run resource")
                continue
            if not self.delete(pkg, digest):
                continue
            # The index is gone; its children are referenced by nothing kept
            # unless another index shares them (rebuilds of the same layers).
            still = {c for d, (_, ks) in facts.items() if d != digest and d in by_digest for c in ks}
            for kid in kids:
                if kid in by_digest and kid not in still:
                    self.delete(pkg, kid)
            by_digest.pop(digest, None)


def main():
    registry, in_use_file = sys.argv[1], sys.argv[2]
    keep = int(os.environ.get("KEEP_COUNT", "20"))
    dry_run = os.environ.get("DRY_RUN", "false") == "true"
    max_failures = int(os.environ.get("MAX_CONSECUTIVE_FAILURES", "5"))
    with open(in_use_file) as f:
        in_use = {line.strip() for line in f if line.strip()}
    token = gcloud("auth", "print-access-token").strip()
    pruner = Pruner(keep, dry_run, max_failures, in_use)
    packages = sorted({p["package"] for p in json.loads(gcloud("artifacts", "docker", "images", "list", registry, "--format=json"))})
    for pkg in packages:
        try:
            pruner.prune(pkg, token)
        except (subprocess.CalledProcessError, urllib.error.URLError) as e:
            pruner.failed += 1
            print(f"::warning::could not prune {pkg}: {e}")
    print(f"\n=== Cleanup complete: deleted {pruner.deleted} manifests, {pruner.failed} failed ===")
    if pruner.failed:
        print(f"::warning::{pruner.failed} deletes or listings failed")


if __name__ == "__main__":
    main()
