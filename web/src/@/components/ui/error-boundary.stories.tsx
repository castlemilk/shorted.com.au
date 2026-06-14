/**
 * ErrorBoundary stories — UI chrome component.
 *
 * Tests the two error paths the boundary handles:
 *  1. Generic Error  → fallback card with "Something went wrong" + "Try again"
 *  2. Rate-limit error (duck-typed ConnectErrorLike with code=8) → RateLimitError UI
 *
 * React error boundaries log to console.error in development (React 18
 * behavior) — this is expected and does NOT fail the vitest browser runner.
 *
 * Reset pattern: ErrorBoundary resets via resetErrorBoundary() which calls
 * setState({ hasError: false, error: null }). We drive the reset by clicking
 * "Try again". To verify the boundary actually recovered (not just clicked),
 * the throwing child uses a module-level counter that throws only on the
 * first mount attempt. After reset, the counter is non-zero so the child
 * renders successfully.
 *
 * Rate-limit duck-type: isRateLimitError in ~/@/lib/retry checks:
 *   - typeof error === "object" && error !== null
 *   - "code" in error && typeof error.code === "number"
 *   - "message" in error
 *   - "metadata" in error
 *   - error.code === 8 (Code.ResourceExhausted)
 * We construct a plain object that satisfies all five checks.
 */
import React from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { ErrorBoundary } from "./error-boundary";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A child that throws an Error on its first render only.
 * Uses a closure counter so each story instance starts fresh at 0.
 * After resetErrorBoundary() clears state, React re-mounts the child and
 * the counter is already >0, so it renders successfully.
 */
function makeThrowOnce(label: string) {
  let renderCount = 0;
  function ThrowOnce() {
    if (renderCount === 0) {
      renderCount += 1;
      throw new globalThis.Error("Test error from ThrowOnce");
    }
    return <div>{label}</div>;
  }
  ThrowOnce.displayName = "ThrowOnce";
  return ThrowOnce;
}

/**
 * Constructs a duck-typed ConnectError-like object that satisfies
 * isRateLimitError() in ~/@/lib/retry:
 *   - typeof === "object", not null
 *   - has "code" (number), "message", "metadata" properties
 *   - code === 8 (ResourceExhausted)
 */
function makeRateLimitError() {
  return {
    code: 8,
    message: "resource exhausted",
    metadata: {
      get: (key: string): string | null => {
        const headers: Record<string, string> = {
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 30),
          "Retry-After": "30",
        };
        return headers[key] ?? null;
      },
    },
  };
}

/**
 * A child that always throws the given error object.
 * Used to test rate-limit path (error is a ConnectErrorLike, not an Error
 * subclass, so we use a wrapper that throws it as a value — React error
 * boundaries catch thrown values of any type).
 * Must return ReactNode to satisfy JSX; it always throws before returning.
 */
function ThrowRateLimit(): React.ReactNode {
  const err = makeRateLimitError();
  throw err;
}

/**
 * Wrapper that toggles a key to force the ErrorBoundary + child to remount,
 * simulating the reset flow in a controlled story environment.
 * Not used for Default — that story uses the natural resetErrorBoundary() path.
 */

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "UI/ErrorBoundary",
  component: ErrorBoundary,
  // ErrorBoundary.children is required — provide a default so all stories
  // satisfy the type. Individual stories use `render` to override completely.
  args: {
    children: <div>default child</div>,
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-[300px] items-center justify-center p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/**
 * Default: child throws a plain Error → fallback card with
 * "Something went wrong" + "Try again" button.
 *
 * Play: click "Try again" → boundary resets → ThrowOnce child renders
 * successfully with "Recovered!" text. This verifies resetErrorBoundary()
 * actually clears the error state and the child renders on the second attempt.
 */
export const Default: Story = {
  render: () => {
    // Each render call of this story creates a fresh ThrowOnce instance.
    // We use a React component wrapper so the closure is created once per
    // story mount (not per React render pass).
    const ThrowOnce = makeThrowOnce("Recovered!");

    return (
      <ErrorBoundary>
        <ThrowOnce />
      </ErrorBoundary>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Error fallback is shown immediately (child threw on first render).
    await waitFor(() => {
      expect(canvas.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    // "Try again" button resets the boundary.
    const tryAgainButton = canvas.getByRole("button", { name: /try again/i });
    await userEvent.click(tryAgainButton);

    // After reset, ThrowOnce's counter is 1 → renders "Recovered!" text.
    await waitFor(() => {
      expect(canvas.getByText("Recovered!")).toBeInTheDocument();
    });

    // Error fallback must be gone.
    expect(canvas.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  },
};

/**
 * RateLimited: child throws a ConnectErrorLike with code=8 → RateLimitError UI.
 *
 * The RateLimitError component shows "Rate Limit Exceeded" (or similar) with
 * a countdown timer. We assert the rate-limit heading is visible.
 *
 * Note: ThrowRateLimit always throws, so there is no reset interaction here —
 * the rate-limit UI itself has a retry button but clicking it just resets the
 * boundary back to the throwing child, which immediately throws again. That
 * is correct product behavior (the server still rate-limits) and we do not
 * test that loop here.
 */
export const RateLimited: Story = {
  render: () => (
    <ErrorBoundary>
      <ThrowRateLimit />
    </ErrorBoundary>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // RateLimitError component renders "Rate Limit Exceeded" or "Monthly Limit"
    await waitFor(() => {
      expect(canvas.getByText(/rate limit exceeded/i)).toBeInTheDocument();
    });

    // Error boundary's generic "Something went wrong" fallback must NOT appear.
    expect(canvas.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  },
};

/**
 * WithCustomFallback: demonstrates the optional `fallback` prop override.
 * When a custom fallback is provided and child throws, the custom fallback
 * is shown instead of the default card.
 */
export const WithCustomFallback: Story = {
  render: () => {
    const ThrowOnce = makeThrowOnce("Should not appear");
    return (
      <ErrorBoundary fallback={<div>Custom fallback UI</div>}>
        <ThrowOnce />
      </ErrorBoundary>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText("Custom fallback UI")).toBeInTheDocument();
    });
    expect(canvas.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  },
};
