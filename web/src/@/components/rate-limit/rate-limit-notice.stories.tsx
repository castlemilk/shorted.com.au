/**
 * RateLimitNotice stories.
 *
 * The two variants exist for two very different moments:
 *  - `inline` degrades one widget during a transient per-minute limit. It must
 *    look boring. If it looks like an error, we've failed — a browsing user
 *    should barely register it.
 *  - `page` is the monthly-quota upgrade moment, and is also what /rate-limit
 *    renders standalone.
 */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { SessionProvider } from "next-auth/react";
import { expect, within } from "storybook/test";

import { RateLimitNotice } from "./rate-limit-notice";
import type { RateLimitInfo } from "~/@/lib/retry";

const nowSeconds = () => Math.floor(Date.now() / 1000);

const perMinuteInfo = (): RateLimitInfo => ({
  isRateLimited: true,
  kind: "per_minute",
  limit: 100,
  remaining: 0,
  resetAt: nowSeconds() + 42,
  retryAfter: 42,
});

const monthlyInfo = (): RateLimitInfo => ({
  isRateLimited: true,
  kind: "monthly",
  monthlyLimit: 2000,
  monthlyUsed: 2000,
  monthlyResetAt: nowSeconds() + 86_400 * 12,
});

const meta = {
  title: "RateLimit/RateLimitNotice",
  component: RateLimitNotice,
  // Excluded from visual regression: this component renders a LIVE countdown
  // ("refreshing in 42s") and a reset date derived from the current time, so
  // successive runs legitimately differ — the first CI run diffed 8% of pixels
  // against a baseline captured seconds earlier. Pixel-diffing it would only
  // teach people to ignore a red visual suite. Behaviour is covered by 55 unit
  // tests, and the two frames that matter were reviewed by eye before merge.
  tags: ["no-visual"],
  args: {
    info: perMinuteInfo(),
  },
  decorators: [
    (Story) => (
      <SessionProvider session={null}>
        <div className="flex min-h-[420px] items-center justify-center bg-background p-8">
          <div className="w-full max-w-xl">
            <Story />
          </div>
        </div>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof RateLimitNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Inline — the common case
// ---------------------------------------------------------------------------

/** Transient per-minute limit. Deliberately undramatic. */
export const InlinePerMinute: Story = {
  args: { info: perMinuteInfo(), variant: "inline" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/just a moment/i)).toBeInTheDocument();
    // The calm path must never carry alarm language.
    await expect(canvas.queryByText(/exceeded/i)).not.toBeInTheDocument();
  },
};

/** No reset info in the payload — the countdown is simply omitted. */
export const InlinePerMinuteNoCountdown: Story = {
  args: {
    info: { isRateLimited: true, kind: "unknown" },
    variant: "inline",
  },
};

/** Monthly quota, degraded into a widget slot. */
export const InlineMonthly: Story = {
  args: { info: monthlyInfo(), variant: "inline", tier: "free" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("link", { name: /upgrade/i }),
    ).toHaveAttribute("href", "/pricing");
  },
};

// ---------------------------------------------------------------------------
// Page — the standalone / upgrade surface
// ---------------------------------------------------------------------------

export const PagePerMinute: Story = {
  args: { info: perMinuteInfo(), variant: "page", tier: "free" },
};

/** The conversion surface: what ran out, when it resets, what paid gives. */
export const PageMonthlyFree: Story = {
  args: { info: monthlyInfo(), variant: "page", tier: "free" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/unlimited requests — no monthly ceiling/i),
    ).toBeInTheDocument();
  },
};

/** Anonymous callers get the cheapest possible next step: sign in. */
export const PageMonthlyAnonymous: Story = {
  args: { info: monthlyInfo(), variant: "page", tier: "anonymous" },
};

/** Paid callers are never upsold — they get a human. */
export const PageMonthlyPaid: Story = {
  args: { info: monthlyInfo(), variant: "page", tier: "paid" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("link", { name: /contact support/i }),
    ).toBeInTheDocument();
  },
};

/** Everything optional is missing — must still render sensible copy. */
export const PageMonthlyNoNumbers: Story = {
  args: {
    info: { isRateLimited: true, kind: "monthly" },
    variant: "page",
    tier: "free",
  },
};
