# Sign-In Page Redirect - Manual Test Plan

## Bug Description
**Issue**: Authenticated users visiting `/signin` page were stuck viewing the login form instead of being redirected to their intended destination.

## Fix Applied
- Added `useSession()` check in SignInForm component
- Automatically redirect authenticated users to `callbackUrl` or `/`
- Show loading spinner during authentication check

---

## ✅ Manual Test Cases (Do These in Production/Staging)

### Test 1: Authenticated User Manually Navigates to Signin
**Steps**:
1. Log in to the application
2. Verify you're logged in (profile picture visible in header)
3. Manually type `/signin` in the URL bar and press Enter
4. **EXPECTED**: You should be immediately redirected to `/` (home page)
5. **FAIL IF**: You see the login form

---

### Test 2: Authenticated User Clicks Link to Signin with Callback
**Steps**:
1. Log in to the application  
2. Visit `/signin?callbackUrl=%2Fdashboards` in the URL bar
3. **EXPECTED**: You should be immediately redirected to `/dashboards`
4. **FAIL IF**: You see the login form

---

### Test 3: Unauthenticated User Flow (Should Still Work)
**Steps**:
1. Log out completely
2. Navigate to `/signin`
3. **EXPECTED**: You see the login form ("Welcome to Shorted", "Continue with Google")
4. **FAIL IF**: You get redirected or see a blank page

---

### Test 4: Flash Test - No Brief Login Form Appearance
**Steps**:
1. Log in to the application
2. Open browser DevTools → Network tab → Throttle to "Slow 3G"
3. Navigate to `/signin?callbackUrl=%2Fdashboards`
4. **EXPECTED**: You see either:
   - A loading spinner briefly, then redirect
   - OR immediate redirect (no flash)
5. **FAIL IF**: You see the full login form for more than ~200ms

---

### Test 5: After Login Callback Works
**Steps**:
1. Log out completely
2. Try to access `/dashboards` (protected route)
3. You'll be redirected to `/signin?callbackUrl=%2Fdashboards`
4. Log in using Google or email/password
5. **EXPECTED**: After successful login, you're redirected to `/dashboards`
6. **FAIL IF**: You're stuck on signin page or redirected to home instead

---

### Test 6: Session Expiry During Signin Page Visit
**Steps**:
1. Log in to the application
2. Navigate to `/signin` → Should redirect away
3. Open DevTools → Application → Cookies
4. Delete the `next-auth.session-token` cookie
5. The page should now show the signin form (session expired)
6. **EXPECTED**: Form appears and you can sign in again
7. **FAIL IF**: Page is stuck in a redirect loop or crashes

---

### Test 7: Multiple Tabs - Session Sync
**Steps**:
1. Open Tab A: Log in and verify authentication works
2. Open Tab B: Navigate to `/signin`
3. **EXPECTED IN TAB B**: Redirected away (session recognized)
4. **IN TAB B**: Log out
5. **EXPECTED IN TAB A**: If you refresh or navigate to `/signin`, you should see the login form
6. **FAIL IF**: Sessions are not synced across tabs

---

## 🔍 What To Look For

### Success Indicators ✅
- No "flash" of login form for authenticated users
- Smooth, instant redirect (or with brief loading spinner)
- Callback URLs are respected
- Unauthenticated users can still access signin normally

### Failure Indicators ❌
- Brief glimpse of "Continue with Google" button before redirect
- Getting stuck on signin page when logged in
- Redirect loops
- Blank page or errors
- Callback URL ignored

---

## 🧰 Browser Testing Matrix

Test in at least 2 browsers:
- [ ] Chrome/Chromium
- [ ] Safari (important for Apple users)
- [ ] Firefox
- [ ] Mobile Safari (iOS)
- [ ] Mobile Chrome (Android)

---

## 📊 Test Results

| Test Case | Browser | Pass/Fail | Notes |
|-----------|---------|-----------|-------|
| Test 1: Manual nav to signin | Chrome | | |
| Test 2: Callback URL redirect | Chrome | | |
| Test 3: Unauthenticated flow | Chrome | | |
| Test 4: Flash test | Chrome | | |
| Test 5: After login callback | Chrome | | |
| Test 6: Session expiry | Chrome | | |
| Test 7: Multi-tab sync | Chrome | | |
| Test 1: Manual nav to signin | Safari | | |
| Test 2: Callback URL redirect | Safari | | |
| Test 4: Flash test | Mobile Safari | | |

---

## 🚨 If Tests Fail

### Potential Issues and Solutions:

1. **Flash of login form still appears**:
   - Timing issue with `useSession()` hook
   - Consider using `getServerSideProps` to check auth before rendering
   - Or add `suppressHydrationWarning` with server-side session check

2. **Redirect not happening**:
   - Check browser console for errors
   - Verify `useRouter()` is working
   - Check if middleware is blocking the redirect

3. **Callback URL not working**:
   - Verify URL encoding is correct (`%2F` = `/`)
   - Check `useSearchParams()` is returning the right value
   - Inspect NextAuth configuration for allowed callback URLs

4. **Session not detected**:
   - Check if `auth()` in `layout.tsx` is passing session correctly
   - Verify `NextAuthProvider` is receiving the session prop
   - Check browser cookies for `next-auth.session-token`

---

## 🎯 Acceptance Criteria

For this fix to be considered successful:

1. ✅ All 7 test cases pass in at least Chrome and Safari
2. ✅ No visual flash of login form for authenticated users
3. ✅ Unauthenticated users can still access signin normally  
4. ✅ Callback URLs work correctly after login
5. ✅ No console errors or warnings
6. ✅ Performance: Redirect happens within 100ms (on normal connection)

