#!/bin/bash

# Get the current version from git
VERSION=$(git describe --tags --always --dirty)

# Update package.json
jq --arg version "$VERSION" '.version = $version' package.json > package.json.tmp && mv package.json.tmp package.json

echo "Version bumped to $VERSION"