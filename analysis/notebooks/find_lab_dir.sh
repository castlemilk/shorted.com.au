#!/usr/bin/env bash
# Print a USABLE JupyterLab application directory, or nothing.
#
# WHY THIS EXISTS: `jupyter lab` records its application directory at install
# time. A Homebrew Python point-upgrade (3.11.11 -> 3.11.x) deletes the old
# Cellar tree, so the recorded path can vanish while JupyterLab itself still
# imports fine. The server then starts, serves /api happily, and returns a bare
# HTTP 500 the moment you open a notebook:
#
#     jinja2.exceptions.TemplateNotFound: 'index.html' not found in search paths
#
# Nothing in the UI says which path is missing. Setting JUPYTERLAB_DIR to a tree
# that actually has the assets fixes it without reinstalling anything.
#
# A directory is usable iff it contains static/index.html — that is the template
# whose absence produces the 500.
set -uo pipefail

usable() { [ -n "${1:-}" ] && [ -f "$1/static/index.html" ]; }

# 1. Whatever Jupyter currently believes, if it is real.
recorded=$(jupyter lab path 2>/dev/null | awk -F: '/Application directory/ {sub(/^[ \t]+/,"",$2); print $2}')
if usable "$recorded"; then echo "$recorded"; exit 0; fi

# 2. The share/ tree beside the jupyter executable (the usual Homebrew layout).
if command -v jupyter >/dev/null 2>&1; then
  prefix=$(cd "$(dirname "$(command -v jupyter)")/.." && pwd)
  usable "$prefix/share/jupyter/lab" && { echo "$prefix/share/jupyter/lab"; exit 0; }
fi

# 3. The jupyterlab package's own bundled assets.
pkg=$(python3 -c "import jupyterlab,pathlib;print(pathlib.Path(jupyterlab.__file__).parent)" 2>/dev/null)
usable "$pkg" && { echo "$pkg"; exit 0; }

# 4. Common install prefixes, last resort.
for d in /opt/homebrew/share/jupyter/lab /usr/local/share/jupyter/lab "$HOME/.local/share/jupyter/lab"; do
  usable "$d" && { echo "$d"; exit 0; }
done

exit 1
