# API Token Roles Documentation

## Overview

The API uses a role-based access control system with two primary roles:
- **`api-user`**: Standard authenticated user (can access all public and general private endpoints)
- **`admin`**: Administrator (can access admin-only endpoints)

## Role Assignment

### Automatic Role Assignment

When a user calls `MintToken`, roles are automatically assigned:

```
┌─────────────────────────────────────────────────────────────┐
│ All Authenticated Users                                     │
│ ↓                                                            │
│ Automatically get: ["api-user"]                             │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Admin Emails                                                │
│ ben.ebsworth@gmail.com                                      │
│ ben@shorted.com.au                                          │
│ e2e-test@shorted.com.au                                     │
│ ↓                                                            │
│ Get: ["api-user", "admin"]                                  │
└─────────────────────────────────────────────────────────────┘
```

### Role Capabilities

| Role | Can Access | Examples |
|------|------------|----------|
| **`api-user`** | • All public endpoints<br>• Private endpoints without role requirement<br>• General API access | GetTopShorts, GetStock, GetStockDetails, GetStockData, SearchStocks |
| **`admin`** | • Everything `api-user` can access<br>• Admin-only endpoints | GetSyncStatus, SyncKeyMetrics |

## Endpoint Visibility & Roles

### Public Endpoints (No Auth Required)
```protobuf
option (shortedapi.options.v1.visibility) = VISIBILITY_PUBLIC;
```
**Examples**: GetTopShorts, GetStock, GetStockDetails, GetStockData, GetIndustryTreeMap, SearchStocks

**Access**: Anyone (authenticated or not)

### Private Endpoints (Auth Required)
```protobuf
option (shortedapi.options.v1.visibility) = VISIBILITY_PRIVATE;
```
**Examples**: MintToken

**Access**: Any authenticated user (api-user role or higher)

### Admin Endpoints (Admin Role Required)
```protobuf
option (shortedapi.options.v1.visibility) = VISIBILITY_PRIVATE;
option (shortedapi.options.v1.required_role) = "admin";
```
**Examples**: GetSyncStatus, SyncKeyMetrics

**Access**: Only users with "admin" role

## Usage Examples

### 1. Regular User Gets API Token

```bash
# User authenticates with Firebase and gets ID token
FIREBASE_TOKEN="<firebase-id-token>"

# Call MintToken to get API token
curl -X POST "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/MintToken" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FIREBASE_TOKEN" \
  -d '{}'

# Response:
{
  "token": "eyJhbGci..."  // JWT with roles: ["api-user"]
}
```

**Token Claims**:
```json
{
  "user_id": "user-123",
  "email": "user@example.com",
  "roles": ["api-user"],  // ✅ Can access public + general private endpoints
  "exp": 1769141257,
  "iat": 1766549257,
  "iss": "shorted-api"
}
```

### 2. Admin User Gets API Token

```bash
# Admin user (ben.ebsworth@gmail.com) authenticates with Firebase
FIREBASE_TOKEN="<firebase-id-token-for-admin>"

# Call MintToken
curl -X POST "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/MintToken" \
  -H "Authorization: Bearer $FIREBASE_TOKEN" \
  -d '{}'

# Response:
{
  "token": "eyJhbGci..."  // JWT with roles: ["api-user", "admin"]
}
```

**Token Claims**:
```json
{
  "user_id": "admin-uid",
  "email": "ben.ebsworth@gmail.com",
  "roles": ["api-user", "admin"],  // ✅ Can access everything including admin endpoints
  "exp": 1769141257,
  "iat": 1766549257,
  "iss": "shorted-api"
}
```

### 3. Using API Token

```bash
API_TOKEN="eyJhbGci..."

# Access public endpoint (works with or without token)
curl "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetTopShorts" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"period": "1m", "limit": 10}'

# Access private endpoint (requires api-user role)
curl "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStockData" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"productCode": "CBA", "period": "1y"}'

# Access admin endpoint (requires admin role)
curl "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/SyncKeyMetrics" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"stockCodes": ["CVN"]}'  // ✅ Only works if token has "admin" role
```

## Admin Email List

Currently hardcoded admin emails (automatically get admin role):
- `ben.ebsworth@gmail.com`
- `ben@shorted.com.au`
- `e2e-test@shorted.com.au`

**Location**: 
- `services/shorts/internal/services/shorts/service.go` (line ~320)
- `services/shorts/internal/services/shorts/middleware_connect.go` (line ~120)

## Token Lifetime

**Default**: 30 days (720 hours)
```go
s.tokenService.MintToken(userID, email, roles, 30*24*time.Hour)
```

## Authentication Flow

