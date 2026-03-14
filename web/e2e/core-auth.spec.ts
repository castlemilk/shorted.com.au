import { test, expect } from "@playwright/test";

/**
 * Core Authentication E2E Tests
 *
 * Tests the Firebase auth flow using the E2E credentials fallback
 * (NextAuth credentials provider with ALLOW_E2E_AUTH=true).
 *
 * Run: npx playwright test e2e/core-auth.spec.ts --project=chromium
 */

// E2E test credentials (matches server/auth.ts E2E_TEST_USER)
const E2E_EMAIL = process.env.E2E_TEST_EMAIL ?? "e2e-test@shorted.com.au";
const E2E_PASSWORD = process.env.E2E_TEST_PASSWORD ?? "E2ETestPassword123!";

test.setTimeout(60_000);

test.describe("Auth Flow - Sign In Page", () => {
  test("signin page renders with Google and credentials form", async ({
    page,
  }) => {
    await page.goto("/signin", { waitUntil: "domcontentloaded" });

    // Logo
    await expect(page.locator('img[alt="Shorted Logo"]')).toBeVisible({
      timeout: 15_000,
    });

    // Google button
    await expect(
      page.getByRole("button", { name: /continue with google/i }),
    ).toBeVisible();

    // Email/password form
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();

    // Submit button
    await expect(
      page
        .locator("form")
        .filter({ hasText: "Password" })
        .getByRole("button", { name: "Sign in" }),
    ).toBeVisible();

    // Sign up link
    await expect(page.getByRole("link", { name: /sign up/i })).toBeVisible();

    // Terms links
    await expect(
      page.getByRole("link", { name: /terms of service/i }),
    ).toBeVisible();
  });

  test("shows validation for empty form submission", async ({ page }) => {
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // The HTML5 required attribute prevents submission, but we can test
    // by trying to submit with only email
    await page.locator("#email").fill("test@example.com");
    // Leave password empty — HTML5 required should block submission

    const submitButton = page
      .locator("form")
      .filter({ hasText: "Password" })
      .getByRole("button", { name: "Sign in" });

    await submitButton.click();

    // Should still be on signin page (form didn't submit due to required)
    expect(page.url()).toContain("/signin");
  });

  test("shows error for invalid credentials", async ({ page }) => {
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    await page.locator("#email").fill("invalid@example.com");
    await page.locator("#password").fill("WrongPassword123!");

    const submitButton = page
      .locator("form")
      .filter({ hasText: "Password" })
      .getByRole("button", { name: "Sign in" });
    await submitButton.click();

    // Should show error message (Firebase auth will fail, then E2E fallback will fail)
    await expect(
      page.locator(".text-destructive").or(page.locator('[role="alert"]')),
    ).toBeVisible({ timeout: 15_000 });

    // Should still be on signin page
    expect(page.url()).toContain("/signin");
  });

  test("successfully logs in with E2E credentials and redirects", async ({
    page,
  }) => {
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Fill E2E credentials
    await page.locator("#email").fill(E2E_EMAIL);
    await page.locator("#password").fill(E2E_PASSWORD);

    const submitButton = page
      .locator("form")
      .filter({ hasText: "Password" })
      .getByRole("button", { name: "Sign in" });
    await submitButton.click();

    // Should redirect away from signin
    await page.waitForURL((url) => !url.pathname.includes("/signin"), {
      timeout: 15_000,
    });

    // Should be on homepage or callback URL
    const currentUrl = page.url();
    expect(currentUrl).not.toContain("/signin");
  });

  test("callbackUrl redirects to correct page after login", async ({
    page,
  }) => {
    // Go to signin with a callbackUrl
    await page.goto("/signin?callbackUrl=%2Fshorts", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle");

    await page.locator("#email").fill(E2E_EMAIL);
    await page.locator("#password").fill(E2E_PASSWORD);

    const submitButton = page
      .locator("form")
      .filter({ hasText: "Password" })
      .getByRole("button", { name: "Sign in" });
    await submitButton.click();

    // Should redirect to /shorts after login
    await page.waitForURL((url) => url.pathname.includes("/shorts"), {
      timeout: 15_000,
    });
  });

  test("navigate to signup page from signin", async ({ page }) => {
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    await page.getByRole("link", { name: /sign up/i }).click();

    await expect(page).toHaveURL(/\/signup/);
  });
});

test.describe("Auth Flow - Sign Up Page", () => {
  test("signup page renders with Google and credentials form", async ({
    page,
  }) => {
    await page.goto("/signup", { waitUntil: "domcontentloaded" });

    // Google button
    await expect(
      page.getByRole("button", { name: /continue with google/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Email/password form
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();

    // Sign in link (go back)
    await expect(
      page.getByRole("link", { name: /sign in/i }),
    ).toBeVisible();
  });
});

test.describe("Auth Flow - Session Persistence", () => {
  test("authenticated session persists across page navigations", async ({
    page,
  }) => {
    // Login first
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    await page.locator("#email").fill(E2E_EMAIL);
    await page.locator("#password").fill(E2E_PASSWORD);

    const submitButton = page
      .locator("form")
      .filter({ hasText: "Password" })
      .getByRole("button", { name: "Sign in" });
    await submitButton.click();

    await page.waitForURL((url) => !url.pathname.includes("/signin"), {
      timeout: 15_000,
    });

    // Navigate to various pages — should not be redirected to signin
    for (const path of ["/", "/shorts", "/treemap", "/blog"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      // Should not redirect to signin
      expect(page.url()).not.toContain("/signin");
    }
  });

  test("authenticated session survives page reload", async ({ page }) => {
    // Login
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    await page.locator("#email").fill(E2E_EMAIL);
    await page.locator("#password").fill(E2E_PASSWORD);

    page
      .locator("form")
      .filter({ hasText: "Password" })
      .getByRole("button", { name: "Sign in" })
      .click();

    await page.waitForURL((url) => !url.pathname.includes("/signin"), {
      timeout: 15_000,
    });

    // Reload
    await page.reload({ waitUntil: "domcontentloaded" });

    // Should still not be on signin
    expect(page.url()).not.toContain("/signin");
  });
});

test.describe("Auth Flow - Protected Routes", () => {
  test("unauthenticated user accessing /chat redirects to signin", async ({
    page,
  }) => {
    // Clear any existing session cookies
    await page.context().clearCookies();

    await page.goto("/chat", { waitUntil: "domcontentloaded" });

    // Should redirect to signin or show a sign-in prompt/premium gate
    await page.waitForTimeout(3000);
    const url = page.url();

    // Either redirected to signin, or showing a gate/login prompt on the page
    const redirectedToSignin = url.includes("/signin");
    const hasLoginPrompt = await page
      .getByText(/sign in|sign up|log in|premium/i)
      .isVisible()
      .catch(() => false);

    expect(redirectedToSignin || hasLoginPrompt).toBeTruthy();
  });
});
