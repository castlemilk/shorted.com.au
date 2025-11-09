# Versioning System

This document describes the automated versioning system for the Shorted application.

## Overview

The application uses Git-based semantic versioning that automatically updates with each build. The version information is displayed in the footer of every page and is available via API.

## Version Format

Version format: `vMAJOR.MINOR.PATCH-COMMITS-gCOMMIT_HASH[-dirty]`

Example: `v0.2.2-494-g29336010-dirty`

- `v0.2.2`: Latest git tag
- `494`: Number of commits since the tag
- `g29336010`: Short git commit hash (7 characters)
- `dirty`: Indicates uncommitted changes (only in development)

## How It Works

### Build-Time Version Generation

1. **Local Development**
   - Version is generated from `git describe --tags --always --dirty`
   - Displayed in footer with full build information on hover

2. **Production Builds**
   - `prebuild` script automatically runs `bump-version.sh`
   - Git version is injected into `package.json`
   - Next.js config reads version and makes it available at runtime

3. **Vercel Deployments**
   - Additional metadata is automatically included:
     - `VERCEL_GIT_COMMIT_SHA`: Full commit hash
     - `VERCEL_GIT_COMMIT_REF`: Branch name
     - `VERCEL_ENV`: Environment (production/preview/development)

### Version Information Display

#### Footer Badge
- Visible on every page in the site footer
- Shows current version with git commit icon
- Hover tooltip displays:
  - Build date and time
  - Git commit hash
  - Git branch
  - Environment (production/preview/development)

#### API Endpoint
Access version information programmatically:

```bash
curl https://shorted.com.au/api/version
```

Response:
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

## Manual Version Bumping

To manually update the version in `package.json`:

```bash
cd web
npm run bump-version
```

This will:
1. Get the latest git version using `git describe`
2. Update `package.json` with the new version
3. Display the updated version

## Creating New Releases

To create a new version tag:

```bash
# Create a new tag (semantic versioning)
git tag v0.3.0

# Push the tag to remote
git push origin v0.3.0
```

After creating a tag:
- All subsequent builds will use this as the base version
- The commit count will start from 0
- Version will appear as `v0.3.0` (for the tagged commit)
- Or `v0.3.0-N-gHASH` (for N commits after the tag)

## Scripts

### package.json Scripts

```json
{
  "scripts": {
    "prebuild": "npm run bump-version",  // Auto-run before build
    "bump-version": "bash ./scripts/bump-version.sh"
  }
}
```

### bump-version.sh

Located at `web/scripts/bump-version.sh`:

```bash
#!/bin/bash
VERSION=$(git describe --tags --always --dirty)
jq --arg version "$VERSION" '.version = $version' package.json > package.json.tmp && mv package.json.tmp package.json
echo "Version bumped to $VERSION"
```

## Configuration

### next.config.mjs

The version information is injected into the Next.js runtime config:

```javascript
publicRuntimeConfig: {
  version,                    // Git-based version
  buildDate: new Date().toISOString(),
  gitCommit: process.env.VERCEL_GIT_COMMIT_SHA?.substring(0, 7) ?? "local",
  gitBranch: process.env.VERCEL_GIT_COMMIT_REF ?? "local",
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  shortsUrl: process.env.SHORTS_SERVICE_ENDPOINT ?? "http://localhost:9091",
}
```

## Benefits

1. **Automatic**: No manual version updates needed
2. **Traceable**: Each build can be traced to exact commit
3. **Visible**: Version displayed on every page
4. **Auditable**: Version info available via API for monitoring
5. **Deployment-Aware**: Shows environment and branch information

## Troubleshooting

### Version shows as "dev"
- Git is not available in build environment
- Falling back to package.json version
- Solution: Ensure git is available during build

### Version shows as "dirty"
- Uncommitted changes in working directory
- Normal for local development
- Should not appear in production builds

### Version doesn't update
- Run `npm run bump-version` manually
- Check that prebuild script is running
- Verify git describe command works

## Monitoring

Use the `/api/version` endpoint to:
- Verify deployed version
- Monitor build dates
- Track deployment environments
- Debug version-related issues

Example monitoring script:
```bash
#!/bin/bash
PROD_VERSION=$(curl -s https://shorted.com.au/api/version | jq -r .version)
PREVIEW_VERSION=$(curl -s https://preview.shorted.com.au/api/version | jq -r .version)
echo "Production: $PROD_VERSION"
echo "Preview: $PREVIEW_VERSION"
```

## Related Files

- `web/package.json` - Version storage and build scripts
- `web/scripts/bump-version.sh` - Version update script
- `web/next.config.mjs` - Runtime config with version info
- `web/src/@/components/ui/site-footer.tsx` - Version display component
- `web/src/app/api/version/route.ts` - Version API endpoint

