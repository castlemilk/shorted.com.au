import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { stripe } from "~/lib/stripe";
import { auth } from "~/server/auth";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();

    if (!session?.user?.email) {
      return NextResponse.json(
        { error: "You must be signed in to subscribe" },
        { status: 401 }
      );
    }

    const { priceId } = (await request.json()) as { priceId?: string };

    if (!priceId) {
      return NextResponse.json(
        { error: "Price ID is required" },
        { status: 400 }
      );
    }

    // Check for existing Stripe customer
    const existingCustomers = await stripe.customers.list({
      email: session.user.email,
      limit: 1,
    });

    let customerId: string | undefined;
    const firstCustomer = existingCustomers.data[0];
    if (firstCustomer) {
      customerId = firstCustomer.id;
    }

    // Determine the base URL for redirects
    const baseUrl = process.env.NEXTAUTH_URL ?? "https://shorted.com.au";

    // Create Stripe checkout session
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer: customerId,
      customer_email: customerId ? undefined : session.user.email,
      client_reference_id: session.user.id,
      metadata: {
        userId: session.user.id,
        userEmail: session.user.email,
      },
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/docs/api?canceled=true`,
      subscription_data: {
        metadata: {
          userId: session.user.id,
          userEmail: session.user.email,
        },
      },
    });

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    console.error("Stripe checkout error:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
