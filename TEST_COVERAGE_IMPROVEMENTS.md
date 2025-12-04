# Test Coverage Improvements

## Summary

Added comprehensive tests to catch issues that were previously missed by the test suite:

1. **Component Export/Import Mismatches** - Catches "Element type is invalid" errors
2. **Database Column Errors** - Catches SQL "column does not exist" errors  
3. **Type Safety** - Validates component imports match usage patterns

## Tests Added

### Frontend Tests

#### `web/src/@/components/ui/__tests__/component-exports.test.ts`

**Purpose**: Verifies that components export the correct names and can be imported as expected by `page.tsx`.

**What it catches**:
- Export name mismatches (e.g., `companyInfo` vs `CompanyInfo`)
- Missing default exports
- Missing named exports (like `CompanyInfoPlaceholder`)
- Import/export inconsistencies

**Example failure it would catch**:
```typescript
// If companyInfo.tsx exports:
export const companyInfo = ... // lowercase

// But page.tsx imports:
import CompanyInfo from ... // uppercase

// This test would fail, catching the mismatch before runtime
```

#### `web/src/app/actions/__tests__/getStockDetails.test.ts`

**Purpose**: Tests the `getStockDetails` action function with various scenarios.

**What it catches**:
- Type mismatches in API responses
- Missing null/undefined handling
- Error handling issues

### Backend Tests

#### `services/shorts/internal/store/shorts/postgres_getstockdetails_test.go`

**Purpose**: Validates that SQL queries in `GetStockDetails` match the actual database schema.

**What it catches**:
- SQL column name mismatches (e.g., `description` column that doesn't exist)
- Missing columns in SELECT statements
- Incorrect COALESCE/default value syntax
- Schema drift between code and database

**Key Tests**:

1. **`TestGetStockDetailsSQLQuery`**: 
   - Executes the exact SQL query from `GetStockDetails`
   - Fails if any column doesn't exist
   - Validates query structure matches implementation

2. **`TestGetStockDetailsColumnNames`**:
   - Queries `information_schema.columns` to get actual table schema
   - Validates all required columns exist
   - Warns about unused columns (like `description`)

**Example failure it would catch**:
```go
// If postgres.go has:
SELECT description FROM "company-metadata"  // column doesn't exist

// This test would fail with:
// "column 'description' does not exist"
```

## Issues Fixed

### 1. Component Export Mismatch
- **Issue**: `CompanyInfo` component was exported as `companyInfo` (lowercase) but imported as `CompanyInfo` (uppercase)
- **Fix**: Updated export to match import
- **Test**: `component-exports.test.ts` now catches this

### 2. SQL Column Error
- **Issue**: SQL query referenced `"gcsUrl"` (invalid identifier) instead of `''` (empty string)
- **Fix**: Changed `COALESCE(logo_gcs_url, "gcsUrl")` to `COALESCE(logo_gcs_url, '')`
- **Test**: `postgres_getstockdetails_test.go` now validates SQL queries

## Running the Tests

### Frontend Tests
```bash
# Run all frontend tests
make test-frontend

# Run specific test files
cd web && npm test -- --testPathPattern="component-exports|getStockDetails"
```

### Backend Tests
```bash
# Run all backend tests
make test-backend

# Run SQL validation tests (requires DATABASE_URL)
cd services && go test -v ./internal/store/shorts -run TestGetStockDetails
```

### Full Test Suite
```bash
# Runs lint + build + unit + integration tests
make test
```

## Test Requirements

### Frontend Tests
- No special requirements - run with `npm test`

### Backend SQL Tests
- Requires `DATABASE_URL` environment variable set
- Tests will skip if database is not available (using `t.Skip()`)
- Can use local PostgreSQL or test database

## Integration with CI/CD

These tests are automatically run in `make test`, which is called by:
- Pre-commit hooks (if configured)
- Pre-push hooks (if configured)  
- CI pipeline (GitHub Actions)

## Future Improvements

1. **Add integration tests** that test the full flow:
   - Backend `GetStockDetails` → Frontend `getStockDetails` → Component rendering
   
2. **Add E2E tests** that verify:
   - Stock detail page loads correctly
   - Components render without errors
   - No "Element type is invalid" errors in browser console

3. **Add schema validation**:
   - Compare protobuf schema with database schema
   - Validate all fields are mapped correctly

4. **Add type checking tests**:
   - Verify TypeScript types match Go protobuf types
   - Validate JSONB fields match expected structure




