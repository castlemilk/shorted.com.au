/**
 * Whether a subscription entitles its customer to paid access, decided from the
 * status and the failure time the API returns.
 *
 * Mirrors the Go rule in services/pkg/subscription (PastDueGrace, PastDueInGrace)
 * and ResolveEntitlement in services/shorts/internal/services/shorts/entitlement.go.
 * The API is the authority for its own gates. This copy exists because the web reads
 * the status to build its UI (the banner, the premium and token checks) and must
 * agree with the API on the same inputs. Change both together.
 *
 * - active and trialing: entitled.
 * - past_due: entitled for PAST_DUE_GRACE_MS after the first failed charge
 *   (pastDueSince), while Stripe retries the card. The period end is not used: Stripe
 *   moves it forward at every renewal it fails. No failure time means no grace.
 * - unpaid, canceled, incomplete and anything else: not entitled.
 */

/** How long a past_due subscription keeps access after its first failed charge. */
export const PAST_DUE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export function isEntitledSubscription(input: {
  status: string;
  pastDueSince: Date | null;
  now?: Date;
}): boolean {
  if (input.status === "active" || input.status === "trialing") return true;
  if (input.status !== "past_due") return false;
  if (!input.pastDueSince) return false;
  const now = (input.now ?? new Date()).getTime();
  return now < input.pastDueSince.getTime() + PAST_DUE_GRACE_MS;
}
