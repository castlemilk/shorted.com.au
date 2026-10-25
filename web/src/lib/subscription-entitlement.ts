/**
 * Whether a subscription entitles its customer to paid access, decided from the
 * status and period end the API returns.
 *
 * Mirrors ResolveEntitlement in services/shorts/internal/services/shorts/
 * entitlement.go, which is the authority for the API's own gates. This copy exists
 * because the web reads the status to build its UI (the banner, the premium and
 * token checks) and must agree with the API on the same inputs. Change both
 * together, and keep the cases in subscription-entitlement.test.ts in step with
 * entitlement_test.go.
 *
 * - active and trialing: entitled.
 * - past_due: entitled for PAST_DUE_GRACE_MS after the period end, while Stripe
 *   retries the card. Without a period end the grace cannot be bounded, so it
 *   grants nothing.
 * - unpaid, canceled, incomplete and anything else: not entitled. Stripe has
 *   stopped retrying (unpaid) or the subscription has ended.
 */

/** Days past current_period_end that a past_due subscription keeps access. */
export const PAST_DUE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export function isEntitledSubscription(input: {
  status: string;
  currentPeriodEnd: Date | null;
  now?: Date;
}): boolean {
  if (input.status === "active" || input.status === "trialing") return true;
  if (input.status !== "past_due") return false;
  if (!input.currentPeriodEnd) return false;
  const now = (input.now ?? new Date()).getTime();
  return now < input.currentPeriodEnd.getTime() + PAST_DUE_GRACE_MS;
}
