# Versioning Quick Start Guide

## ✅ What Was Implemented

Your deployed app now automatically shows version information in the footer of every page!

### Features

1. **Automatic Version Updates** 🔄
   - Version is automatically generated from git commits
   - Updates on every build
   - No manual version bumps needed

2. **Footer Display** 👀
   - Version badge in site footer (every page)
   - Hover for detailed build info:
     - Build date/time
     - Git commit hash
     - Git branch
     - Environment (production/preview/development)

3. **API Endpoint** 🔌
   - `/api/version` provides JSON version info
   - Use for monitoring and debugging

4. **Vercel Integration** ☁️
   - Automatically detects Vercel deployments
   - Shows commit SHA, branch, and environment

## 🚀 Quick Test

### View Version Locally

```bash
cd web
npm run dev
# Visit http://localhost:3020
# Check the footer - you'll see version badge with git commit icon
```

### View Version in Production

1. Deploy to Vercel
2. Visit your site
3. Scroll to footer
4. Hover over the version badge for details

### API Check

```bash
# Local
curl http://localhost:3020/api/version | jq

# Production
curl https://shorted.com.au/api/version | jq
```

Example output:
```json
{
  "version": "v0.2.2-494-g29336010",
  "buildDate": "2025-11-08T10:52:40.123Z",
  "gitCommit": "2933601",
  "gitBranch": "main",
  "environment": "production",
  "uptime": 3600.5,
  "nodeVersion": "v20.11.0"
}
```

## 📝 How to Create New Releases

```bash
# Tag a new release
git tag v0.3.0
git push origin v0.3.0

# Next build will show:
# - v0.3.0 (on the tagged commit)
# - v0.3.0-1-gHASH (1 commit after tag)
# - v0.3.0-2-gHASH (2 commits after tag)
# etc.
```

## 🔧 Configuration Files Changed

- ✅ `web/next.config.mjs` - Injects version at build time
- ✅ `web/package.json` - Added prebuild script
- ✅ `web/src/@/components/ui/site-footer.tsx` - Displays version
- ✅ `web/src/app/api/version/route.ts` - Version API endpoint (NEW)
- ✅ `web/scripts/bump-version.sh` - Version update script (already existed)

## 🎯 What Happens on Each Deploy

1. **Prebuild Phase**
   ```
   npm run prebuild
   └── npm run bump-version
       └── git describe --tags --always --dirty
           └── Updates package.json
   ```

2. **Build Phase**
   ```
   next build
   ├── Reads version from package.json
   ├── Gets Vercel environment variables
   └── Injects into publicRuntimeConfig
   ```

3. **Runtime**
   ```
   Footer displays version
   API returns version info
   ```

## 🐛 Troubleshooting

### Version shows "dev"
- Git not available during build
- Run locally: `npm run bump-version`

### Version doesn't update
- Make sure you committed your changes
- Run: `git describe --tags --always --dirty`

### Want to see current version?
```bash
cd web
cat package.json | grep version
```

## 🎨 Customization

### Change Version Display

Edit `web/src/@/components/ui/site-footer.tsx`:

```tsx
// Current: Shows version with commit icon
<GitCommit className="w-3 h-3 mr-1" />
{publicRuntimeConfig?.version ?? 'dev'}

// Change icon or format as needed
```

### Add Version to About Page

```tsx
import getConfig from "next/config";

const { publicRuntimeConfig } = getConfig();

<p>Version: {publicRuntimeConfig?.version}</p>
<p>Build Date: {publicRuntimeConfig?.buildDate}</p>
```

## 📊 Monitoring Example

Create a monitoring script:

```bash
#!/bin/bash
# check-version.sh

PROD=$(curl -s https://shorted.com.au/api/version | jq -r .version)
PREVIEW=$(curl -s https://preview.shorted.com.au/api/version | jq -r .version)

echo "🌍 Production: $PROD"
echo "👁️  Preview: $PREVIEW"

if [ "$PROD" != "$PREVIEW" ]; then
  echo "⚠️  Versions differ!"
fi
```

## ✨ Next Steps

1. **Commit and Push**
   ```bash
   git add .
   git commit -m "feat: add automatic version tracking and display"
   git push
   ```

2. **Deploy to Vercel**
   - Automatic on git push
   - Or manually trigger in Vercel dashboard

3. **Verify**
   - Check footer on deployed site
   - Test `/api/version` endpoint
   - Hover over version badge

4. **Optional: Create Release Tag**
   ```bash
   git tag v0.3.0 -m "Release version 0.3.0"
   git push origin v0.3.0
   ```

## 📚 Full Documentation

See `VERSIONING.md` for complete details and advanced usage.

