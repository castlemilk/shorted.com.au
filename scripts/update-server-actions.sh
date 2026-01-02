#!/bin/bash

# Update all server actions to use centralized config

cd /Users/benebsworth/projects/shorted/web/src/app/actions

# Files to update
FILES=(
  "getStockData.ts"
  "getIndustryTreeMap.ts"
  "getTopShorts.ts"
  "getStockDetails.ts"
  "register.ts"
)

for file in "${FILES[@]}"; do
  echo "Updating $file..."
  
  # Add import for config if not already present
  if ! grep -q "import { SHORTS_API_URL } from" "$file"; then
    # Add import after other imports
    sed -i '' '6a\
import { SHORTS_API_URL } from "./config";
' "$file"
  fi
  
  # Replace hardcoded URL with SHORTS_API_URL
  sed -i '' 's|process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??[[:space:]]*"http://localhost:9091"|SHORTS_API_URL|g' "$file"
  sed -i '' 's|"http://localhost:9091"|SHORTS_API_URL|g' "$file"
  
  echo "✓ Updated $file"
done

echo "Done!"