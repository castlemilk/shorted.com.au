import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { stripe } from "~/lib/stripe";
import { auth } from "~/server/auth";
import { getSubscriptionStatus } from "~/app/actions/subscription";
import { rateLimit } from "~/@/lib/rate-limit";

/**
 * GET /billing/portal opens the Stripe billing portal for the signed-in caller's own
 * customer, then redirects to it. The failed-payment email links here rather than to a
 * Stripe session URL, which expires. Each click makes a fresh session.
 *
 * The customer is the caller's own mirror row (keyed by user id), the same one
 * /api/stripe/portal uses. It is never chosen by email. A caller with no customer, or
 * whose subscription cannot be read, is sent to /pricing.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://shorted.com.au";

  const session = await auth();
  if (!session?.user?.id) {
    // The middleware sends signed-out visitors to sign in first. This is a fallback.
    const signIn = new URL("/signin", baseUrl);
    signIn.searchParams.set("callbackUrl", "/billing/portal");
    return NextResponse.redirect(signIn, 303);
  }

  const rateLimitResult = await rateLimit(request, {
    anonymousLimit: 2,
    authenticatedLimit: 12,
    windowSeconds: 60,
  });
  if (!rateLimitResult.success) {
    return rateLimitResult.response;
  }

  const mirror = await getSubscriptionStatus();
  if (!mirror.lookupFailed && mirror.stripeCustomerId) {
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: mirror.stripeCustomerId,
        return_url: `${baseUrl}/pricing`,
      });
      return NextResponse.redirect(portal.url, 303);
    } catch (error) {
      console.error("Billing portal redirect failed:", error);
    }
  }

  return NextResponse.redirect(new URL("/pricing?billing=unavailable", baseUrl), 303);
}
