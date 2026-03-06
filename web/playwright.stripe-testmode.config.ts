import { defineConfig, devices } from "@playwright/test";

const stripeTestModePort = 3320;
const stripeTestModeBaseUrl = `http://127.0.0.1:${stripeTestModePort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["stripe-testmode.spec.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["html"], ["list"]],
  use: {
    baseURL: stripeTestModeBaseUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `APP_VERSION=stripe-testmode npx next dev -p ${stripeTestModePort}`,
    url: stripeTestModeBaseUrl,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      VERCEL_ENV: "preview",
      ALLOW_E2E_AUTH: process.env.ALLOW_E2E_AUTH ?? "true",
      E2E_TEST_EMAIL: process.env.E2E_TEST_EMAIL ?? "e2e-test@shorted.com.au",
      E2E_TEST_PASSWORD:
        process.env.E2E_TEST_PASSWORD ?? "E2ETestPassword123!",
      NEXTAUTH_SECRET:
        process.env.NEXTAUTH_SECRET ?? "stripe-testbench-nextauth-secret",
      NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? stripeTestModeBaseUrl,
      SHORTS_SERVICE_ENDPOINT:
        process.env.SHORTS_SERVICE_ENDPOINT ?? "http://localhost:9091",
      AUTH_FIREBASE_PROJECT_ID:
        process.env.AUTH_FIREBASE_PROJECT_ID ?? "stripe-testbench-project",
      AUTH_FIREBASE_CLIENT_EMAIL:
        process.env.AUTH_FIREBASE_CLIENT_EMAIL ??
        "stripe-testbench@test.iam.gserviceaccount.com",
      AUTH_FIREBASE_PRIVATE_KEY:
        process.env.AUTH_FIREBASE_PRIVATE_KEY ??
        "-----BEGIN PRIVATE KEY-----\\nstripe-testbench\\n-----END PRIVATE KEY-----",
      AUTH_GOOGLE_ID:
        process.env.AUTH_GOOGLE_ID ?? "stripe-testbench.google.apps",
      AUTH_GOOGLE_SECRET:
        process.env.AUTH_GOOGLE_SECRET ?? "stripe-testbench-google-secret",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID:
        process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
        "stripe-testbench-project",
      NEXT_PUBLIC_FIREBASE_API_KEY:
        process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "stripe-testbench-api-key",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:
        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ??
        "stripe-testbench.firebaseapp.com",
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:
        process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ??
        "stripe-testbench.appspot.com",
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:
        process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "1234567890",
      NEXT_PUBLIC_FIREBASE_APP_ID:
        process.env.NEXT_PUBLIC_FIREBASE_APP_ID ??
        "1:1234567890:web:stripe-testbench",
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
      STRIPE_PRO_PRICE_ID: process.env.STRIPE_PRO_PRICE_ID ?? "",
      STRIPE_PREMIUM_PRICE_ID: process.env.STRIPE_PREMIUM_PRICE_ID ?? "",
    },
  },
  projects: [
    {
      name: "chromium-stripe-testmode",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
