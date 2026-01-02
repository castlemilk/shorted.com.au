# Test Fixes for SSR Homepage

## Problem

After converting the homepage back to Server-Side Rendering (SSR), the tests were failing because they were written for a Client Component but the page is now an async Server Component.

## Errors

```
Error: Failed to fetch
    at Object.<anonymous> (/Users/benebsworth/projects/shorted/web/src/app/__tests__/page.test.tsx:155:44)
```

The test was trying to render the async Server Component directly without awaiting it, causing unhandled promise rejections.

## Solution

Updated `web/src/app/__tests__/page.test.tsx` to properly test async Server Components:

### 1. Added Auth Mock

```typescript
// Mock auth
jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

const { auth } = require("~/server/auth");
const mockAuth = auth as jest.MockedFunction<typeof auth>;
```

### 2. Updated Test Pattern

**Before (Client Component):**

```typescript
it("renders the home page", async () => {
  mockGetTopShortsData.mockResolvedValue(mockData);
  render(<Home />);

  await waitFor(() => {
    expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
  });
});
```

**After (Server Component):**

```typescript
it("renders the home page", async () => {
  mockGetTopShortsData.mockResolvedValue(mockData);

  const component = await Home(); // Await the async component
  render(component);

  expect(screen.getByTestId("top-shorts")).toBeInTheDocument(); // No waitFor needed
});
```

### 3. Fixed Error Handling Test

**Before:**

```typescript
it("handles data fetch error gracefully", async () => {
  mockGetTopShortsData.mockRejectedValue(new Error("Failed to fetch"));

  render(<Home />); // This caused unhandled rejection

  await waitFor(() => {
    expect(screen.getByText("Top Shorts: 0 items")).toBeInTheDocument();
  });
});
```

**After:**

```typescript
it("throws error when data fetch fails (Next.js will handle)", async () => {
  mockGetTopShortsData.mockRejectedValue(new Error("Failed to fetch"));
  mockGetIndustryTreeMap.mockResolvedValue({ industries: [], stocks: [] });

  // Server Components should throw errors - Next.js will catch them
  await expect(Home()).rejects.toThrow("Failed to fetch");
});
```

### 4. Added Auth Tests

```typescript
it("shows login prompt banner when user is not authenticated", async () => {
  mockGetTopShortsData.mockResolvedValue(mockData);
  mockAuth.mockResolvedValue(null); // No session

  const component = await Home();
  render(component);

  expect(screen.getByTestId("login-prompt-banner")).toBeInTheDocument();
});

it("hides login prompt banner when user is authenticated", async () => {
  mockGetTopShortsData.mockResolvedValue(mockData);
  mockAuth.mockResolvedValue({
    user: { id: "123", email: "test@example.com" },
  });

  const component = await Home();
  render(component);

  expect(screen.queryByTestId("login-prompt-banner")).not.toBeInTheDocument();
});
```

## Key Differences: Client vs Server Component Testing

| Aspect             | Client Component                 | Server Component                            |
| ------------------ | -------------------------------- | ------------------------------------------- |
| **Rendering**      | `render(<Component />)`          | `render(await Component())`                 |
| **Data fetching**  | Happens after mount in useEffect | Happens during render (async)               |
| **Error handling** | Try/catch in useEffect           | Errors thrown, caught by error boundaries   |
| **Waiting**        | Use `waitFor()` for async state  | No waiting needed, data ready before render |
| **Mocking**        | Mock API calls                   | Mock server actions and auth                |

## Test Results

All tests now pass:

```bash
✅ All tests, linting, and build validation completed successfully!
   🔍 Linting: TypeScript + Go
   🏗️  Build: Frontend (type checking)
   🧪 Unit Tests: Frontend + Backend
   🔗 Integration Tests: Backend
```

## Files Modified

- ✅ `web/src/app/__tests__/page.test.tsx` - Updated to test async Server Component

## Best Practices for Testing Server Components

1. **Always await the component:**

   ```typescript
   const component = await MyServerComponent();
   render(component);
   ```

2. **No waitFor needed for initial data:**

   ```typescript
   // ❌ Don't do this
   await waitFor(() => expect(screen.getByText("Data")).toBeInTheDocument());

   // ✅ Do this
   expect(screen.getByText("Data")).toBeInTheDocument();
   ```

3. **Test error boundaries, not error states:**

   ```typescript
   // Server Components throw errors
   await expect(MyServerComponent()).rejects.toThrow("Error message");
   ```

4. **Mock server functions, not client APIs:**

   ```typescript
   // ✅ Mock server actions
   jest.mock("~/app/actions/getData");

   // ✅ Mock auth
   jest.mock("~/server/auth");

   // ❌ Don't mock fetch (happens server-side)
   ```

## Conclusion

The tests are now properly structured for Server Components, ensuring they correctly test:

- Data fetching on the server
- Conditional rendering based on auth state
- Error handling (thrown errors vs caught errors)
- Component structure and layout

This aligns with Next.js 14+ App Router patterns and React Server Components best practices.
