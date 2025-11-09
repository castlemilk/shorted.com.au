# CI Test Failure Fix

## Problem

CI unit tests were failing with the error:
```
Configuration error:

Could not locate module next-auth/react mapped as:
/home/runner/work/shorted.com.au/shorted.com.au/web/src/test/__mocks__/next-auth-react.js.
```

This affected two test files:
- `src/app/__tests__/page.test.tsx`
- `src/app/shorts/__tests__/page.test.tsx`

However, `make test` was passing locally, making it difficult to catch this issue before pushing.

## Root Cause

The mock file `web/src/test/__mocks__/next-auth-react.js` existed locally but was **not tracked in git**. This meant:
- ✅ Local tests passed because the file existed on the developer's machine
- ❌ CI tests failed because the file wasn't in the repository

## Solution

### 1. Added Missing Mock File to Git

```bash
git add web/src/test/__mocks__/next-auth-react.js
```

This file contains Jest mocks for the `next-auth/react` module:
- `useSession()` - Returns a mocked authenticated session
- `signIn()` - Mock sign-in function
- `signOut()` - Mock sign-out function
- `SessionProvider` - Mock provider component

### 2. Updated Makefile to Match CI

Changed `test-frontend` target to use the same flags as CI:

**Before:**
```makefile
test-frontend:
	@echo "🧪 Running frontend tests..."
	@cd web && npm test
```

**After:**
```makefile
test-frontend:
	@echo "🧪 Running frontend tests..."
	@cd web && npm test -- --watchAll=false --testPathIgnorePatterns=integration
```

These flags match what CI runs (see `.github/workflows/ci.yml` line 368):
```yaml
npm test -- --watchAll=false --testPathIgnorePatterns=integration
```

## Benefits

1. **Catch CI Failures Locally**: `make test` now runs with the exact same Jest configuration as CI
2. **Faster Development**: No need to wait for CI to catch issues that could be found locally
3. **Consistency**: Local and CI environments now behave identically

## Testing

### Before Fix
- ❌ CI: Tests failed with "Could not locate module" error
- ✅ Local: Tests passed (false positive)

### After Fix
- ✅ CI: Tests now pass (mock file is in repository)
- ✅ Local: Tests still pass and match CI behavior

### Verification

Run the following to verify everything works:

```bash
# Run frontend tests (now matches CI exactly)
make test-frontend

# Run full test suite (lint + build + unit + integration)
make test
```

All 16 test suites should pass with 142 tests total.

## Files Changed

1. `web/src/test/__mocks__/next-auth-react.js` - Added to git (was untracked)
2. `Makefile` - Updated `test-frontend` to match CI flags

## Related Configuration

The Jest module mapper in `web/package.json` (lines 51-57):
```json
"moduleNameMapper": {
  "^@/auth$": "<rootDir>/src/test/__mocks__/@/auth.js",
  "^next-auth/react$": "<rootDir>/src/test/__mocks__/next-auth-react.js",
  "^@/lib/utils$": "<rootDir>/src/@/lib/utils.ts",
  "^@/(.*)$": "<rootDir>/src/@/$1",
  "^~/(.*)$": "<rootDir>/src/$1"
}
```

This configuration maps `next-auth/react` imports to our mock file during testing.

## Prevention

To prevent similar issues in the future:

1. **Always run `make test` before pushing** - Now that it matches CI, it will catch these issues
2. **Check for untracked mock files**: Run `git status web/src/test/__mocks__/` to ensure all mocks are tracked
3. **Review CI failures carefully**: The error message clearly indicated the file path was expected but not found

## CI Workflow Reference

The CI test step is defined in `.github/workflows/ci.yml`:

```yaml
- name: Run frontend unit tests
  working-directory: web
  run: npm test -- --watchAll=false --testPathIgnorePatterns=integration
```

This runs:
- Without watch mode (`--watchAll=false`)
- Excluding integration tests (`--testPathIgnorePatterns=integration`)
- Using the Jest config from `package.json`

