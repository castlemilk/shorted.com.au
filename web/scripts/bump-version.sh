#!/bin/sh

if [ "${SKIP_VERSION_BUMP:-}" = "1" ]; then
  echo "Skipping version bump"
  exit 0
fi

# Get the current version from git when available. CLI deploy staging
# directories may not include .git, so keep the existing package version there.
VERSION=$(git describe --tags --always --dirty 2>/dev/null)
if [ -z "$VERSION" ]; then
  VERSION=$(node -e "const p = require('./package.json'); process.stdout.write(p.version || '0.0.0')")
fi

# Update package.json
node -e "const fs = require('fs'); const p = require('./package.json'); p.version = process.argv[1]; fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')" "$VERSION"

echo "Version bumped to $VERSION"