```
┌────────────────────┐
│ User Signs In      │
│ (Firebase Auth)    │
└────────┬───────────┘
         │ Gets Firebase ID Token
         ↓
┌────────────────────┐
│ Call MintToken     │
│ with Firebase token│
└────────┬───────────┘
         │ Backend validates Firebase token
         │ Determines roles (api-user + admin if applicable)
         ↓
┌────────────────────┐
│ Get API Token      │
│ (JWT with roles)   │
└────────┬───────────┘
         │ Use for API calls
         ↓
┌────────────────────┐
│ Call API Endpoints │
│ with Bearer token  │
└────────────────────┘
```

## Error Messages

| Error | Meaning | Solution |
|-------|---------|----------|
| `authentication required for this endpoint` | No auth header | Add `Authorization: Bearer <token>` |
| `user not authenticated` | Invalid/expired token | Get new token via MintToken |
| `permission_denied: admin role required` | Token doesn't have admin role | Use admin user email or add admin to Firebase custom claims |
| `permission_denied: api-user role required` | Token has no roles | This shouldn't happen - contact support |

## Testing

### Test as Regular User
```bash
# Mint token via UI or API (gets api-user role)
TOKEN="<minted-token>"

# Should work
curl ... /GetTopShorts -H "Authorization: Bearer $TOKEN"
curl ... /GetStockDetails -H "Authorization: Bearer $TOKEN"

# Should fail (403 permission_denied)
curl ... /SyncKeyMetrics -H "Authorization: Bearer $TOKEN"
```

### Test as Admin
```bash
# Login with admin email (ben.ebsworth@gmail.com)
# Mint token (gets api-user + admin roles)
ADMIN_TOKEN="<minted-admin-token>"

# Should work (everything)
curl ... /GetTopShorts -H "Authorization: Bearer $ADMIN_TOKEN"
curl ... /SyncKeyMetrics -H "Authorization: Bearer $ADMIN_TOKEN"
curl ... /GetSyncStatus -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Local Development

For local testing, use internal secret:
```bash
# Regular user
curl ... \
  -H "X-Internal-Secret: dev-internal-secret" \
  -H "X-User-Id: test-user" \
  -H "X-User-Email: user@example.com"
  # Gets: ["api-user"]

# Admin user  
curl ... \
  -H "X-Internal-Secret: dev-internal-secret" \
  -H "X-User-Id: admin" \
  -H "X-User-Email: ben.ebsworth@gmail.com"
  # Gets: ["api-user", "admin"]

# Override roles explicitly
curl ... \
  -H "X-Internal-Secret: dev-internal-secret" \
  -H "X-User-Roles: admin,api-user"
  # Gets: ["api-user", "admin"]
```

## Implementation Details

### MintToken Logic
```go
// 1. Extract user from Firebase auth context
userClaims := UserFromContext(ctx)

// 2. Assign api-user to everyone
roles := []string{"api-user"}

// 3. Check if email is in admin list
if email in adminEmails {
    roles = append(roles, "admin")
}

// 4. Mint JWT with roles
token := MintToken(userID, email, roles, 30days)
```

### Middleware Logic
```go
// 1. Check visibility (public/private)
// 2. Check required_role (if specified)
// 3. Validate token (Firebase, API token, or Service Account)
// 4. Extract user claims and roles
// 5. Verify user has required role
// 6. Allow or deny request
```

## Future Enhancements

### Add More Roles
```go
roles := []string{"api-user"}  // Base role

// Power user (higher rate limits)
if isPowerUser(email) {
    roles = append(roles, "power-user")
}

// Premium subscriber
if hasPremiumSubscription(userID) {
    roles = append(roles, "premium")
}

// Admin
if isAdmin(email) {
    roles = append(roles, "admin")
}
```

### Role-Based Rate Limiting
```go
switch {
case hasRole("admin"):
    rateLimit = unlimited
case hasRole("premium"):
    rateLimit = 10000/hour
case hasRole("api-user"):
    rateLimit = 1000/hour
default:
    rateLimit = 100/hour
}
```

## Security Notes

1. **Admin emails are hardcoded** - For production, consider:
   - Database table for admin users
   - Firebase custom claims
   - Environment variable list

2. **Token lifetime is 30 days** - Consider:
   - Shorter lifetime for security
   - Refresh token mechanism
   - Token revocation

3. **Internal secret is hardcoded** - For production:
   - Store in environment variable
   - Use different secrets per environment
   - Rotate regularly

## Related Files

- `services/shorts/internal/services/shorts/service.go` - MintToken implementation
- `services/shorts/internal/services/shorts/middleware_connect.go` - Role checking
- `services/shorts/internal/services/shorts/tokens.go` - JWT creation/validation
- `proto/shortedapi/shorts/v1alpha1/shorts.proto` - Visibility and role options
- `proto/shortedapi/options/v1/options.proto` - Custom proto options

