#!/bin/bash

# Vercel build script that handles both scenarios:
# 1. When Vercel tries to generate protos (from dashboard settings)
# 2. When it just runs npm build (from vercel.json)

echo "Starting Vercel build process..."

# Check if we're in the web directory
if [ -d "web" ]; then
  echo "In root directory, moving to web..."
  cd web
fi

# Check if proto generation was attempted and failed
# This handles the case where Vercel's dashboard setting tries to generate protos
if [ -d "../proto" ]; then
  echo "Proto directory found, attempting generation..."
  npm install -g @bufbuild/buf
  cd ../proto && buf generate && cd ../web
else
  echo "Proto directory not found, skipping generation (using committed files)..."
fi

# Run the actual build
echo "Running Next.js build..."
npm run build