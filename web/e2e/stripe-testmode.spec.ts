import { expect, test } from "@playwright/test";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
const stripeProPriceId =
  process.env.STRIPE_PRO_PRICE_ID?.trim() ??
  process.env.STRIPE_PREMIUM_PRICE_ID?.trim() ??
  "";

const missingStripeEnv: string[] = [];
if (!stripeSecretKey) {
  missingStripeEnv.push("STRIPE_SECRET_KEY");
}
if (!stripeProPriceId) {
  missingStripeEnv.push("STRIPE_PRO_PRICE_ID (or STRIPE_PREMIUM_PRICE_ID)");
}

const testEmail = process.env.E2E_TEST_EMAIL ?? "e2e-test@shorted.com.au";
const testPassword = process.env.E2E_TEST_PASSWORD ?? "E2ETestPassword123!";

test.describe("stripe test-mode checkout smoke", () => {
  test.skip(
    missingStripeEnv.length > 0,
    `missing required env vars for Stripe test-mode bench: ${missingStripeEnv.join(", ")}`,
  );

  test("authenticated user can start checkout and reach Stripe Checkout", async ({
    page,
  }) => {
    await page.goto("/signin");
    await page.waitForLoadState("networkidle");

    await page.locator("#email").fill(testEmail);
    await page.locator("#password").fill(testPassword);

    const signInButton = page
      .locator("form")
      .filter({ hasText: "Password" })
      .getByRole("button", { name: "Sign in" });
    await signInButton.click();

    const signInError = page.locator("form .text-destructive");
    if (await signInError.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const errorText = (await signInError.textContent())?.trim() || "unknown sign-in error";
      throw new Error(`E2E sign-in failed: ${errorText}`);
    }

    await expect(page).not.toHaveURL(/\/signin/, { timeout: 20_000 });

    await page.goto("/pricing");
    await page.waitForLoadState("networkidle");

    const upgradeButton = page.getByRole("button", {
      name: /upgrade to premium/i,
    });
    await expect(upgradeButton).toBeVisible({ timeout: 15_000 });

    const checkoutResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/stripe/checkout") &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    );

    await upgradeButton.click();
    const checkoutResponse = await checkoutResponsePromise;
    if (!checkoutResponse.ok()) {
      throw new Error(
        `Stripe checkout API failed with status ${checkoutResponse.status()} (${checkoutResponse.url()})`,
      );
    }

    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 45_000 });
    expect(page.url()).toContain("checkout.stripe.com");
  });
});
