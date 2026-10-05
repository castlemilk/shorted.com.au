#!/usr/bin/env bash
# Point every image in deploy/kubernetes/jobs/chart/values.yaml at one tag.
#
#   deploy/kubernetes/jobs/scripts/bump-image-tag.sh main-3349f251
#
# Called by terraform-deploy.yml (`bump-vke-jobs-image`) after a main deploy
# applies, so the CronJobs pick up the images that deploy built — the same tag
# the Cloud Run jobs just moved to. Paprika polls main and rolls the chart.
#
# POSIX sed/grep only: the self-hosted runners are not guaranteed Python, yq or
# helm (scripts/tests/self-hosted-toolchain.test.mjs). The chart's own render
# contract (chart/tests/render.sh) runs in repo-hygiene on every PR.
set -euo pipefail

tag="${1:-}"
if [[ ! "${tag}" =~ ^main-[0-9a-f]{8}$ ]]; then
  echo "usage: $0 main-<8 hex>   (got '${tag}'; only immutable main-<sha> tags are deployable)" >&2
  exit 2
fi

values="$(cd "$(dirname "${BASH_SOURCE[0]}")/../chart" && pwd)/values.yaml"

# Every image lives under top-level `images:` as `    tag: <x>`, and nothing
# else in the file is indented that way under that block. Rewrite only the tag
# lines between `images:` and the next top-level key.
tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
awk -v tag="${tag}" '
  /^[^ #]/ { in_images = ($0 ~ /^images:[[:space:]]*$/) }
  in_images && /^    tag:[[:space:]]/ { print "    tag: " tag; n++; next }
  { print }
  END { if (n != 4) { printf("expected 4 image tags under images:, rewrote %d\n", n) > "/dev/stderr"; exit 1 } }
' "${values}" >"${tmp}"
cat "${tmp}" >"${values}"

grep -c "^    tag: ${tag}$" "${values}" | grep -qx 4
echo "values.yaml images -> ${tag}"
